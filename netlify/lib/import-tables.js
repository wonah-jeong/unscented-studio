// Airtable CSV(또는 이 시스템이 내보낸 CSV) 일괄 가져오기.
//
// - 예약/고객/결제/지출 네 표 모두, 한글 헤더(기존 Airtable·관리자 화면의 헤더)와
//   영문 헤더(book_key, store, ...)를 함께 받아들인다.
// - 예약·결제는 예약키(book_key/pay_key)로 upsert → 같은 파일을 두 번 올려도 중복이 쌓이지 않는다.
// - 고객은 연락처(숫자만 비교) 또는 이름으로 기존 고객을 찾아 갱신한다.
// - 지출은 자연키가 없어 (날짜·항목·금액·지점)이 같은 행이 이미 있으면 건너뛴다.

import { parseCsv, rowsToObjects, normalizeHeader } from './csv.js';
import { sbSelectAll, sbUpsert, sbInsert, sbPatch } from './supabase.js';
import { STORES, STATUSES } from './tables.js';

export const MAX_IMPORT_ROWS = 10000;

export class ImportError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'ImportError';
    this.extra = extra || null;
  }
}

// 헤더 이름 → 내부 필드. normalizeHeader 를 거친 값(공백·괄호 제거, 소문자)으로 비교한다.
const FIELDS = {
  bookings: {
    book_key: ['예약키', 'bookkey', 'key', 'id'],
    store: ['매장', '지점', 'store'],
    date: ['날짜', 'date'],
    start_time: ['시작', '시작시간', 'start', 'starttime'],
    end_time: ['종료', '종료시간', 'end', 'endtime'],
    name: ['이름', '고객이름', 'name'],
    phone4: ['연락처4자리', '연락처뒷4자리', '연락처', '뒷4자리', 'phone4'],
    party: ['인원', '인원수', 'party'],
    note: ['메모', '특이사항', 'note']
  },
  customers: {
    name: ['이름', '고객이름', 'name'],
    phone: ['연락처', '전화번호', '휴대폰', 'phone'],
    biz_no: ['사업자등록번호', '사업자번호', 'bizno'],
    biz_name: ['상호', '사업자상호', 'bizname'],
    biz_owner: ['대표자명', '성명', '대표자', 'bizowner'],
    email: ['이메일', 'email'],
    note: ['메모', 'note']
  },
  payments: {
    pay_key: ['예약키', 'paykey', 'key', 'id'],
    store: ['매장', '지점', 'store'],
    date: ['날짜', 'date'],
    start_time: ['시작', '시작시간', 'start'],
    end_time: ['종료', '종료시간', 'end'],
    customer: ['연결된고객', '고객', '고객명', 'customername', 'customer'],
    phone: ['연락처전체', '연락처', '고객연락처', 'phone'],
    amount: ['금액', '결제금액', 'amount'],
    status: ['발행상태', 'status'],
    biz_no: ['사업자등록번호', '사업자번호', 'bizno'],
    biz_name: ['상호', 'bizname'],
    biz_owner: ['대표자명', '대표자', 'bizowner'],
    email: ['이메일', 'email'],
    paid: ['입금완료', 'paid'],
    alt_phone: ['추가연락처', '안내번호', '안내받을번호', 'altphone'],
    sms: ['문자여부', '문자발송', 'sms'],
    note: ['메모', 'note']
  },
  expenses: {
    date: ['날짜', 'date'],
    item: ['항목', '항목명', 'item'],
    amount: ['금액', 'amount'],
    store: ['매장', '지점', 'store'],
    note: ['메모', 'note']
  }
};

const ALIAS_LOOKUP = {};
Object.keys(FIELDS).forEach(function (table) {
  const map = {};
  Object.keys(FIELDS[table]).forEach(function (field) {
    FIELDS[table][field].forEach(function (alias) { map[normalizeHeader(alias)] = field; });
  });
  ALIAS_LOOKUP[table] = map;
});

/** "2026.11.24", "2026/11/24", "2026-1-5" → "2026-11-24" (실패 시 '') */
export function normDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})/);
  if (!m) return '';
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return '';
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
}

/** "9:00" → "09:00", "24:00" 유지, "25:30" 유지 (실패 시 '') */
export function normTime(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (mi > 59 || h > 49) return '';
  return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
}

export function normStore(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '1호점' || s === '1' || /^1호점?$/.test(s)) return '1호점';
  if (s === '2호점' || s === '2' || /^2호점?$/.test(s)) return '2호점';
  if (s === '공통' || s === 'common' || s === '') return '공통';
  return '';
}

export function normStoreTwo(v) {
  const s = normStore(v);
  return s === '1호점' || s === '2호점' ? s : '';
}

export function normStatus(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '발행안함';
  if (STATUSES.indexOf(s) >= 0) return s;
  if (/세금/.test(s) || /tax/i.test(s)) return '세금계산서발행';
  if (/현금/.test(s) || /cash/i.test(s)) return '현금영수증발행';
  if (/카드/.test(s) || /card/i.test(s)) return '카드결제';
  if (/안함|없음|none/i.test(s)) return '발행안함';
  return '';
}

export function parseAmount(v) {
  const s = String(v == null ? '' : v).replace(/[,\s원₩]/g, '');
  if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}

export function parseBool(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return false;
  return ['y', 'yes', 'true', '1', 'o', '예', '입금', '입금완료', '발송', '문자'].indexOf(s) >= 0;
}

export function digits(v) { return String(v == null ? '' : v).replace(/[^0-9]/g, ''); }

function pickValues(obj, table) {
  const map = ALIAS_LOOKUP[table];
  const out = {};
  const seen = {};
  Object.keys(obj).forEach(function (key) {
    const field = map[normalizeHeader(key)];
    if (!field) return;
    // 같은 필드에 별칭이 여러 개 걸려 있으면 값이 있는 첫 칸을 쓴다.
    const val = String(obj[key] == null ? '' : obj[key]).trim();
    if (seen[field] && seen[field] !== '') return;
    out[field] = val;
    seen[field] = val;
  });
  return out;
}

function requireColumns(table, objects) {
  const spec = FIELDS[table];
  const first = objects[0] || {};
  const normalized = {};
  Object.keys(first).forEach(function (k) { normalized[normalizeHeader(k)] = true; });
  const map = ALIAS_LOOKUP[table];
  const found = {};
  Object.keys(normalized).forEach(function (k) { if (map[k]) found[map[k]] = true; });
  return found;
}

function genKey(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * CSV 텍스트 → { records, errors }
 * records: DB 에 넣을 수 있는 객체 배열(검증 통과분)
 */
export function parseTableCsv(table, csvText) {
  if (!FIELDS[table]) throw new ImportError('가져올 수 없는 표예요: ' + table);
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    throw new ImportError('가져올 데이터가 없어요. 첫 줄은 제목(헤더) 행, 두 번째 줄부터 데이터여야 합니다.');
  }
  if (rows.length - 1 > MAX_IMPORT_ROWS) tooManyRows(rows.length - 1);

  const objects = rowsToObjects(rows);
  const found = requireColumns(table, objects);
  const need = table === 'bookings' ? ['date', 'start_time', 'end_time']
    : table === 'customers' ? ['name']
      : table === 'payments' ? ['date', 'start_time', 'end_time']
        : ['date', 'item', 'amount'];
  const missingCols = need.filter(function (f) { return !found[f]; });
  if (missingCols.length) {
    const label = { date: '날짜', start_time: '시작', end_time: '종료', name: '이름', item: '항목', amount: '금액' };
    throw new ImportError('필수 열이 없어요: ' + missingCols.map(function (f) { return label[f]; }).join(', ') +
      '. 첫 줄(헤더)에 ' + label[need[0]] + ' 같은 이름이 있어야 합니다. (지금 헤더: ' +
      Object.keys(objects[0] || {}).join(', ') + ')');
  }

  const records = [];
  const errors = [];
  objects.forEach(function (obj, idx) {
    const line = idx + 2;
    const v = pickValues(obj, table);
    try {
      if (table === 'bookings') {
        const date = normDate(v.date);
        const start = normTime(v.start_time);
        const end = normTime(v.end_time);
        const store = normStoreTwo(v.store);
        if (!date) throw new ImportError('날짜를 읽지 못했어요: "' + (v.date || '') + '"');
        if (!start) throw new ImportError('시작 시간을 읽지 못했어요: "' + (v.start_time || '') + '"');
        if (!end) throw new ImportError('종료 시간을 읽지 못했어요: "' + (v.end_time || '') + '"');
        if (!store) throw new ImportError('매장은 1호점/2호점이어야 해요: "' + (v.store || '') + '"');
        records.push({
          book_key: v.book_key || genKey('imp'),
          store: store, date: date, start_time: start, end_time: end,
          name: v.name || '', phone4: digits(v.phone4).slice(-4), party: v.party || '', note: v.note || ''
        });
      } else if (table === 'customers') {
        if (!v.name) throw new ImportError('이름이 비어 있어요');
        records.push({
          name: v.name, phone: v.phone || '', biz_no: v.biz_no || '',
          biz_name: v.biz_name || '', biz_owner: v.biz_owner || '', email: v.email || '', note: v.note || ''
        });
      } else if (table === 'payments') {
        const date = normDate(v.date);
        const start = normTime(v.start_time);
        const end = normTime(v.end_time);
        const store = normStoreTwo(v.store);
        const status = normStatus(v.status);
        if (!date) throw new ImportError('날짜를 읽지 못했어요: "' + (v.date || '') + '"');
        if (!start) throw new ImportError('시작 시간을 읽지 못했어요: "' + (v.start_time || '') + '"');
        if (!end) throw new ImportError('종료 시간을 읽지 못했어요: "' + (v.end_time || '') + '"');
        if (!store) throw new ImportError('매장은 1호점/2호점이어야 해요: "' + (v.store || '') + '"');
        if (!status) throw new ImportError('발행상태를 읽지 못했어요: "' + (v.status || '') + '"');
        records.push({
          pay_key: v.pay_key || genKey('imp'),
          store: store, date: date, start_time: start, end_time: end,
          amount: parseAmount(v.amount), status: status,
          biz_no: v.biz_no || '', biz_name: v.biz_name || '', biz_owner: v.biz_owner || '',
          email: v.email || '', paid: parseBool(v.paid),
          alt_phone: v.alt_phone || '', sms: parseBool(v.sms), note: v.note || '',
          _customerName: v.customer || '', _customerPhone: v.phone || ''
        });
      } else if (table === 'expenses') {
        const date = normDate(v.date);
        const amount = parseAmount(v.amount);
        const store = normStore(v.store) || '공통';
        if (!date) throw new ImportError('날짜를 읽지 못했어요: "' + (v.date || '') + '"');
        if (!v.item) throw new ImportError('항목이 비어 있어요');
        if (amount == null) throw new ImportError('금액을 읽지 못했어요: "' + (v.amount || '') + '"');
        records.push({ date: date, item: v.item, amount: amount, store: store, note: v.note || '' });
      }
    } catch (e) {
      errors.push({ line: line, message: e.message });
    }
  });
  return { records: records, errors: errors, total: objects.length };
}

function tooManyRows(n) {
  throw new ImportError('한 번에 ' + MAX_IMPORT_ROWS + '건까지만 가져올 수 있어요 (지금 ' + n + '건). 파일을 나눠서 올려주세요.');
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadCustomers(cfg) {
  const res = await sbSelectAll(cfg, 'customers', { select: 'id,name,phone' });
  if (!res.ok) throw new ImportError('고객 목록을 읽지 못했어요: ' + (res.error && res.error.message));
  return res.data || [];
}

/**
 * 표 하나를 실제로 가져온다.
 * 반환: { table, total, written, inserted, updated, skipped, errors }
 */
export async function applyImport(cfg, table, csvText) {
  const parsed = parseTableCsv(table, csvText);
  const result = {
    table: table, total: parsed.total, written: 0, inserted: 0, updated: 0,
    skipped: 0, errors: parsed.errors.slice(0, 30)
  };
  const records = parsed.records;
  if (!records.length) return result;

  if (table === 'bookings') {
    for (const part of chunk(records, 200)) {
      const res = await sbUpsert(cfg, 'bookings', part, { onConflict: 'book_key' });
      if (!res.ok) throw new ImportError('예약 저장 실패: ' + (res.error && res.error.message));
      result.written += (res.data || part).length;
    }
    result.inserted = result.written;
    return result;
  }

  if (table === 'customers') {
    const existing = await loadCustomers(cfg);
    const byPhone = {};
    const byName = {};
    existing.forEach(function (c) {
      const ph = digits(c.phone);
      if (ph) byPhone[ph] = c;
      if (c.name) byName[String(c.name).trim()] = byName[String(c.name).trim()] || c;
    });
    for (const rec of records) {
      const ph = digits(rec.phone);
      const hit = (ph && byPhone[ph]) || (!ph && rec.name && byName[rec.name]) || null;
      if (hit) {
        const patch = {};
        ['name', 'phone', 'biz_no', 'biz_name', 'biz_owner', 'email', 'note'].forEach(function (k) {
          if (rec[k]) patch[k] = rec[k];
        });
        const res = await sbPatch(cfg, 'customers', [['id', 'eq', hit.id]], patch);
        if (!res.ok) throw new ImportError('고객 수정 실패: ' + (res.error && res.error.message));
        result.updated += 1;
        if (ph) byPhone[ph] = hit;
      } else {
        const res = await sbInsert(cfg, 'customers', [rec]);
        if (!res.ok) throw new ImportError('고객 저장 실패: ' + (res.error && res.error.message));
        const row = (res.data || [])[0] || {};
        if (ph) byPhone[ph] = row;
        if (rec.name) byName[rec.name] = byName[rec.name] || row;
        result.inserted += 1;
      }
      result.written += 1;
    }
    return result;
  }

  if (table === 'payments') {
    const customers = await loadCustomers(cfg);
    const byPhone = {};
    const byName = {};
    customers.forEach(function (c) {
      const ph = digits(c.phone);
      if (ph) byPhone[ph] = c;
      if (c.name) byName[String(c.name).trim()] = byName[String(c.name).trim()] || c;
    });
    const rows = [];
    for (const rec of records) {
      const ph = digits(rec._customerPhone);
      let cust = (ph && byPhone[ph]) || (rec._customerName && byName[String(rec._customerName).trim()]) || null;
      if (!cust && (rec._customerName || ph)) {
        const created = await sbInsert(cfg, 'customers', [{
          name: rec._customerName || ('고객 ' + ph.slice(-4)), phone: rec._customerPhone || ''
        }]);
        if (!created.ok) throw new ImportError('고객 자동 등록 실패: ' + (created.error && created.error.message));
        cust = (created.data || [])[0] || null;
        if (ph && cust) byPhone[ph] = cust;
        if (cust && cust.name) byName[cust.name] = byName[cust.name] || cust;
      }
      rows.push({
        pay_key: rec.pay_key, store: rec.store, date: rec.date,
        start_time: rec.start_time, end_time: rec.end_time,
        customer_id: cust ? cust.id : null,
        amount: rec.amount, status: rec.status,
        biz_no: rec.biz_no, biz_name: rec.biz_name, biz_owner: rec.biz_owner, email: rec.email,
        paid: rec.paid, alt_phone: rec.alt_phone, sms: rec.sms, note: rec.note
      });
    }
    for (const part of chunk(rows, 200)) {
      const res = await sbUpsert(cfg, 'payments', part, { onConflict: 'pay_key' });
      if (!res.ok) throw new ImportError('결제기록 저장 실패: ' + (res.error && res.error.message));
      result.written += (res.data || part).length;
    }
    result.inserted = result.written;
    return result;
  }

  if (table === 'expenses') {
    const dates = records.map(function (r) { return r.date; }).sort();
    const existingRes = await sbSelectAll(cfg, 'expenses', {
      select: 'date,item,amount,store',
      filters: [['date', 'gte', dates[0]], ['date', 'lte', dates[dates.length - 1]]]
    });
    if (!existingRes.ok) throw new ImportError('지출 목록을 읽지 못했어요: ' + (existingRes.error && existingRes.error.message));
    const seen = {};
    (existingRes.data || []).forEach(function (r) {
      seen[r.date + '|' + r.item + '|' + r.amount + '|' + r.store] = true;
    });
    const fresh = [];
    records.forEach(function (r) {
      const key = r.date + '|' + r.item + '|' + r.amount + '|' + r.store;
      if (seen[key]) { result.skipped += 1; return; }
      seen[key] = true;
      fresh.push(r);
    });
    for (const part of chunk(fresh, 200)) {
      const res = await sbInsert(cfg, 'expenses', part);
      if (!res.ok) throw new ImportError('지출 저장 실패: ' + (res.error && res.error.message));
      result.written += (res.data || part).length;
    }
    result.inserted = result.written;
    return result;
  }

  throw new ImportError('가져올 수 없는 표예요: ' + table);
}

export const IMPORT_TABLES = Object.keys(FIELDS);
export { STORES };
