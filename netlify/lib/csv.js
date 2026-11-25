// CSV 유틸 — 엑셀/홈택스/Airtable 내보내기 파일을 그대로 다루기 위한 최소 구현.
// (따옴표로 감싼 값, 값 안의 쉼표·줄바꿈·따옴표(""), BOM, CRLF 모두 처리)

/** CSV 문자열 → 행 배열(배열의 배열). 빈 줄은 건너뛴다. */
export function parseCsv(text) {
  let s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') {
      if (s[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
      i++; continue;
    }
    if (ch === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
      i++; continue;
    }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
}

export function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(rows) {
  return rows.map(function (r) { return r.map(csvEscape).join(','); }).join('\r\n');
}

/** 헤더 이름 비교용 정규화: BOM/공백/괄호 안 부가설명 제거, 소문자 */
export function normalizeHeader(h) {
  return String(h == null ? '' : h)
    .replace(/^\uFEFF/, '')
    .replace(/\s+/g, '')
    .replace(/[()[\]]/g, '')
    .toLowerCase();
}

/** 헤더 행 + 데이터 행 → 객체 배열 */
export function rowsToObjects(rows) {
  if (!rows || !rows.length) return [];
  const header = rows[0].map(function (h) { return String(h == null ? '' : h).trim(); });
  return rows.slice(1).map(function (r) {
    const o = {};
    header.forEach(function (h, i) { if (h) o[h] = r[i] === undefined ? '' : r[i]; });
    return o;
  });
}
