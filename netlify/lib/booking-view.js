// 고객용 예약현황(공개 API) 응답 만들기 — 기존 Airtable 판과 똑같은 규칙.
//
// 공개 응답에는 이름(마스킹)·연락처 뒷4자리·인원·시작/종료만 나간다.
// 메모(note)는 관리자 전용이라 절대 포함하지 않는다.

export const STORE_LABEL = { first: '1호점', second: '2호점' };
export const STORE_KEY = { '1호점': 'first', '2호점': 'second' };

export function pad2(n) { return n < 10 ? '0' + n : '' + n; }

export function timeToMin(t) {
  const p = String(t || '').split(':');
  const h = parseInt(p[0], 10);
  const m = parseInt(p[1], 10);
  if (isNaN(h)) return 0;
  return h * 60 + (isNaN(m) ? 0 : m);
}

export function minToTime(mins) { return pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60); }

/** 종료시간이 24:00 을 넘으면 다음날까지 이어지는 예약 */
export function isOvernight(end) { return timeToMin(end) > 1440; }

/** 고객용 이름 마스킹: 첫 글자와 가운데 글자만 남기고 나머지는 '*' (2글자 이하는 그대로) */
export function maskName(name) {
  const chars = Array.from(String(name == null ? '' : name));
  const n = chars.length;
  if (n <= 2) return chars.join('');
  const midIdx = Math.floor(n / 2);
  return chars.map(function (ch, i) { return (i === 0 || i === midIdx) ? ch : '*'; }).join('');
}

function nextIso(iso) {
  const p = iso.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1));
  return d.toISOString().slice(0, 10);
}

/** 한국 시간 기준 오늘(YYYY-MM-DD) */
export function todayIsoKst(now) {
  const date = now instanceof Date ? now : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const map = {};
  for (let i = 0; i < parts.length; i++) map[parts[i].type] = parts[i].value;
  return map.year + '-' + map.month + '-' + map.day;
}

/** 한국 시간 기준 어제(YYYY-MM-DD) — 자정을 넘긴 예약이 오늘로 이어지는지 보려면 어제부터 읽어야 한다 */
export function yesterdayIsoKst(now) {
  const today = todayIsoKst(now);
  const p = today.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Supabase rows → 고객용 응답 { first: { 'YYYY-MM-DD': [ {start,end,name,phone4,party} ] }, second: {...} }
 *
 * - 오늘(todayIso) 이후 날짜만 내보낸다. 지난 예약은 요청 시점 기준으로 자동 제외.
 * - 자정을 넘긴 예약(end_time > 24:00)은 시작한 날에 "23:00-01:00", 다음날에 "00:00-01:00" 으로 두 번 보인다.
 */
export function buildPublicView(rows, todayIso) {
  const out = { first: {}, second: {} };
  const today = todayIso;
  (rows || []).forEach(function (row) {
    if (!row) return;
    const storeKey = STORE_KEY[row.store];
    const iso = String(row.date || '').slice(0, 10);
    if (!storeKey || !iso) return;
    const base = {
      name: maskName(row.name || ''),
      phone4: row.phone4 || '',
      party: row.party || ''
    };
    const endMin = timeToMin(row.end_time);
    if (iso >= today) {
      if (!out[storeKey][iso]) out[storeKey][iso] = [];
      out[storeKey][iso].push(Object.assign({
        start: row.start_time || '',
        end: endMin > 1440 ? minToTime(endMin - 1440) : (row.end_time || '')
      }, base));
    }
    if (endMin > 1440) {
      const next = nextIso(iso);
      if (next >= today) {
        if (!out[storeKey][next]) out[storeKey][next] = [];
        out[storeKey][next].push(Object.assign({ start: '00:00', end: minToTime(endMin - 1440) }, base));
      }
    }
  });
  ['first', 'second'].forEach(function (storeKey) {
    Object.keys(out[storeKey]).forEach(function (iso) {
      out[storeKey][iso].sort(function (a, b) { return a.start < b.start ? -1 : (a.start > b.start ? 1 : 0); });
    });
  });
  return out;
}
