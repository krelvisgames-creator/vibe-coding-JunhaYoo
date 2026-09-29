"use strict";

/* ==========================================================
 * 1. 상수
 * ========================================================== */

// Groq 무료 플랜 모델. 무료 한도(2026-09-29 문서 기준): 분당 요청 30, 하루 요청 1,000, 분당 토큰 8,000.
// 엄격한 JSON 스키마(strict)를 지원하는 모델 중 큰 쪽이다. 바꿀 때는 https://console.groq.com/docs/models 에서 ID를 확인한다.
const MODEL = "openai/gpt-oss-120b";
const API_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_TOKENS = 2048; // 한 명분 조건별 판단 + 인용 + 짧은 추론에 충분한 길이
// 추론 수준. "low"에서는 "평일 저녁 가능"을 "월·수·금 저녁 가능" 조건에 대해 애매로 판단하는 등
// 포함 관계를 놓쳐서 "medium"으로 올렸다(2026-09-29). 대신 한 명당 토큰이 늘어 요청 간격도 늘렸다.
const REASONING_EFFORT = "medium";
// 요청 사이 최소 간격(밀리초). 추론 medium 기준 한 명당 약 2,000~2,500토큰이라 분당 8,000토큰 한도에 맞춰
// 1분에 3명 정도로 늦춘다. 한도에 닿지 않게 미리 늦추는 것이지 재시도가 아니다.
const AI_PACE_MS = 20000;
// 요청 하나에 넣을 지원자 수. 서로 비교하지 않고 독립적으로 판단하도록 한 명씩 보낸다.
const AI_BATCH_SIZE = 1;

// localStorage 키. 선발 조건과 심사 결과만 저장한다(②, ③에서 사용).
const STORAGE_KEYS = {
  criteria: "screening.criteria.v1",
  results: "screening.results.v1",
  apiKeySlot: "screening.apiKeySlot.v1", // 키 자체가 아니라 저장 위치 이름
};

// 문항 역할은 "심사"와 "제외" 두 가지만 고를 수 있다(선택지가 많으면 헷갈려서 줄였다).
// - 심사: AI에 보낸다. 단, 학번 문항(제목에 "학번")은 학번 전체 대신 입학년도 2자리만 보낸다.
// - 제외: 쓰지 않는다.
// 이름 문항은 자동으로 찾아 화면 표시에만 쓰고, 역할은 "제외"로 고정해 절대 보내지 않는다.
const ROLE = {
  REVIEW: "review",
  EXCLUDE: "exclude",
};
const ROLE_LABEL = {
  [ROLE.REVIEW]: "심사",
  [ROLE.EXCLUDE]: "제외",
};
// AI에 보내는(심사에 쓰는) 역할
const SENT_ROLES = [ROLE.REVIEW];

// 기본 "제외"로 둘 문항: 연락처·이메일·타임스탬프·생년월일·주소
const EXCLUDE_PATTERN = /타임\s*스탬프|timestamp|연락처|전화|휴대폰|핸드폰|phone|이메일|e-?mail|메일|카톡|카카오|주소|생년월일/i;
// 학번 문항 추정(심사일 때 입학년도만 보냄)
const STUDENT_ID_PATTERN = /학번|student\s*id/i;
// 이름 문항 추정
const NAME_PATTERN = /이름|성명|^\s*name\s*$/i;

// 조건 종류
const CRIT_TYPE = {
  REQUIRED: "required",     // 필수: 모두 충족해야 한다
  DISQUALIFY: "disqualify", // 결격: 하나라도 해당하면 안 된다
  PREFERRED: "preferred",   // 우대: threshold개 이상 충족하면 통과
};
const CRIT_TEXT_MAX = 200;

// 예시 조건: 예시 데이터와 짝을 이룬다. "수정 후 확인할 것" 2번의 기대 결과가 이 조건 기준이다.
const SAMPLE_CRITERIA = {
  items: [
    { type: CRIT_TYPE.REQUIRED, text: "매주 수요일 저녁 정기 모임에 참석할 수 있다" },
    { type: CRIT_TYPE.REQUIRED, text: "1년 이상 활동할 수 있다" },
    { type: CRIT_TYPE.DISQUALIFY, text: "이번 학기에 졸업할 예정이다" },
    { type: CRIT_TYPE.DISQUALIFY, text: "현재 휴학 중이다" },
    { type: CRIT_TYPE.PREFERRED, text: "개발 프로젝트를 해 본 경험이 있다" },
  ],
  threshold: 1,
};

// 예시 데이터: 모두 가상 인물이다. 연락처·학번·이메일도 가짜 값이다.
const SAMPLE_CSV = `타임스탬프,이름,학번,성별,나이,연락처,이메일,현재 학년과 재학 상태를 적어 주세요,매주 수요일 저녁 정기 모임에 참석할 수 있나요?,활동 가능한 기간은 어느 정도인가요?,지원 동기를 적어 주세요,관련 경험이 있다면 적어 주세요
2026/03/02 10:12:03,김하늘,20250001,여,21,010-0000-0001,sky@example.com,2학년 재학 중입니다,네 매주 참석할 수 있습니다,1년 이상 활동할 수 있어요,직접 만든 서비스를 사람들이 쓰는 경험을 해 보고 싶습니다,웹 개발 동아리에서 학과 행사 페이지를 만들었습니다
2026/03/02 11:40:51,박지호,20220002,남,24,010-0000-0002,jiho@example.com,4학년이고 이번 학기 졸업 예정입니다,네 가능합니다,이번 학기까지 가능합니다,졸업 전에 팀 프로젝트를 한 번 더 해 보고 싶어요,캡스톤 디자인에서 백엔드를 맡았습니다
2026/03/02 13:05:17,오세진,20240003,남,22,010-0000-0003,sejin@example.com,현재 휴학 중입니다,네 매주 가능합니다,1년 가능합니다,휴학 기간에 꾸준히 무언가를 만들어 보고 싶습니다,개인 블로그를 운영하고 있습니다
2026/03/03 09:21:44,이서연,20240004,여,22,010-0000-0004,seoyeon@example.com,3학년 재학 중,격주로만 참석할 수 있을 것 같아요,1년 정도 가능합니다,디자인과 개발을 같이 해 보고 싶어서 지원했습니다,UI 디자인 공모전에 참가한 적이 있습니다
2026/03/03 15:48:09,정민재,20260005,남,20,010-0000-0005,minjae@example.com,1학년 재학 중입니다,아마 가능할 것 같습니다,,프로그래밍을 처음 배우는데 같이 배울 사람들을 찾고 있어요,
2026/03/04 12:30:26,최유나,20250006,여,21,010-0000-0006,yuna@example.com,2학년 재학,네 참석할 수 있습니다,1년 이상 가능합니다,작년에 만든 앱을 더 다듬어 출시해 보고 싶습니다,교내 해커톤 수상 경험이 있고 앱을 출시해 본 적이 있습니다
2026/03/04 18:02:55,한도윤,20260007,남,20,010-0000-0007,doyoon@example.com,1학년 재학 중입니다,네 매주 가능해요,1년 활동할 수 있습니다,개발자가 꿈이라 실제 프로젝트를 경험하고 싶습니다,아직 없습니다`;

/* ==========================================================
 * 2. 상태
 * ========================================================== */

// CSV 원본은 메모리에만 둔다. 지원자 개인정보를 localStorage에 남기지 않기 위해서다.
const state = {
  source: null,     // { label, encoding }
  columns: [],      // [{ index, title, role, filled, example }]
  applicants: [],   // [{ id: "A1", row: 1, answers: [문자열, ...] }]
  // 선발 조건은 localStorage에 저장한다. CSV를 바꿔도 유지된다.
  criteria: {
    items: [],      // [{ id, type, text }]
    threshold: 1,   // 우대 조건 중 몇 개 이상 충족하면 통과인지
  },
  // 심사 판단. 지원자 행 내용의 해시로 묶어 저장한다(이름·응답은 저장하지 않음).
  // { [rowKey]: { judgments: { [critId]: { status, text } }, override, savedAt } }
  results: {},
  ui: { screen: "setup", filter: "all", selectedId: null },
  ai: { running: false, stop: false, done: 0, total: 0, req: 0, reqTotal: 0, waitSec: 0 },
  aiPaceMs: AI_PACE_MS, // 요청 간격. 분당 한도를 알게 되면 늘어난다.
};

/* ==========================================================
 * 3. CSV (+ 엑셀, 구글폼 zip)
 * ========================================================== */

// 받는 파일 형식
const TEXT_EXT = ["csv", "tsv", "txt"];
const SHEET_EXT = ["xlsx", "xlsm", "xls", "ods"];
const ZIP_EXT = ["zip"];

// 엑셀 읽기 도구(SheetJS). 엑셀 파일을 넣을 때만 불러온다. CSV만 쓰는 사람은 받지 않아도 된다.
const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";

function extOf(name) {
  const m = /\.([^.]+)$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

// 파일 앞부분으로 실제 형식을 판단한다. 확장자가 틀려도 읽을 수 있게.
function sniff(bytes) {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "zip";
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return "xls";
  return "text";
}

// 파일 하나를 읽어 표(행 배열)로 바꾼 뒤 applyParsed로 넘긴다.
async function readFile(file) {
  if (!file) return;
  showLoadStatus("info", `${file.name} 읽는 중…`);

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length) throw new UserError("빈 파일입니다.");

    const ext = extOf(file.name);
    const kind = sniff(bytes);
    const source = { label: file.name };

    // xlsx·xlsm·ods도 속은 zip이다. 확장자로 엑셀인지 구글폼 zip인지 가른다.
    if (kind === "xls" || (kind === "zip" && !ZIP_EXT.includes(ext))) {
      const { rows, info } = await readSheet(bytes);
      applyParsed(rows, source, { info });
      return;
    }
    if (kind === "zip") {
      const entry = await readCsvFromZip(bytes);
      const { text, encodingNote } = decodeText(entry.bytes);
      const parsed = parseCsvText(text);
      const info = [`압축 파일 안의 ${entry.name}을(를) 읽었습니다.`];
      if (encodingNote) info.push(encodingNote);
      applyParsed(parsed.rows, source, { info, parseErrors: parsed.errors });
      return;
    }
    if (!TEXT_EXT.includes(ext) && ext !== "") {
      throw new UserError(`읽을 수 없는 형식입니다(.${ext}). CSV, 엑셀(xlsx·xls·xlsm·ods), 구글폼 zip을 넣어 주세요.`);
    }
    const { text, encodingNote } = decodeText(bytes);
    const parsed = parseCsvText(text);
    applyParsed(parsed.rows, source, { info: encodingNote ? [encodingNote] : [], parseErrors: parsed.errors });
  } catch (err) {
    showLoadStatus("error", err instanceof UserError ? err.message : `파일을 읽지 못했습니다: ${err.message}`);
    console.error(err);
  }
}

// 사용자에게 그대로 보여 줄 오류
class UserError extends Error {}

// UTF-8로 읽어 보고, 맞지 않으면 EUC-KR(엑셀에서 "CSV"로 저장한 파일)로 읽는다.
function decodeText(bytes) {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encodingNote: "" };
  } catch {
    return { text: new TextDecoder("euc-kr").decode(bytes), encodingNote: "엑셀 형식(EUC-KR)으로 읽었습니다." };
  }
}

function parseCsvText(text) {
  if (typeof Papa === "undefined") {
    throw new UserError("CSV 읽기 도구(PapaParse)를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.");
  }
  // 구분자(쉼표·탭)는 PapaParse가 자동으로 찾는다.
  const result = Papa.parse(text.replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
  return { rows: result.data, errors: result.errors.length };
}

function readCsvText(text, label) {
  try {
    const parsed = parseCsvText(text);
    applyParsed(parsed.rows, { label }, { parseErrors: parsed.errors });
  } catch (err) {
    showLoadStatus("error", err.message);
  }
}

// ---- 엑셀 ----

let sheetJsPromise = null;
function loadSheetJs() {
  if (typeof XLSX !== "undefined") return Promise.resolve();
  if (!sheetJsPromise) {
    sheetJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SHEETJS_URL;
      s.onload = () => resolve();
      s.onerror = () => {
        sheetJsPromise = null; // 다음에 다시 시도할 수 있게
        reject(new UserError("엑셀 읽기 도구(SheetJS)를 불러오지 못했습니다. 인터넷 연결을 확인하거나, 엑셀에서 'CSV UTF-8'로 저장해 넣어 주세요."));
      };
      document.head.append(s);
    });
  }
  return sheetJsPromise;
}

// 첫 번째로 내용이 있는 시트를 읽는다. 날짜·숫자는 엑셀 화면에 보이는 글자 그대로 가져온다.
async function readSheet(bytes) {
  await loadSheetJs();
  let wb;
  try {
    wb = XLSX.read(bytes, { type: "array" });
  } catch (err) {
    throw new UserError(`엑셀 파일을 읽지 못했습니다. 암호가 걸려 있거나 손상된 파일일 수 있습니다. (${err.message})`);
  }
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "", blankrows: false });
    if (rows.length) {
      const info = wb.SheetNames.length > 1
        ? [`시트 ${wb.SheetNames.length}개 중 '${name}' 시트를 읽었습니다.`]
        : [];
      return { rows, info };
    }
  }
  throw new UserError("엑셀 파일에 내용이 있는 시트가 없습니다.");
}

// ---- 구글폼 zip ----
// 구글폼의 "응답 다운로드(.csv)"는 CSV 하나가 든 zip을 내려준다.
// 라이브러리 없이 브라우저 내장 압축 해제(DecompressionStream)로 첫 번째 CSV를 꺼낸다.
async function readCsvFromZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 끝에서부터 중앙 디렉터리 끝 표식(EOCD)을 찾는다.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new UserError("zip 파일 구조를 읽지 못했습니다. 압축을 푼 뒤 안의 CSV를 넣어 주세요.");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const names = new TextDecoder("utf-8");

  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (!/\.csv$/i.test(name) || name.startsWith("__MACOSX/")) continue;

    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(start, start + compSize);

    if (method === 0) return { name, bytes: data };
    if (method === 8) {
      if (typeof DecompressionStream === "undefined") {
        throw new UserError("이 브라우저는 zip을 바로 풀 수 없습니다. 압축을 푼 뒤 안의 CSV를 넣어 주세요.");
      }
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return { name, bytes: new Uint8Array(await new Response(stream).arrayBuffer()) };
    }
    throw new UserError("지원하지 않는 압축 방식입니다. 압축을 푼 뒤 안의 CSV를 넣어 주세요.");
  }
  throw new UserError("zip 안에 CSV 파일이 없습니다.");
}

// ---- 공통 ----

// 표를 검사하고 상태에 넣는다. rows는 [[칸, 칸, ...], ...], 첫 행은 문항 제목.
function applyParsed(rows, source, { info = [], parseErrors = 0 } = {}) {
  rows = rows.filter((r) => r.some((cell) => String(cell ?? "").trim() !== ""));
  if (!rows.length) {
    showLoadStatus("error", "빈 파일입니다. 첫 줄에 문항 제목이 있는 파일을 넣어 주세요.");
    return;
  }

  const headers = buildHeaders(rows[0]);
  const body = rows.slice(1);
  if (!body.length) {
    showLoadStatus("error", "문항 제목만 있고 응답이 없습니다.");
    return;
  }

  let longRows = 0;
  const applicants = body.map((cells, i) => {
    if (cells.slice(headers.length).some((c) => String(c ?? "").trim() !== "")) longRows++;
    const answers = headers.map((_, c) => String(cells[c] ?? "").trim());
    return { id: `A${i + 1}`, row: i + 1, answers, rowKey: rowKeyOf(answers) };
  });

  state.source = source;
  state.applicants = applicants;
  state.columns = headers.map((title, index) => {
    const values = applicants.map((a) => a.answers[index]);
    return {
      index,
      title,
      role: ROLE.REVIEW,
      filled: values.filter((v) => v !== "").length,
      example: values.find((v) => v !== "") ?? "",
    };
  });
  guessRoles(state.columns);

  const warnings = [];
  if (longRows) warnings.push(`${longRows}개 행에 문항 수보다 칸이 많아 넘치는 칸은 버렸습니다.`);
  if (parseErrors) warnings.push(`형식이 어긋난 곳이 ${parseErrors}군데 있습니다. 결과를 한 번 확인해 주세요.`);

  const restored = applicants.filter((a) => state.results[a.rowKey]).length;
  if (restored) info.push(`이전에 저장된 심사 판단 ${restored}명분을 복원했습니다.`);
  state.ui.selectedId = null;

  const msg = [`${source.label}: 지원자 ${applicants.length}명, 문항 ${headers.length}개를 불러왔습니다.`, ...info, ...warnings].join(" ");
  showLoadStatus(warnings.length ? "warn" : "ok", msg);
  renderColumns();
}

// 문항 제목을 정리한다. BOM 제거, 빈 제목 채우기, 같은 제목에 번호 붙이기.
function buildHeaders(firstRow) {
  const seen = new Map();
  return firstRow.map((raw, i) => {
    let title = String(raw ?? "").replace(/^﻿/, "").trim();
    if (!title) title = `(제목 없는 문항 ${i + 1})`;
    const n = (seen.get(title) ?? 0) + 1;
    seen.set(title, n);
    return n > 1 ? `${title} (${n})` : title;
  });
}

// 문항 제목으로 역할을 추정한다. 연락처 등은 제외, 첫 이름 문항은 이름(제외 고정), 나머지(성별·나이·학번 포함)는 심사.
function guessRoles(columns) {
  let nameFound = false;
  for (const col of columns) {
    col.isName = false;
    col.isStudentId = STUDENT_ID_PATTERN.test(col.title);
    if (EXCLUDE_PATTERN.test(col.title)) {
      col.role = ROLE.EXCLUDE;
    } else if (!nameFound && !col.isStudentId && NAME_PATTERN.test(col.title)) {
      col.role = ROLE.EXCLUDE;
      col.isName = true;
      nameFound = true;
    } else {
      col.role = ROLE.REVIEW;
    }
  }
}

// 학번에서 입학년도 2자리를 뽑는다. 못 찾으면 ""(보내지 않음).
// 20250001 → "25", 2025 → "25", 2250001·250001 같은 7자리 이하 → 앞 2자리, "25학번" → "25"
function entryYearOf(raw) {
  const text = String(raw ?? "").trim();
  const labeled = /(\d{2})\s*학번/.exec(text);
  if (labeled) return labeled[1];
  const digits = text.replace(/\D/g, "");
  if ((digits.length >= 8 || digits.length === 4) && /^(19|20)/.test(digits)) return digits.slice(2, 4);
  if (digits.length >= 2 && digits.length <= 7) return digits.slice(0, 2);
  return "";
}

// AI에 보낼 한 칸의 값. 학번 문항은 입학년도만 보낸다.
function sentValueOf(col, raw) {
  if (col.isStudentId) {
    const year = entryYearOf(raw);
    return year ? `${year}학번` : "(알 수 없음)";
  }
  return raw || "(무응답)";
}

// 이름 문항은 바꿀 수 없다(항상 제외 = AI로 보내지 않음).
function setColumnRole(index, role) {
  const col = state.columns[index];
  if (col.isName || !Object.values(ROLE).includes(role)) return;
  col.role = role;
  renderColumns();
}

/* ==========================================================
 * 4. 조건
 * ========================================================== */

let critSeq = 0;
function newCritId() {
  critSeq += 1;
  return `k${Date.now().toString(36)}${critSeq}`;
}

// 심사에 실제로 쓰이는 조건: 내용이 빈 조건은 뺀다.
function activeCriteria() {
  return state.criteria.items.filter((c) => c.text.trim() !== "");
}

function preferredCount() {
  return activeCriteria().filter((c) => c.type === CRIT_TYPE.PREFERRED).length;
}

// threshold를 1 ~ 우대 조건 수 범위의 정수로 맞춘다. 범위를 벗어나 고쳤으면 true.
// 0은 "우대 조건 없음"과 같은 뜻이라 받지 않는다. 우대 조건이 없을 때는 값을 건드리지 않는다
// (verdictOf는 우대 조건이 없으면 threshold를 보지 않는다).
function clampThreshold() {
  const max = preferredCount();
  const raw = Number.parseInt(state.criteria.threshold, 10);
  if (max === 0) {
    if (Number.isNaN(raw)) state.criteria.threshold = 1;
    return false;
  }
  const fixed = Number.isNaN(raw) ? 1 : Math.min(Math.max(raw, 1), max);
  const changed = fixed !== state.criteria.threshold;
  state.criteria.threshold = fixed;
  return changed;
}

// 저장된 조건을 불러온다. 형식이 이상하면 버리고 빈 상태로 시작한다.
function loadCriteria() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEYS.criteria);
  } catch {
    showCritStatus("warn", "이 브라우저에서는 조건을 저장할 수 없습니다(비공개 모드일 수 있음). 새로고침하면 조건이 사라집니다.");
    return;
  }
  if (!raw) return;

  try {
    const saved = JSON.parse(raw);
    const validTypes = Object.values(CRIT_TYPE);
    const items = Array.isArray(saved.items) ? saved.items : [];
    state.criteria.items = items
      .filter((c) => c && validTypes.includes(c.type) && typeof c.text === "string")
      // id를 유지해야 저장된 심사 판단이 같은 조건에 계속 붙는다.
      .map((c) => ({
        id: typeof c.id === "string" && /^k[a-z0-9]+$/.test(c.id) ? c.id : newCritId(),
        type: c.type,
        text: c.text.slice(0, CRIT_TEXT_MAX),
      }));
    state.criteria.threshold = Number.isInteger(saved.threshold) ? saved.threshold : 1;
    clampThreshold();
  } catch {
    showCritStatus("error", "저장된 조건을 읽지 못해 빈 상태로 시작합니다.");
  }
}

function saveCriteria() {
  const data = {
    version: 1,
    items: state.criteria.items.map(({ id, type, text }) => ({ id, type, text })),
    threshold: state.criteria.threshold,
  };
  try {
    localStorage.setItem(STORAGE_KEYS.criteria, JSON.stringify(data));
    return true;
  } catch {
    showCritStatus("error", "조건을 저장하지 못했습니다. 브라우저 저장 공간이 가득 찼거나 비공개 모드일 수 있습니다.");
    return false;
  }
}

function addCriterion(type, text = "") {
  const item = { id: newCritId(), type, text };
  state.criteria.items.push(item);
  saveCriteria();
  renderCriteria(item.id);
}

function updateCriterionText(id, text) {
  const item = state.criteria.items.find((c) => c.id === id);
  if (!item) return;
  item.text = text.slice(0, CRIT_TEXT_MAX);
  const clamped = item.type === CRIT_TYPE.PREFERRED && clampThreshold();
  saveCriteria();
  if (clamped) $("#threshold").value = state.criteria.threshold;
  renderCriteriaSummary(clamped);
}

function removeCriterion(id) {
  const item = state.criteria.items.find((c) => c.id === id);
  state.criteria.items = state.criteria.items.filter((c) => c.id !== id);
  const clamped = item && item.type === CRIT_TYPE.PREFERRED && clampThreshold();
  saveCriteria();
  renderCriteria(null, clamped);
}

function setThreshold(value) {
  state.criteria.threshold = Number.parseInt(value, 10);
  const clamped = clampThreshold();
  saveCriteria();
  $("#threshold").value = state.criteria.threshold;
  renderCriteriaSummary(clamped);
}

// 조건이 하나도 없을 때만 예시 조건을 채운다. 저장된 조건은 덮어쓰지 않는다.
function fillSampleCriteriaIfEmpty() {
  if (activeCriteria().length > 0) return false;
  state.criteria.items = SAMPLE_CRITERIA.items.map((c) => ({ id: newCritId(), ...c }));
  state.criteria.threshold = SAMPLE_CRITERIA.threshold;
  saveCriteria();
  renderCriteria();
  return true;
}

/* ==========================================================
 * 5. 판정(verdictOf)
 * ========================================================== */

// 조건별 판단 값. LLM도 사람도 이 세 가지만 준다.
const STATUS = { MET: "met", UNMET: "unmet", UNCLEAR: "unclear" };

const VERDICT = { PASS: "pass", HOLD: "hold", FAIL: "fail" };
const VERDICT_LABEL = { pass: "통과", hold: "보류", fail: "탈락" };

// 판정 규칙. 위에서부터 먼저 걸리는 규칙이 적용된다.
// 화면의 "판정 규칙" 설명은 이 배열에서 만든다. verdictOf()를 바꾸면 여기 설명도 함께 바꾼다.
const RULES = [
  { verdict: VERDICT.FAIL, text: () => "결격 조건에 하나라도 해당하거나, 필수 조건을 하나라도 충족하지 못하면 탈락" },
  { verdict: VERDICT.HOLD, text: () => "필수·결격 조건 중 애매한 것이 하나라도 있으면 보류" },
  { verdict: VERDICT.PASS, text: (t) => `우대 조건이 없거나, 우대 조건을 ${t}개 이상 충족하면 통과` },
  { verdict: VERDICT.HOLD, text: () => "그 외는 보류" },
];

// checks: [{ type, text, status }], threshold: 우대 기준 개수
// 반환: { verdict, rule(RULES 인덱스), reason(한 문장) }
function verdictOf(checks, threshold) {
  const of = (type, status) => checks.filter((c) => c.type === type && c.status === status);
  const quote = (list) => list.map((c) => `'${c.text}'`).join(", ");

  const disqualified = of(CRIT_TYPE.DISQUALIFY, STATUS.MET);
  const missing = of(CRIT_TYPE.REQUIRED, STATUS.UNMET);
  if (disqualified.length || missing.length) {
    const parts = [];
    if (disqualified.length) parts.push(`결격 ${quote(disqualified)}에 해당`);
    if (missing.length) parts.push(`필수 ${quote(missing)} 미충족`);
    return { verdict: VERDICT.FAIL, rule: 0, reason: parts.join(", ") };
  }

  const unclear = checks.filter((c) => c.type !== CRIT_TYPE.PREFERRED && c.status === STATUS.UNCLEAR);
  if (unclear.length) {
    return { verdict: VERDICT.HOLD, rule: 1, reason: `${quote(unclear)} 판단이 애매함` };
  }

  const preferred = checks.filter((c) => c.type === CRIT_TYPE.PREFERRED);
  const metCount = preferred.filter((c) => c.status === STATUS.MET).length;
  if (preferred.length === 0) {
    return { verdict: VERDICT.PASS, rule: 2, reason: "필수 조건을 모두 충족하고 결격 사유가 없음(우대 조건 없음)" };
  }
  if (metCount >= threshold) {
    return { verdict: VERDICT.PASS, rule: 2, reason: `필수 충족, 결격 없음, 우대 ${metCount}/${preferred.length}개 충족(기준 ${threshold}개)` };
  }
  return { verdict: VERDICT.HOLD, rule: 3, reason: `필수 충족, 결격 없음, 우대 ${metCount}/${preferred.length}개로 기준 ${threshold}개에 못 미침` };
}

// 지원자 한 명의 조건별 판단 목록. 판단이 없거나, 판단한 뒤 조건 문장이 바뀌었으면 unclear로 본다.
function checksFor(applicant) {
  const saved = state.results[applicant.rowKey];
  return activeCriteria().map((crit) => {
    const j = saved && saved.judgments[crit.id];
    const text = crit.text.trim();
    const fresh = j && j.text === text;
    return {
      id: crit.id,
      type: crit.type,
      text,
      status: fresh ? j.status : STATUS.UNCLEAR,
      judged: Boolean(fresh),
      stale: Boolean(j) && !fresh,
      by: fresh ? j.by : null,
      quote: fresh && j.quote ? j.quote : "",
      quoteFound: fresh ? j.quoteFound ?? null : null,
      confirmedAi: Boolean(fresh && j.confirmedAi),
    };
  });
}

// 최종 판정: 임원이 바꾼 판정(override)이 규칙 판정보다 우선한다.
function evaluate(applicant) {
  const checks = checksFor(applicant);
  const rule = verdictOf(checks, state.criteria.threshold);
  const saved = state.results[applicant.rowKey];
  const override = saved && saved.override ? saved.override : null;
  return {
    checks,
    rule,
    override,
    final: override || rule.verdict,
    pending: checks.filter((c) => !c.judged).length,
    aiUnchecked: checks.filter((c) => c.by === "ai").length, // AI가 채우고 아직 임원이 확인하지 않은 판단
  };
}

// ---- 심사 판단 저장 ----

// 지원자 행 내용으로 만든 해시(cyrb53). 같은 파일을 다시 넣거나 응답이 추가돼도 같은 사람은 같은 키가 된다.
function rowKeyOf(answers) {
  const str = answers.join("\u0001");
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return "r" + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function loadResults() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.results);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && saved.version === 1 && saved.rows && typeof saved.rows === "object") {
      state.results = saved.rows;
    }
  } catch {
    // 저장이 막혔거나 깨졌으면 빈 결과로 시작한다. 조건 쪽에서 이미 안내한다.
  }
}

function saveResults() {
  try {
    localStorage.setItem(STORAGE_KEYS.results, JSON.stringify({ version: 1, rows: state.results }));
    return true;
  } catch {
    showResultStatus("error", "심사 판단을 저장하지 못했습니다. 브라우저 저장 공간이 가득 찼거나 비공개 모드일 수 있습니다.");
    return false;
  }
}

function resultEntry(applicant) {
  if (!state.results[applicant.rowKey]) {
    state.results[applicant.rowKey] = { judgments: {}, override: null };
  }
  return state.results[applicant.rowKey];
}

// 같은 버튼을 다시 누르면 판단을 지운다(미판단으로 되돌림).
// AI가 채운 판단의 버튼을 누르면 임원이 확인한 판단으로 바뀐다.
function setJudgment(applicant, critId, status) {
  const crit = activeCriteria().find((c) => c.id === critId);
  if (!crit) return;
  const entry = resultEntry(applicant);
  const current = entry.judgments[critId];
  const sameAsNow = current && current.status === status && current.text === crit.text.trim();
  if (sameAsNow && current.by === "human") {
    delete entry.judgments[critId];
  } else if (sameAsNow) {
    // AI 판단을 임원이 확인: 인용은 남기고 판단 주체만 바꾼다
    entry.judgments[critId] = { ...current, by: "human", confirmedAi: true };
  } else {
    entry.judgments[critId] = { status, text: crit.text.trim(), by: "human" };
  }
  entry.savedAt = Date.now();
  saveResults();
  renderResults();
}

function setOverride(applicant, verdict) {
  const entry = resultEntry(applicant);
  entry.override = Object.values(VERDICT).includes(verdict) ? verdict : null;
  entry.savedAt = Date.now();
  saveResults();
  renderResults();
}

/* ==========================================================
 * 6. API 호출 (Groq Chat Completions, 무료 플랜)
 * ========================================================== */

// 공정성 지시. CLAUDE.md "핵심 설계 원칙 3"의 항목을 빼지 않는다.
const SYSTEM_PROMPT = `너는 동아리 서류 심사를 돕는 보조자다. 지원자들의 응답과 지원자별 선발 조건 목록을 받아, 조건마다 그 지원자가 조건에 해당하는지 판단한다.

규칙:
1. 응답에 없는 내용을 추측하지 말 것. 근거가 응답에 없으면 unclear로 둔다.
2. 애매하면 unclear로 둘 것. 단, 응답이 조건을 논리적으로 포함하면 추측이 아니라 근거가 있는 것이므로 met으로 판단한다. 예: 조건 "월·수·금 저녁에 참석할 수 있다"에 응답 "평일 저녁 모두 가능"은 met, 응답 "화·목 저녁만 가능"은 unmet, 응답 "요일에 따라 다름"은 unclear.
3. 맞춤법, 이름, 학과, 말투, 글의 길이나 성의처럼 조건과 무관한 요소는 판단에서 배제할 것.
4. 성별·나이·입학년도 문항의 응답은 조건 문장이 그 항목(성별, 나이, 학년·입학년도)을 직접 다룰 때만 참고하고, 그 밖의 조건 판단에는 절대 쓰지 말 것. 다른 응답의 글에서 성별이나 나이를 짐작하지도 말 것.
5. 근거(quote)는 응답 원문을 한 글자도 바꾸지 말고 그대로 복사할 것. 근거가 없으면 빈 문자열로 둔다.
6. 지원자가 여러 명 들어오면 한 명씩 서로 독립적으로 판단할 것. 다른 지원자의 응답과 비교하거나 근거로 쓰지 말 것.
7. status의 뜻: met = 지원자가 조건 문장에 해당한다(결격 조건이면 결격 사유에 해당한다는 뜻), unmet = 해당하지 않는다, unclear = 근거가 부족하거나 애매하다.
8. 합격·불합격 같은 최종 판정은 하지 말 것. 조건별 판단만 한다.
9. 받은 모든 지원자에 대해, 그 지원자의 조건 id마다 정확히 하나씩 답할 것. 조건 id는 지원자마다 따로 매겨져 있다.`;

const AI_ERROR_TEXT = {
  nokey: "Groq API 키가 없습니다. 'AI 설정'에서 키를 넣어 주세요. 키 없이도 직접 판단은 할 수 있습니다.",
  key: "API 키가 잘못됐거나 이 키로 Groq API를 쓸 수 없습니다. 'AI 설정'에서 키를 확인해 주세요.",
  quota: "요청 한도를 넘었습니다.",
  network: "Groq API에 연결할 수 없습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.",
  server: "Groq 서버가 일시적으로 바쁘거나 점검 중입니다. 잠시 뒤 다시 눌러 주세요.",
  blocked: "AI가 이 지원자에 대한 답을 거절했습니다. 이 지원자는 직접 판단해 주세요.",
  parse: "AI 응답을 해석하지 못했습니다. 다시 누르거나 직접 판단해 주세요.",
  bad: "요청이 거절됐습니다.",
};

class ApiError extends Error {
  constructor(kind, detail = "", info = null) {
    super(AI_ERROR_TEXT[kind] + (detail ? ` (${detail})` : ""));
    this.kind = kind;
    this.info = info; // 429일 때 { retrySec, spendCap }
  }
}

// 429 안내 문구. retry-after(초)가 있으면 그 시간을 알려 준다.
function quotaMessage(info) {
  const parts = ["Groq 무료 플랜의 요청 한도(분당 요청·토큰 수 또는 하루 요청 수)를 넘었습니다."];
  if (info && info.retrySec) parts.push(`약 ${info.retrySec}초 뒤에 다시 눌러 주세요.`);
  else parts.push("잠시 기다린 뒤 다시 눌러 주세요. 한도는 Groq Console의 Limits 화면에서 확인할 수 있습니다.");
  return parts.join(" ");
}

function getApiKey() {
  try {
    return localStorage.getItem(STORAGE_KEYS.apiKeySlot) || "";
  } catch {
    return "";
  }
}

function saveApiKey(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEYS.apiKeySlot, value);
    else localStorage.removeItem(STORAGE_KEYS.apiKeySlot);
    return true;
  } catch {
    return false;
  }
}

// AI에 보낼 지원자 한 명분 내용을 만든다. 심사 문항의 응답만 넣는다(이름·연락처는 넣지 않고, 학번은 입학년도만).
// targets: 판단을 맡길 조건들(checksFor 결과). 조건 id는 지원자마다 c1, c2…로 바꿔 보낸다.
function buildPayload(applicant, targets) {
  const idMap = {};
  const criteria = targets.map((c, i) => {
    const sentId = `c${i + 1}`;
    idMap[sentId] = c.id;
    return { id: sentId, 종류: CRIT_LABEL[c.type], 조건: c.text };
  });
  const payload = {
    지원자: applicant.id,
    응답: state.columns
      .filter((c) => SENT_ROLES.includes(c.role))
      .map((c) => ({
        문항: c.isStudentId ? `${c.title} (입학년도)` : c.title,
        응답: sentValueOf(c, applicant.answers[c.index]),
      })),
    조건: criteria,
  };
  return { payload, idMap };
}

// 여러 지원자를 한 요청으로 묶었을 때의 응답 형식
function responseSchema(applicantIds, criterionIds) {
  return {
    type: "object",
    properties: {
      applicants: {
        type: "array",
        items: {
          type: "object",
          properties: {
            applicant_id: { type: "string", enum: applicantIds },
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  criterion_id: { type: "string", enum: criterionIds },
                  status: { type: "string", enum: [STATUS.MET, STATUS.UNMET, STATUS.UNCLEAR] },
                  quote: { type: "string" },
                },
                required: ["criterion_id", "status", "quote"],
                additionalProperties: false,
              },
            },
          },
          required: ["applicant_id", "results"],
          additionalProperties: false,
        },
      },
    },
    required: ["applicants"],
    additionalProperties: false,
  };
}

// Groq를 한 번 부른다. 실패하면 ApiError를 던진다. 재시도하지 않는다.
// items: buildPayload()의 payload 배열. 반환: { byApplicant: { A1: [결과…] }, usage }
async function callGroq(key, items) {
  const applicantIds = items.map((p) => p.지원자);
  const criterionIds = [...new Set(items.flatMap((p) => p.조건.map((c) => c.id)))];
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ 지원자들: items }, null, 2) },
    ],
    max_completion_tokens: MAX_TOKENS * items.length,
    reasoning_effort: REASONING_EFFORT,
    include_reasoning: false,
    response_format: {
      type: "json_schema",
      json_schema: { name: "criteria_judgments", strict: true, schema: responseSchema(applicantIds, criterionIds) },
    },
  };

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network");
  }

  if (!res.ok) {
    let err = {};
    try {
      err = (await res.json()).error || {};
    } catch {
      // 본문이 JSON이 아니면 상태 코드로만 판단한다
    }
    const msg = String(err.message || "");
    if (res.status === 401 || res.status === 403 || err.code === "invalid_api_key") throw new ApiError("key");
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      const info = { retrySec: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : null };
      const e = new ApiError("quota", "", info);
      e.message = quotaMessage(info);
      throw e;
    }
    if (res.status >= 500 || res.status === 498) throw new ApiError("server", [res.status, msg].filter(Boolean).join(" "));
    throw new ApiError("bad", `${res.status} ${msg}`.trim());
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError("parse");
  }
  const choice = (data.choices || [])[0] || {};
  const message = choice.message || {};
  if (message.refusal || choice.finish_reason === "content_filter") throw new ApiError("blocked");
  const text = typeof message.content === "string" ? message.content : "";
  if (!text) throw new ApiError("parse", choice.finish_reason);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError("parse", choice.finish_reason === "length" ? "답이 너무 길어 잘림" : choice.finish_reason);
  }
  if (!parsed || !Array.isArray(parsed.applicants)) throw new ApiError("parse");

  const byApplicant = {};
  for (const a of parsed.applicants) {
    const id = a && String(a.applicant_id || "").toUpperCase();
    if (!id || !applicantIds.includes(id) || !Array.isArray(a.results)) continue;
    byApplicant[id] = a.results
      .map((r) => r && { ...r, criterion_id: String(r.criterion_id || "").toLowerCase(), status: String(r.status || "").toLowerCase() })
      .filter((r) => r && Object.values(STATUS).includes(r.status));
  }
  const u = data.usage || {};
  const usage = {
    input: Number(u.prompt_tokens) || 0,
    output: Number(u.completion_tokens) || 0,
    thinking: 0,
    // 오늘 남은 요청 수(브라우저에서 헤더를 읽을 수 있을 때만)
    remainingToday: res.headers.get("x-ratelimit-remaining-requests"),
  };
  return { byApplicant, usage };
}

// 인용이 그 지원자에게 보낸 응답 안에 실제로 있는지 본다. 공백 차이는 무시한다.
function quoteFound(quote, payload) {
  const norm = (t) => String(t).replace(/\s+/g, " ").trim();
  const q = norm(quote);
  if (!q) return null;
  return payload.응답.some((a) => norm(a.응답).includes(q));
}

// 지원자 여러 명을 한 요청으로 판단한다. 판단이 없는(또는 조건이 바뀐) 조건만 맡기고, 임원 판단은 건드리지 않는다.
// 반환: { filled: 채운 조건 수, answered: 답을 받은 지원자 수, usage }
async function judgeBatch(applicants, key) {
  const jobs = applicants
    .map((a) => ({ a, targets: checksFor(a).filter((c) => !c.judged) }))
    .filter((j) => j.targets.length)
    .map((j) => ({ ...j, ...buildPayload(j.a, j.targets) }));
  if (!jobs.length) return { filled: 0, answered: 0, usage: null };

  const { byApplicant, usage } = await callGroq(key, jobs.map((j) => j.payload));

  let filled = 0;
  let answered = 0;
  for (const job of jobs) {
    const results = byApplicant[job.a.id];
    if (!results) continue; // 이 지원자는 답이 빠짐 → 비어 있는 채로 둔다
    answered++;
    const entry = resultEntry(job.a);
    for (const r of results) {
      const crit = activeCriteria().find((c) => c.id === job.idMap[r.criterion_id]);
      if (!crit) continue;
      const current = entry.judgments[crit.id];
      if (current && current.by === "human" && current.text === crit.text.trim()) continue; // 그 사이 임원이 판단함
      entry.judgments[crit.id] = {
        status: r.status,
        text: crit.text.trim(),
        by: "ai",
        quote: String(r.quote || "").slice(0, 500),
        quoteFound: quoteFound(r.quote || "", job.payload),
      };
      filled++;
    }
    entry.savedAt = Date.now();
  }
  saveResults();
  return { filled, answered, usage };
}

// ms만큼 기다린다. 남은 초를 화면에 보여 주고, 멈추기를 누르면 false를 돌려준다.
async function pause(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (state.ai.stop) return false;
    state.ai.waitSec = Math.ceil((end - Date.now()) / 1000);
    renderAiBar();
    await new Promise((r) => setTimeout(r, Math.min(250, end - Date.now())));
  }
  state.ai.waitSec = 0;
  renderAiBar();
  return !state.ai.stop;
}

function usageText(used) {
  const total = used.input + used.output;
  if (!total) return "";
  const left = used.remainingToday != null && used.remainingToday !== "" ? ` · 오늘 남은 요청 ${used.remainingToday}번` : "";
  return `(이번 실행: 입력 ${used.input.toLocaleString()} · 출력 ${used.output.toLocaleString()} 토큰${left})`;
}

// 지원자를 AI_BATCH_SIZE명씩 묶어 순서대로 보낸다. 오류가 나면 그 자리에서 멈춘다(자동 재시도 없음).
async function runAi(applicants) {
  const key = getApiKey();
  if (!key) {
    showResultStatus("error", AI_ERROR_TEXT.nokey);
    openKeyDialog();
    return;
  }
  const queue = applicants.filter((a) => checksFor(a).some((c) => !c.judged));
  if (!queue.length) {
    showResultStatus("ok", "판단이 비어 있는 조건이 없습니다.");
    return;
  }
  const batches = [];
  for (let i = 0; i < queue.length; i += AI_BATCH_SIZE) batches.push(queue.slice(i, i + AI_BATCH_SIZE));

  state.ai = { running: true, stop: false, done: 0, total: queue.length, req: 0, reqTotal: batches.length, waitSec: 0 };
  renderAiBar();
  let filled = 0;
  let missing = 0;
  const used = { input: 0, output: 0, thinking: 0 };
  let lastStart = 0;
  let current = null;
  try {
    for (const batch of batches) {
      // 요청 사이 간격 두기(첫 요청은 바로). 멈추기를 누르면 기다리지 않고 끝낸다.
      const wait = lastStart ? state.aiPaceMs - (Date.now() - lastStart) : 0;
      if (wait > 0 && !(await pause(wait))) break;
      if (state.ai.stop) break;

      current = batch;
      lastStart = Date.now();
      const ids = `${batch[0].id}${batch.length > 1 ? `~${batch[batch.length - 1].id}` : ""}`;
      showResultStatus("info", `AI 판단 중… ${ids} (요청 ${state.ai.req + 1}/${batches.length})`);
      const r = await judgeBatch(batch, key);
      filled += r.filled;
      missing += batch.length - r.answered;
      if (r.usage) {
        for (const k of ["input", "output", "thinking"]) used[k] += r.usage[k];
        if (r.usage.remainingToday != null) used.remainingToday = r.usage.remainingToday;
      }
      state.ai.done += batch.length;
      state.ai.req++;
      current = null;
      renderResults();
    }
    const stopped = state.ai.req < batches.length;
    showResultStatus(missing ? "warn" : "ok", [
      `요청 ${state.ai.req}번으로 ${state.ai.done}명, 조건 ${filled}개를 AI가 채웠습니다.`,
      missing ? `${missing}명은 AI 답에서 빠져 비어 있습니다. 다시 누르면 그 지원자만 보냅니다.` : "",
      usageText(used),
      stopped ? "중간에 멈췄습니다. 다시 누르면 남은 지원자부터 이어서 합니다." : "",
      "인용을 확인하고, 필요하면 직접 고쳐 주세요.",
    ].filter(Boolean).join(" "));
  } catch (err) {
    let msg = err instanceof ApiError ? err.message : `예상치 못한 오류: ${err.message}`;
    // 한도에 걸렸으면 이 탭에서는 다음 실행부터 요청 간격을 1.5배로 늘린다(최대 30초).
    if (err instanceof ApiError && err.kind === "quota") {
      const need = Math.min(Math.round(state.aiPaceMs * 1.5), 30000);
      if (need > state.aiPaceMs) {
        state.aiPaceMs = need;
        msg += ` 다음 실행부터 요청 간격을 ${(need / 1000).toFixed(1)}초로 늘립니다.`;
      }
    }
    const where = !current ? "" : current.length > 1
      ? `${current[0].id}~${current[current.length - 1].id} 묶음에서 멈춤. `
      : `${current[0].id}에서 멈춤. `;
    showResultStatus("error", `${where}${msg}`
      + (state.ai.done ? ` 앞의 ${state.ai.done}명은 저장됐습니다. ${usageText(used)}`.trimEnd() : ""));
    if (err instanceof ApiError && err.kind === "key") openKeyDialog();
  } finally {
    state.ai.running = false;
    renderResults();
  }
}

/* ==========================================================
 * 7. 렌더
 * ========================================================== */

const $ = (sel) => document.querySelector(sel);

function showLoadStatus(kind, text) {
  const el = $("#load-status");
  el.className = `status ${kind}`;
  el.textContent = text;
}

function renderColumns() {
  const tbody = $("#col-rows");
  tbody.replaceChildren();

  for (const col of state.columns) {
    const tr = document.createElement("tr");
    tr.className = `role-${col.role}`;

    const tdQ = document.createElement("td");
    tdQ.className = "q";
    tdQ.textContent = col.title;

    const tdRole = document.createElement("td");
    const select = document.createElement("select");
    select.setAttribute("aria-label", `${col.title} 역할`);
    for (const role of Object.values(ROLE)) {
      const opt = document.createElement("option");
      opt.value = role;
      opt.textContent = ROLE_LABEL[role];
      opt.selected = col.role === role;
      select.append(opt);
    }
    select.addEventListener("change", () => setColumnRole(col.index, select.value));
    tdRole.append(select);
    // 역할 옆 짧은 설명: 이름은 표시만, 학번은 입학년도만
    let note = "";
    if (col.isName) {
      select.disabled = true;
      note = "이름: 화면 표시에만 사용";
    } else if (col.isStudentId && col.role === ROLE.REVIEW) {
      note = "AI에는 입학년도만";
    }
    if (note) {
      const small = document.createElement("span");
      small.className = "role-note";
      small.textContent = note;
      tdRole.append(small);
    }

    const tdEx = document.createElement("td");
    tdEx.className = "example";
    tdEx.textContent = col.example || "(응답 없음)";
    tdEx.title = col.example;

    const tdCount = document.createElement("td");
    tdCount.className = "count";
    tdCount.textContent = `${col.filled}/${state.applicants.length}`;

    tr.append(tdQ, tdRole, tdEx, tdCount);
    tbody.append(tr);
  }

  const review = state.columns.filter((c) => SENT_ROLES.includes(c.role)).length;
  const hasName = state.columns.some((c) => c.isName);
  const summary = $("#col-summary");
  if (review === 0) {
    summary.className = "status warn";
    summary.textContent = "심사 문항이 하나도 없습니다. 최소 한 문항은 '심사'로 골라 주세요.";
  } else {
    summary.className = "status";
    summary.textContent = `심사 문항 ${review}개`
      + (hasName ? "" : " · 이름 문항이 없어 지원자는 A번호로만 표시됩니다.");
  }

  $("#step-columns").hidden = false;
  updateStartButton();
}

function showCritStatus(kind, text) {
  const el = $("#crit-status");
  el.className = `status ${kind}`;
  el.textContent = text;
}

// 조건 목록 전체를 다시 그린다. 글자를 입력하는 중에는 부르지 않는다(포커스가 사라지므로).
function renderCriteria(focusId = null, clamped = false) {
  for (const group of document.querySelectorAll(".crit-group")) {
    const type = group.dataset.type;
    const list = group.querySelector(".crit-list");
    list.replaceChildren();

    const items = state.criteria.items.filter((c) => c.type === type);
    items.forEach((item, i) => {
      const li = document.createElement("li");

      const input = document.createElement("input");
      input.type = "text";
      input.value = item.text;
      input.maxLength = CRIT_TEXT_MAX;
      input.placeholder = group.dataset.placeholder;
      input.setAttribute("aria-label", `${group.dataset.label} ${i + 1}`);
      input.addEventListener("input", () => updateCriterionText(item.id, input.value));
      input.addEventListener("keydown", (e) => {
        // 한글 조합 중 Enter는 무시한다
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          addCriterion(type);
        }
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn icon";
      del.textContent = "삭제";
      del.setAttribute("aria-label", `${group.dataset.label} ${i + 1} 삭제`);
      del.addEventListener("click", () => removeCriterion(item.id));

      li.append(input, del);
      list.append(li);

      if (item.id === focusId) requestAnimationFrame(() => input.focus());
    });

    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "아직 없음";
      list.append(empty);
    }
  }

  $("#threshold").value = state.criteria.threshold;
  renderCriteriaSummary(clamped);
}

// 개수, threshold 가능 범위, 경고 문구만 갱신한다.
function renderCriteriaSummary(clamped = false) {
  const active = activeCriteria();
  const count = (t) => active.filter((c) => c.type === t).length;
  const pref = count(CRIT_TYPE.PREFERRED);
  const blanks = state.criteria.items.length - active.length;

  const th = $("#threshold");
  th.max = String(Math.max(pref, 1));
  th.disabled = pref === 0;
  $("#threshold-max").textContent = String(pref);
  $("#threshold-note").textContent = pref === 0
    ? "우대 조건이 없으면 필수·결격 조건만으로 판정합니다."
    : "";

  const summary = $("#crit-summary");
  const parts = [];
  if (!active.length) {
    summary.className = "status warn";
    parts.push("조건이 하나도 없습니다. 최소 한 개는 적어 주세요.");
  } else {
    summary.className = "status";
    parts.push(`필수 ${count(CRIT_TYPE.REQUIRED)}개 · 결격 ${count(CRIT_TYPE.DISQUALIFY)}개 · 우대 ${pref}개`);
  }
  if (blanks) parts.push(`내용이 빈 조건 ${blanks}개는 심사에서 빠집니다.`);
  if (clamped) parts.push(`우대 조건 수에 맞춰 기준을 ${state.criteria.threshold}개로 바꿨습니다.`);
  summary.textContent = parts.join(" ");
  updateStartButton();
}

// ---- 화면 전환 ----

function readyProblems() {
  const problems = [];
  if (!state.applicants.length) problems.push("응답 파일 불러오기");
  else if (!state.columns.some((c) => SENT_ROLES.includes(c.role))) problems.push("심사 문항 1개 이상 고르기");
  if (!activeCriteria().length) problems.push("조건 1개 이상 적기");
  return problems;
}

function updateStartButton() {
  const problems = readyProblems();
  $("#btn-start").disabled = problems.length > 0;
  $("#start-hint").textContent = problems.length ? `남은 일: ${problems.join(", ")}` : "";
}

function showScreen(name) {
  state.ui.screen = name;
  $("#screen-setup").hidden = name !== "setup";
  $("#screen-results").hidden = name !== "results";
  if (name === "results") renderResults();
  window.scrollTo(0, 0);
}

// ---- 화면 2: 심사 결과 ----

const STATUS_LABEL = {
  [CRIT_TYPE.REQUIRED]: { met: "충족", unmet: "미충족", unclear: "애매" },
  [CRIT_TYPE.DISQUALIFY]: { met: "해당", unmet: "해당 없음", unclear: "애매" },
  [CRIT_TYPE.PREFERRED]: { met: "충족", unmet: "미충족", unclear: "애매" },
};
const CRIT_LABEL = { required: "필수", disqualify: "결격", preferred: "우대" };
const OVERRIDE_LABEL = { pass: "통과로", hold: "보류로", fail: "탈락으로" };

const FILTERS = [
  { key: "all", label: "전체", test: () => true },
  { key: VERDICT.PASS, label: "통과", test: (e) => e.final === VERDICT.PASS },
  { key: VERDICT.HOLD, label: "보류", test: (e) => e.final === VERDICT.HOLD },
  { key: VERDICT.FAIL, label: "탈락", test: (e) => e.final === VERDICT.FAIL },
  { key: "edited", label: "수정됨", test: (e) => Boolean(e.override) },
  { key: "pending", label: "미판단 있음", test: (e) => e.pending > 0 },
  { key: "ai", label: "AI 확인 필요", test: (e) => e.aiUnchecked > 0 },
];

function showResultStatus(kind, text) {
  const el = $("#result-status");
  el.className = `status ${kind}`;
  el.textContent = text;
}

function displayName(applicant) {
  const col = state.columns.find((c) => c.isName);
  return col ? applicant.answers[col.index] : "";
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== "string") node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function verdictBadge(verdict) {
  return el("span", { class: `badge ${verdict}` }, VERDICT_LABEL[verdict]);
}

// 화면 2 전체를 다시 그린다. 누르던 버튼의 포커스는 되살린다.
function renderResults() {
  const focusKey = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.focusKey
    : null;

  const evals = new Map(state.applicants.map((a) => [a.id, evaluate(a)]));
  renderRules();
  renderFilters(evals);
  renderAiBar();

  const filter = FILTERS.find((f) => f.key === state.ui.filter) || FILTERS[0];
  const visible = state.applicants.filter((a) => filter.test(evals.get(a.id)));
  if (!visible.some((a) => a.id === state.ui.selectedId)) {
    state.ui.selectedId = visible.length ? visible[0].id : null;
  }
  renderList(visible, evals);
  renderDetail(visible, evals);

  if (focusKey) {
    const target = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    if (target) target.focus();
  }
}

function renderRules() {
  $("#rule-list").replaceChildren(
    ...RULES.map((r) => el("li", {}, verdictBadge(r.verdict), " ", r.text(state.criteria.threshold)))
  );
}

function renderFilters(evals) {
  const all = [...evals.values()];
  $("#filters").replaceChildren(
    ...FILTERS.map((f) => el("button", {
      type: "button",
      class: `chip${state.ui.filter === f.key ? " on" : ""}`,
      "aria-pressed": String(state.ui.filter === f.key),
      dataset: { focusKey: `filter-${f.key}` },
      onclick: () => { state.ui.filter = f.key; renderResults(); },
    }, `${f.label} ${all.filter(f.test).length}`))
  );
}

function renderList(visible, evals) {
  const list = $("#applicant-list");
  if (!visible.length) {
    list.replaceChildren(el("li", { class: "empty" }, "해당하는 지원자가 없습니다."));
    return;
  }
  list.replaceChildren(...visible.map((a) => {
    const e = evals.get(a.id);
    const name = displayName(a);
    return el("li", {},
      el("button", {
        type: "button",
        class: "applicant-item",
        "aria-current": state.ui.selectedId === a.id ? "true" : "false",
        dataset: { focusKey: `item-${a.id}` },
        onclick: () => selectApplicant(a.id, true),
      },
        el("span", { class: "who" }, el("b", {}, a.id), name ? ` ${name}` : ""),
        el("span", { class: "badges" },
          verdictBadge(e.final),
          e.override ? el("span", { class: "badge edited" }, "수정") : null,
          e.pending ? el("span", { class: "badge pending" }, `미판단 ${e.pending}`) : null,
          e.aiUnchecked ? el("span", { class: "badge ai", title: "AI가 채우고 아직 확인하지 않은 판단" }, `AI ${e.aiUnchecked}`) : null,
        ),
      ));
  }));
}

function selectApplicant(id, scroll) {
  state.ui.selectedId = id;
  renderResults();
  if (scroll && window.matchMedia("(max-width: 819px)").matches) {
    $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// AI 판단의 근거 인용
function evidenceOf(c) {
  if (!(c.by === "ai" || c.confirmedAi)) return null;
  const label = c.by === "ai" ? "AI" : "AI · 확인함";
  const needsQuote = c.status !== STATUS.UNCLEAR;
  return el("div", { class: "evidence" },
    el("span", { class: "badge ai" }, label), " ",
    c.quote ? el("q", {}, c.quote) : el("span", { class: "hint" }, needsQuote ? "인용 없음. 직접 확인해 주세요." : "인용 없음"),
    c.quoteFound === false
      ? el("p", { class: "hint warn-text" }, "보낸 응답에서 이 인용을 찾지 못했습니다. AI가 지어냈을 수 있으니 직접 확인해 주세요.")
      : null,
  );
}

function renderAiBar() {
  const running = state.ai.running;
  $("#btn-ai-all").disabled = running;
  $("#btn-ai-stop").hidden = !running;
  $("#btn-ai-stop").disabled = state.ai.stop;
  $("#ai-progress").textContent = running
    ? `${state.ai.done}/${state.ai.total}명 완료 (요청 ${state.ai.req}/${state.ai.reqTotal})`
      + (state.ai.waitSec ? ` · 다음 요청까지 ${state.ai.waitSec}초` : "")
    : `${AI_BATCH_SIZE > 1 ? `${AI_BATCH_SIZE}명씩 묶어` : "한 명씩"} 요청, 간격 ${(state.aiPaceMs / 1000).toFixed(1)}초 · ${MODEL}`;
}

// ---- 화면 3: API 키 설정 ----

function renderKeyState() {
  const has = Boolean(getApiKey());
  const badge = $("#key-state");
  badge.textContent = has ? "키 있음" : "키 없음";
  badge.className = `key-state ${has ? "on" : ""}`;
}

function showKeyStatus(kind, text) {
  const s = $("#key-dialog-status");
  s.className = `status ${kind}`;
  s.textContent = text;
}

function openKeyDialog() {
  const dlg = $("#key-dialog");
  $("#model-name").textContent = MODEL;
  $("#api-key-input").value = "";
  showKeyStatus(getApiKey() ? "ok" : "info",
    getApiKey() ? "저장된 키가 있습니다. 바꾸려면 새 키를 넣고 저장하세요." : "저장된 키가 없습니다.");
  if (!dlg.open) dlg.showModal();
  $("#api-key-input").focus();
}

function saveKeyFromDialog() {
  const value = $("#api-key-input").value.trim();
  if (!value) {
    showKeyStatus("warn", "키를 입력해 주세요.");
    return;
  }
  if (/\s/.test(value)) {
    showKeyStatus("warn", "키에 공백이 들어 있습니다. 복사한 키를 다시 확인해 주세요.");
    return;
  }
  if (!saveApiKey(value)) {
    showKeyStatus("error", "이 브라우저에 키를 저장할 수 없습니다(비공개 모드일 수 있음).");
    return;
  }
  $("#api-key-input").value = "";
  renderKeyState();
  showKeyStatus("ok", "저장했습니다. 키가 맞는지는 AI 판단을 처음 실행할 때 확인됩니다.");
}

function deleteKeyFromDialog() {
  saveApiKey("");
  $("#api-key-input").value = "";
  renderKeyState();
  showKeyStatus("ok", "이 브라우저에서 키를 삭제했습니다.");
}

function renderDetail(visible, evals) {
  const box = $("#detail");
  const a = state.applicants.find((x) => x.id === state.ui.selectedId);
  if (!a) {
    box.replaceChildren(el("p", { class: "hint" }, "왼쪽 목록에서 지원자를 고르세요."));
    return;
  }
  const e = evals.get(a.id);
  const name = displayName(a);
  const pos = visible.findIndex((x) => x.id === a.id);

  // 머리: 번호·이름·최종 판정과 근거
  const head = el("header", { class: "detail-head" },
    el("h2", {}, a.id, name ? ` · ${name}` : ""),
    el("p", { class: "verdict-line" },
      verdictBadge(e.final),
      e.override
        ? el("span", {}, " ", el("span", { class: "badge edited" }, "수정"), ` 규칙 판정은 ${VERDICT_LABEL[e.rule.verdict]}`)
        : null,
    ),
    el("p", { class: "reason" }, el("b", {}, "규칙 근거: "), e.rule.reason),
    e.pending ? el("p", { class: "hint" }, `아직 판단하지 않은 조건 ${e.pending}개는 '애매'로 계산했습니다.`) : null,
  );

  // 응답: 심사 문항만 보여 준다
  const reviewCols = state.columns.filter((c) => SENT_ROLES.includes(c.role));
  const answers = el("section", { class: "answers" },
    el("h3", {}, "심사 문항 응답"),
    el("dl", {}, ...reviewCols.flatMap((c) => [
      el("dt", {}, c.title),
      el("dd", { class: a.answers[c.index] ? "" : "blank" },
        a.answers[c.index] || "(무응답)",
        c.isStudentId ? el("span", { class: "hint" }, ` → AI에는 ${sentValueOf(c, a.answers[c.index])}만 보냄`) : null),
    ])),
  );

  // 조건별 판단
  const order = [CRIT_TYPE.REQUIRED, CRIT_TYPE.DISQUALIFY, CRIT_TYPE.PREFERRED];
  const checks = [...e.checks].sort((x, y) => order.indexOf(x.type) - order.indexOf(y.type));
  const judge = el("section", { class: "judge" },
    el("h3", {}, "조건별 판단"),
    el("ul", {}, ...checks.map((c) => el("li", { class: [c.judged ? "" : "unjudged", c.by === "ai" ? "by-ai" : ""].join(" ").trim() },
      el("div", { class: "crit-text" }, el("span", { class: `tag ${c.type}` }, CRIT_LABEL[c.type]), " ", c.text),
      el("div", { class: "seg", role: "group", "aria-label": `${c.text} 판단` },
        ...[STATUS.MET, STATUS.UNMET, STATUS.UNCLEAR].map((s) => el("button", {
          type: "button",
          class: `seg-btn ${s}`,
          "aria-pressed": String(c.judged && c.status === s),
          dataset: { focusKey: `judge-${a.id}-${c.id}-${s}` },
          onclick: () => setJudgment(a, c.id, s),
        }, STATUS_LABEL[c.type][s])),
      ),
      evidenceOf(c),
      c.stale ? el("p", { class: "hint warn-text" }, "조건 문장이 바뀌어 다시 판단해야 합니다.") : null,
    ))),
    el("p", { class: "hint" }, "같은 버튼을 한 번 더 누르면 판단을 지웁니다. AI가 채운 판단은 같은 버튼을 누르면 '확인'으로 바뀝니다."),
  );

  // 이 지원자만 AI 판단 + 보내는 내용 미리보기
  const pendingTargets = e.checks.filter((c) => !c.judged);
  const preview = buildPayload(a, pendingTargets.length ? pendingTargets : e.checks).payload;
  const aiBox = el("section", { class: "ai-one" },
    el("h3", {}, "AI 판단"),
    el("button", {
      type: "button", class: "btn",
      disabled: state.ai.running || pendingTargets.length === 0,
      dataset: { focusKey: `ai-one-${a.id}` },
      onclick: () => runAi([a]),
    }, pendingTargets.length ? `이 지원자의 빈 판단 ${pendingTargets.length}개 AI로 채우기` : "빈 판단 없음"),
    el("details", { class: "payload" },
      el("summary", {}, pendingTargets.length ? "AI에 보내는 내용 보기" : "AI에 보내는 내용 보기 (지금은 빈 판단이 없어 보낼 것이 없음, 전체 조건 기준 예시)"),
      el("p", { class: "hint" }, AI_BATCH_SIZE > 1
        ? `여러 명을 묶어 보낼 때는 이런 내용이 최대 ${AI_BATCH_SIZE}명분 "지원자들" 목록에 들어갑니다.`
        : `실제로는 이 내용이 "지원자들" 목록에 한 명분 담겨 ${MODEL}로 갑니다.`),
      el("pre", {}, JSON.stringify(preview, null, 2)),
    ),
  );

  // 최종 판정(override)
  const select = el("select", {
    id: "override",
    dataset: { focusKey: `override-${a.id}` },
    onchange: (ev) => setOverride(a, ev.target.value),
  },
    el("option", { value: "" }, `규칙대로 (${VERDICT_LABEL[e.rule.verdict]})`),
    ...Object.values(VERDICT).map((v) => el("option", { value: v }, `${OVERRIDE_LABEL[v]} 수정`)),
  );
  select.value = e.override || "";
  const final = el("section", { class: "final" },
    el("h3", {}, "최종 판정"),
    el("label", { for: "override" }, "임원 판단: "), select,
  );

  const nav = el("footer", { class: "detail-nav" },
    el("button", {
      type: "button", class: "btn", disabled: pos <= 0,
      dataset: { focusKey: "nav-prev" },
      onclick: () => selectApplicant(visible[pos - 1].id, false),
    }, "← 이전 지원자"),
    el("span", { class: "hint" }, `${pos + 1} / ${visible.length}`),
    el("button", {
      type: "button", class: "btn", disabled: pos >= visible.length - 1,
      dataset: { focusKey: "nav-next" },
      onclick: () => selectApplicant(visible[pos + 1].id, false),
    }, "다음 지원자 →"),
  );

  box.replaceChildren(head, answers, judge, aiBox, final, nav);
}

/* ==========================================================
 * 8. 내보내기
 * ========================================================== */

// 임원 간 공유용 결과 CSV. 이름은 넣고(누가 누구인지 알아야 하므로), 응답 원문은 넣지 않는다(원본 구글폼에 있음).
const BY_LABEL = { human: "임원", ai: "AI" };

// 엑셀이 수식으로 실행하지 않게 =, +, -, @, 탭, CR로 시작하는 칸 앞에 '를 붙인다(CSV 수식 삽입 방지).
function safeCell(value) {
  const text = String(value ?? "");
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

// CSV 한 칸: 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싸고 안의 따옴표는 두 번 쓴다.
function csvCell(value) {
  const text = safeCell(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildResultRows() {
  const criteria = activeCriteria();
  const header = ["지원자", "이름", "최종 판정", "임원 수정", "규칙 판정", "규칙 근거", "미판단 조건 수"];
  criteria.forEach((c, i) => {
    const label = `조건${i + 1} [${CRIT_LABEL[c.type]}] ${c.text.trim()}`;
    header.push(`${label} - 판단`, `${label} - 근거 인용`, `${label} - 판단 주체`);
  });

  const rows = state.applicants.map((a) => {
    const e = evaluate(a);
    const row = [
      a.id,
      displayName(a),
      VERDICT_LABEL[e.final],
      e.override ? "수정" : "",
      VERDICT_LABEL[e.rule.verdict],
      e.rule.reason,
      e.pending,
    ];
    for (const c of criteria) {
      const check = e.checks.find((x) => x.id === c.id);
      if (!check || !check.judged) {
        row.push(check && check.stale ? "다시 판단 필요" : "미판단", "", "");
        continue;
      }
      const who = check.by === "human" && check.confirmedAi ? "AI→임원 확인" : BY_LABEL[check.by] || "";
      row.push(STATUS_LABEL[c.type][check.status], check.quote || "", who);
    }
    return row;
  });
  return [header, ...rows];
}

function exportCsv() {
  if (!state.applicants.length) {
    showResultStatus("warn", "내보낼 지원자가 없습니다. 먼저 응답 파일을 불러와 주세요.");
    return;
  }
  const rows = buildResultRows();
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  // BOM(﻿)을 붙여야 엑셀에서 한글이 깨지지 않는다.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const link = document.createElement("a");
  link.href = url;
  // 파일 이름은 영문으로 둔다. 한글 이름은 일부 브라우저에서 "download"로 바뀌어 저장됐다(헤드리스 크롬 테스트).
  link.download = `screening_result_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
  document.body.append(link);
  link.click();
  // 바로 지우면 일부 브라우저가 파일 이름(download 속성)을 잃어서 잠시 뒤에 정리한다.
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1000);

  const pending = state.applicants.filter((a) => evaluate(a).pending > 0).length;
  showResultStatus(pending ? "warn" : "ok",
    `${link.download}로 ${state.applicants.length}명의 결과를 내보냈습니다.`
    + (pending ? ` 아직 판단이 비어 있는 지원자가 ${pending}명 있습니다(파일에 '미판단'으로 표시).` : "")
    + " 이름이 들어 있으니 임원끼리만 공유해 주세요.");
}

/* ==========================================================
 * 시작
 * ========================================================== */

function init() {
  // 조건 설정은 CSV 도구 없이도 동작해야 하므로 먼저 연결한다.
  for (const btn of document.querySelectorAll("[data-add]")) {
    btn.addEventListener("click", () => addCriterion(btn.dataset.add));
  }
  $("#threshold").addEventListener("change", (e) => setThreshold(e.target.value));
  loadCriteria();
  loadResults();
  renderCriteria();

  $("#btn-start").addEventListener("click", () => showScreen("results"));
  $("#btn-key").addEventListener("click", openKeyDialog);
  $("#btn-key-save").addEventListener("click", saveKeyFromDialog);
  $("#btn-key-delete").addEventListener("click", deleteKeyFromDialog);
  $("#api-key-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); saveKeyFromDialog(); }
  });
  $("#btn-ai-all").addEventListener("click", () => runAi(state.applicants));
  $("#btn-ai-stop").addEventListener("click", () => { state.ai.stop = true; renderAiBar(); });
  renderKeyState();
  $("#btn-back").addEventListener("click", () => showScreen("setup"));
  $("#btn-export").addEventListener("click", exportCsv);

  // 도구를 못 불러왔어도 버튼은 연결한다. 그래야 파일을 골랐을 때 이유를 보여 줄 수 있다.
  if (typeof Papa === "undefined") {
    showLoadStatus("error", "CSV 읽기 도구(PapaParse)를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.");
  }

  $("#csv-file").addEventListener("change", (e) => {
    readFile(e.target.files[0]);
    e.target.value = ""; // 같은 파일을 다시 골라도 change가 일어나게
  });

  $("#btn-sample").addEventListener("click", () => {
    readCsvText(SAMPLE_CSV, "예시 데이터");
    if (state.source && state.source.label === "예시 데이터" && fillSampleCriteriaIfEmpty()) {
      $("#load-status").textContent += " 저장된 조건이 없어 예시 조건도 채웠습니다.";
    }
  });

  // 페이지 어디에 떨어뜨려도 읽는다. 끌고 있는 동안 안내 영역을 강조한다.
  const drop = $("#drop-zone");
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
    dragDepth++;
    drop.classList.add("over");
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) drop.classList.remove("over");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    drop.classList.remove("over");
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) readFile(file);
  });

  // 예상 못 한 오류도 화면에 보이게 한다. "아무 반응 없음"을 막기 위해서다.
  window.addEventListener("error", (e) => showLoadStatus("error", `예상치 못한 오류: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => {
    showLoadStatus("error", `예상치 못한 오류: ${e.reason && e.reason.message ? e.reason.message : e.reason}`);
  });
}

init();
