// Netlify Function: /.netlify/functions/admin-api
//
// 전용 관리자(/admin) 페이지가 쓰는 데이터 API. 로그인 쿠키(admin-auth 가 발급)가
// 있어야만 호출된다. 모든 접근은 서버에서 서비스 롤 키로만 Supabase 에 닿는다.
//
//   ?resource=bookings  GET(list) POST(upsert) PATCH(update) DELETE
//   ?resource=customers GET(list/search) POST PATCH DELETE
//   ?resource=payments  GET(list/day) POST(upsert) PATCH DELETE
//   ?resource=expenses  GET(list) POST DELETE
//   ?resource=summary   GET 매출/정산 요약 (+ 최근 N개월 추이)
//   ?resource=export    GET CSV 내보내기 (예약/고객/결제/지출)
//   ?resource=import    POST CSV 일괄 가져오기 (Airtable 이관용)
//   ?resource=tax       GET 홈택스 세금계산서 업로드용 CSV
//
// 필요한 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_SESSION_SECRET

import { json, readJson, readBodyText, notConfigured } from '../lib/http.js';
import {
  supabaseConfig, sbSelect, sbSelectAll, sbUpsert, sbInsert, sbPatch, sbDelete
} from '../lib/supabase.js';
import { sessionFromRequest } from '../lib/session.js';
import { toCsv } from '../lib/csv.js';
import {
  CSV_HEADERS, rowToCsv, sortRows, TAX_HEADERS, taxRowForPayment, TABLE_LABEL, STORES, STATUSES
} from '../lib/tables.js';
import { applyImport, ImportError, IMPORT_TABLES } from '../lib/import-tables.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// 형식뿐 아니라 실제 달력에 있는 날짜인지까지 확인한다 (2026-13-01 같은 값 거절)
function isIsoDate(v) {
  const s = String(v == null ? '' : v);
  if (!ISO_DATE.test(s)) return false;
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const TIME_END = /^[0-4][0-9]:[0-5][0-9]$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const KEY = /^[A-Za-z0-9_-]{1,120}$/;

function unauthorized() {
  return json({ error: 'unauthorized', message: '관리자 로그인이 필요해요.' }, 401);
}
function bad(message) {
  return json({ error: 'bad_request', message: message }, 400);
}
function dbFail(res, what) {
  const msg = res && res.error && res.error.message ? res.error.message : 'Supabase 요청 실패';
  return json({ error: 'db_error', what: what, message: what + ' 실패: ' + msg }, 502);
}
function notAllowed(allow) {
  return json({ error: 'method_not_allowed' }, 405, { allow: allow });
}
function pick(obj, keys) {
  const out = {};
  keys.forEach(function (k) { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
}
function str(v, max) {
  const s = String(v == null ? '' : v);
  return s.length > (max || 2000) ? s.slice(0, max || 2000) : s;
}
function amountOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,\s원]/g, ''));
  return isFinite(n) ? Math.round(n) : NaN;
}

// ---------------------------------------------------------------- 예약
const BOOKING_FIELDS = ['book_key', 'store', 'date', 'start_time', 'end_time', 'name', 'phone4', 'party', 'note'];

function normalizeBooking(body, partial) {
  const out = pick(body, BOOKING_FIELDS);
  if (out.store !== undefined && STORES.indexOf(out.store) < 0) return { error: '매장은 1호점/2호점이어야 해요.' };
  if (out.date !== undefined && !isIsoDate(out.date)) return { error: '날짜 형식이 올바르지 않아요 (YYYY-MM-DD).' };
  if (out.start_time !== undefined && !TIME.test(String(out.start_time))) return { error: '시작 시간 형식이 올바르지 않아요 (HH:MM).' };
  if (out.end_time !== undefined && !TIME_END.test(String(out.end_time))) return { error: '종료 시간 형식이 올바르지 않아요 (HH:MM, 자정 넘김은 24:00 이상).' };
  if (out.book_key !== undefined) out.book_key = str(out.book_key, 120);
  ['name', 'phone4', 'party', 'note'].forEach(function (k) { if (out[k] !== undefined) out[k] = str(out[k], 500); });
  if (!partial) {
    ['store', 'date', 'start_time', 'end_time'].forEach(function (k) {
      if (out[k] === undefined || out[k] === '') out.__missing = k;
    });
  }
  return { row: out };
}

async function bookingsRoute(req, url, cfg) {
  const p = url.searchParams;
  if (req.method === 'GET') {
    const filters = [];
    const from = p.get('from'), to = p.get('to'), store = p.get('store');
    if (from && isIsoDate(from)) filters.push(['date', 'gte', from]);
    if (to && isIsoDate(to)) filters.push(['date', 'lte', to]);
    if (store && STORES.indexOf(store) >= 0) filters.push(['store', 'eq', store]);
    const res = await sbSelectAll(cfg, 'bookings', {
      select: 'id,book_key,store,date,start_time,end_time,name,phone4,party,note',
      filters: filters,
      order: 'date.asc,start_time.asc'
    });
    if (!res.ok) return dbFail(res, '예약 조회');
    return json({ rows: res.data || [] });
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    const body = await readJson(req);
    if (!body) return bad('요청 본문을 읽지 못했어요.');
    const norm = normalizeBooking(body, req.method === 'PATCH');
    if (norm.error) return bad(norm.error);
    const row = norm.row;
    if (row.__missing) return bad('필수 값이 빠졌어요: ' + row.__missing);
    delete row.__missing;

    if (req.method === 'POST') {
      if (!row.book_key) row.book_key = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const res = await sbUpsert(cfg, 'bookings', [row], { onConflict: 'book_key' });
      if (!res.ok) return dbFail(res, '예약 저장');
      return json({ row: (res.data || [])[0] || null });
    }

    let filters;
    if (p.get('book_key')) {
      if (!KEY.test(p.get('book_key'))) return bad('예약키 형식이 올바르지 않아요.');
      filters = [['book_key', 'eq', p.get('book_key')]];
    } else if (p.get('id')) {
      if (!UUID.test(p.get('id'))) return bad('예약 id 형식이 올바르지 않아요.');
      filters = [['id', 'eq', p.get('id')]];
    } else {
      return bad('수정할 예약(book_key 또는 id)을 지정해주세요.');
    }
    if (!Object.keys(row).length) return bad('바꿀 값이 없어요.');
    const res = await sbPatch(cfg, 'bookings', filters, row);
    if (!res.ok) return dbFail(res, '예약 수정');
    if (!(res.data || []).length) return json({ error: 'not_found', message: '해당 예약을 찾지 못했어요.' }, 404);
    return json({ row: res.data[0] });
  }

  if (req.method === 'DELETE') {
    const bookKey = p.get('book_key');
    const id = p.get('id');
    if (!bookKey && !id) return bad('삭제할 예약(book_key 또는 id)을 지정해주세요.');
    if (bookKey && !KEY.test(bookKey)) return bad('예약키 형식이 올바르지 않아요.');
    if (!bookKey && !UUID.test(id)) return bad('예약 id 형식이 올바르지 않아요.');
    const filters = bookKey ? [['book_key', 'eq', bookKey]] : [['id', 'eq', id]];
    let key = bookKey;
    if (!key) {
      const found = await sbSelect(cfg, 'bookings', { select: 'book_key', filters: filters });
      if (found.ok && (found.data || []).length) key = found.data[0].book_key;
    }
    const res = await sbDelete(cfg, 'bookings', filters);
    if (!res.ok) return dbFail(res, '예약 삭제');
    let paymentDeleted = false;
    // 예약을 지우면 그 예약에 딸린 결제기록도 함께 지운다(기존 관리자 화면과 같은 동작).
    if (key && p.get('keepPayment') !== '1') {
      const del = await sbDelete(cfg, 'payments', [['pay_key', 'eq', key]]);
      paymentDeleted = del.ok;
    }
    return json({ deleted: (res.data || []).length, paymentDeleted: paymentDeleted });
  }

  return notAllowed('GET, POST, PATCH, DELETE');
}

// ---------------------------------------------------------------- 고객
async function customersRoute(req, url, cfg) {
  const p = url.searchParams;
  if (req.method === 'GET') {
    const q = String(p.get('q') || '').normalize('NFC').trim();
    const filters = [];
    const raw = {};
    if (q) {
      const safe = q.replace(/[,()*]/g, ' ').trim();
      raw.or = '(name.ilike.*' + safe + '*,phone.ilike.*' + safe + '*)';
    }
    const res = q
      ? await sbSelect(cfg, 'customers', {
        select: 'id,name,phone,biz_no,biz_name,biz_owner,email,note',
        raw: raw, order: 'name.asc', limit: 30
      })
      : await sbSelectAll(cfg, 'customers', {
        select: 'id,name,phone,biz_no,biz_name,biz_owner,email,note', order: 'name.asc'
      });
    if (!res.ok) return dbFail(res, '고객 조회');
    return json({ rows: res.data || [] });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return bad('요청 본문을 읽지 못했어요.');
    const name = str(body.name, 200).trim();
    if (!name) return bad('고객 이름을 입력해주세요.');
    const row = {
      name: name,
      phone: str(body.phone, 40).trim(),
      biz_no: str(body.biz_no, 40).trim(),
      biz_name: str(body.biz_name, 200).trim(),
      biz_owner: str(body.biz_owner, 200).trim(),
      email: str(body.email, 200).trim(),
      note: str(body.note, 2000).trim()
    };
    const res = await sbInsert(cfg, 'customers', [row]);
    if (!res.ok) return dbFail(res, '고객 등록');
    return json({ row: (res.data || [])[0] || null });
  }

  if (req.method === 'PATCH') {
    const id = p.get('id');
    if (!id) return bad('수정할 고객 id 를 지정해주세요.');
    if (!UUID.test(id)) return bad('고객 id 형식이 올바르지 않아요.');
    const body = await readJson(req);
    if (!body) return bad('요청 본문을 읽지 못했어요.');
    const row = {};
    ['name', 'phone', 'biz_no', 'biz_name', 'biz_owner', 'email', 'note'].forEach(function (k) {
      if (body[k] !== undefined) row[k] = str(body[k], k === 'note' ? 2000 : 200).trim();
    });
    if (row.name === '') return bad('고객 이름은 비울 수 없어요.');
    if (!Object.keys(row).length) return bad('바꿀 값이 없어요.');
    const res = await sbPatch(cfg, 'customers', [['id', 'eq', id]], row);
    if (!res.ok) return dbFail(res, '고객 수정');
    if (!(res.data || []).length) return json({ error: 'not_found', message: '해당 고객을 찾지 못했어요.' }, 404);
    return json({ row: res.data[0] });
  }

  if (req.method === 'DELETE') {
    const id = p.get('id');
    if (!id) return bad('삭제할 고객 id 를 지정해주세요.');
    if (!UUID.test(id)) return bad('고객 id 형식이 올바르지 않아요.');
    const res = await sbDelete(cfg, 'customers', [['id', 'eq', id]]);
    if (!res.ok) return dbFail(res, '고객 삭제');
    return json({ deleted: (res.data || []).length });
  }

  return notAllowed('GET, POST, PATCH, DELETE');
}

// ---------------------------------------------------------------- 결제기록
const PAYMENT_SELECT = '*,customer:customers(id,name,phone)';

function normalizePayment(body) {
  if (body.store !== undefined && STORES.indexOf(body.store) < 0) return { error: '매장은 1호점/2호점이어야 해요.' };
  if (body.date !== undefined && !isIsoDate(body.date)) return { error: '날짜 형식이 올바르지 않아요 (YYYY-MM-DD).' };
  if (body.start_time !== undefined && !TIME.test(String(body.start_time))) return { error: '시작 시간 형식이 올바르지 않아요.' };
  if (body.end_time !== undefined && !TIME_END.test(String(body.end_time))) return { error: '종료 시간 형식이 올바르지 않아요.' };
  if (body.status !== undefined && STATUSES.indexOf(body.status) < 0) return { error: '발행상태가 올바르지 않아요.' };
  const row = {};
  ['pay_key', 'store', 'date', 'start_time', 'end_time', 'customer_id', 'status', 'biz_no', 'biz_name', 'biz_owner', 'email', 'alt_phone', 'note'].forEach(function (k) {
    if (body[k] !== undefined) row[k] = body[k] === null ? '' : str(body[k], k === 'note' ? 2000 : 200);
  });
  if (body.customer_id !== undefined) row.customer_id = body.customer_id || null;
  if (body.amount !== undefined) {
    const a = amountOrNull(body.amount);
    if (isNaN(a)) return { error: '결제금액을 숫자로 입력해주세요.' };
    row.amount = a;
  }
  if (body.paid !== undefined) row.paid = !!body.paid;
  if (body.sms !== undefined) row.sms = !!body.sms;
  return { row: row };
}

async function paymentsRoute(req, url, cfg) {
  const p = url.searchParams;
  if (req.method === 'GET') {
    const filters = [];
    const date = p.get('date'), store = p.get('store');
    const from = p.get('from'), to = p.get('to');
    if (date && isIsoDate(date)) filters.push(['date', 'eq', date]);
    if (from && isIsoDate(from)) filters.push(['date', 'gte', from]);
    if (to && isIsoDate(to)) filters.push(['date', 'lte', to]);
    if (store && STORES.indexOf(store) >= 0) filters.push(['store', 'eq', store]);
    const res = await sbSelectAll(cfg, 'payments', {
      select: PAYMENT_SELECT,
      filters: filters,
      order: 'date.asc,start_time.asc'
    });
    if (!res.ok) return dbFail(res, '결제기록 조회');
    return json({ rows: res.data || [] });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return bad('요청 본문을 읽지 못했어요.');
    const norm = normalizePayment(body);
    if (norm.error) return bad(norm.error);
    const row = norm.row;
    if (!row.pay_key) return bad('예약키(pay_key)가 필요해요.');
    ['store', 'date', 'start_time', 'end_time'].forEach(function (k) {
      if (!row[k]) row.__missing = k;
    });
    if (row.__missing) return bad('필수 값이 빠졌어요: ' + row.__missing);
    delete row.__missing;
    if (row.status === undefined) row.status = '발행안함';
    const res = await sbUpsert(cfg, 'payments', [row], { onConflict: 'pay_key' });
    if (!res.ok) return dbFail(res, '결제기록 저장');
    return json({ row: (res.data || [])[0] || null });
  }

  if (req.method === 'PATCH') {
    const id = p.get('id');
    if (!id) return bad('수정할 결제기록 id 를 지정해주세요.');
    if (!UUID.test(id)) return bad('결제기록 id 형식이 올바르지 않아요.');
    const body = await readJson(req);
    if (!body) return bad('요청 본문을 읽지 못했어요.');
    const norm = normalizePayment(body);
    if (norm.error) return bad(norm.error);
    if (!Object.keys(norm.row).length) return bad('바꿀 값이 없어요.');
    const res = await sbPatch(cfg, 'payments', [['id', 'eq', id]], norm.row);
    if (!res.ok) return dbFail(res, '결제기록 수정');
    if (!(res.data || []).length) return json({ error: 'not_found', message: '해당 결제기록을 찾지 못했어요.' }, 404);
    return json({ row: res.data[0] });
  }

  if (req.method === 'DELETE') {
    const id = p.get('id'), payKey = p.get('pay_key');
    if (!id && !payKey) return bad('삭제할 결제기록(id 또는 pay_key)을 지정해주세요.');
    if (id && !UUID.test(id)) return bad('결제기록 id 형식이 올바르지 않아요.');
    if (!id && !KEY.test(payKey)) return bad('예약키 형식이 올바르지 않아요.');
    const filters = id ? [['id', 'eq', id]] : [['pay_key', 'eq', payKey]];
    const res = await sbDelete(cfg, 'payments', filters);
    if (!res.ok) return dbFail(res, '결제기록 삭제');
    return json({ deleted: (res.data || []).length });
  }

  return notAllowed('GET, POST, PATCH, DELETE');
}

// ---------------------------------------------------------------- 지출
async function expensesRoute(req, url, cfg) {
  const p = url.searchParams;
  if (req.method === 'GET') {
    const filters = [];
    const from = p.get('from'), to = p.get('to');
    if (from && isIsoDate(from)) filters.push(['date', 'gte', from]);
    if (to && isIsoDate(to)) filters.push(['date', 'lte', to]);
    const res = await sbSelectAll(cfg, 'expenses', {
      select: 'id,date,item,amount,store,note',
      filters: filters,
      order: 'date.asc'
    });
    if (!res.ok) return dbFail(res, '지출 조회');
    return json({ rows: res.data || [] });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return bad('요청 본문을 읽지 못했어요.');
    if (!isIsoDate(String(body.date || ''))) return bad('날짜를 선택해주세요.');
    const amount = amountOrNull(body.amount);
    if (isNaN(amount) || amount === null || amount < 0) return bad('금액을 숫자로 입력해주세요.');
    const item = str(body.item, 200).trim();
    if (!item) return bad('항목명을 입력해주세요.');
    const store = body.store && ['1호점', '2호점', '공통'].indexOf(body.store) >= 0 ? body.store : '공통';
    const res = await sbInsert(cfg, 'expenses', [{
      date: body.date, item: item, amount: amount, store: store, note: str(body.note, 2000).trim()
    }]);
    if (!res.ok) return dbFail(res, '지출 저장');
    return json({ row: (res.data || [])[0] || null });
  }

  if (req.method === 'DELETE') {
    const id = p.get('id');
    if (!id) return bad('삭제할 지출 id 를 지정해주세요.');
    if (!UUID.test(id)) return bad('지출 id 형식이 올바르지 않아요.');
    const res = await sbDelete(cfg, 'expenses', [['id', 'eq', id]]);
    if (!res.ok) return dbFail(res, '지출 삭제');
    return json({ deleted: (res.data || []).length });
  }

  return notAllowed('GET, POST, DELETE');
}

// ---------------------------------------------------------------- 매출 요약
function monthRange(iso) {
  const p = String(iso).split('-').map(Number);
  const y = p[0], m = p[1];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: y + '-' + (m < 10 ? '0' : '') + m + '-01', to: y + '-' + (m < 10 ? '0' : '') + m + '-' + (last < 10 ? '0' : '') + last };
}
function monthKey(iso) { return String(iso).slice(0, 7); }
function addMonths(ym, delta) {
  const p = ym.split('-').map(Number);
  let y = p[0], m = p[1] + delta;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return y + '-' + (m < 10 ? '0' : '') + m;
}
function emptyStoreStats() { return { tax: 0, cash: 0, card: 0, none: 0, total: 0 }; }
function statusKey(status) {
  if (status === '세금계산서발행') return 'tax';
  if (status === '현금영수증발행') return 'cash';
  if (status === '카드결제') return 'card';
  return 'none';
}
function storeKey(store) { return store === '1호점' ? 'first' : (store === '2호점' ? 'second' : null); }

async function summaryRoute(req, url, cfg) {
  if (req.method !== 'GET') return notAllowed('GET');
  const p = url.searchParams;
  const from = isIsoDate(p.get('from')) ? p.get('from') : monthRange(new Date().toISOString().slice(0, 10)).from;
  const to = isIsoDate(p.get('to')) ? p.get('to') : monthRange(new Date().toISOString().slice(0, 10)).to;
  const months = Math.min(Math.max(parseInt(p.get('months') || '12', 10) || 12, 1), 24);

  const payRes = await sbSelectAll(cfg, 'payments', {
    select: 'store,date,amount,status,paid',
    filters: [['date', 'gte', from], ['date', 'lte', to]]
  });
  if (!payRes.ok) return dbFail(payRes, '결제기록 조회');
  const expRes = await sbSelectAll(cfg, 'expenses', {
    select: 'id,date,item,amount,store,note',
    filters: [['date', 'gte', from], ['date', 'lte', to]],
    order: 'date.asc'
  });
  if (!expRes.ok) return dbFail(expRes, '지출 조회');

  const stores = { first: emptyStoreStats(), second: emptyStoreStats() };
  let paidTotal = 0, unpaidTotal = 0;
  (payRes.data || []).forEach(function (r) {
    const sk = storeKey(r.store);
    if (!sk) return;
    const amt = Number(r.amount) || 0;
    const key = statusKey(r.status);
    stores[sk][key] += amt;
    stores[sk].total += amt;
    if (r.paid) paidTotal += amt; else unpaidTotal += amt;
  });
  const total = emptyStoreStats();
  ['tax', 'cash', 'card', 'none', 'total'].forEach(function (k) { total[k] = stores.first[k] + stores.second[k]; });
  const vat = Math.round((total.tax + total.cash + total.card) * 0.1);

  const expenses = expRes.data || [];
  const expenseTotal = expenses.reduce(function (s, r) { return s + (Number(r.amount) || 0); }, 0);

  // 최근 N개월 추이
  const endMonth = monthKey(to);
  const startMonth = addMonths(endMonth, -(months - 1));
  const trendFrom = startMonth + '-01';
  let trend = [];
  if (trendFrom < from) {
    const tRes = await sbSelectAll(cfg, 'payments', {
      select: 'store,date,amount',
      filters: [['date', 'gte', trendFrom], ['date', 'lte', to]]
    });
    if (!tRes.ok) return dbFail(tRes, '월별 매출 조회');
    const byMonth = {};
    (tRes.data || []).forEach(function (r) {
      const k = monthKey(r.date);
      if (!byMonth[k]) byMonth[k] = { first: 0, second: 0 };
      const sk = storeKey(r.store);
      if (sk) byMonth[k][sk] += Number(r.amount) || 0;
    });
    trend = [];
    for (let i = 0; i < months; i++) {
      const k = addMonths(startMonth, i);
      const v = byMonth[k] || { first: 0, second: 0 };
      trend.push({ month: k, first: v.first, second: v.second, total: v.first + v.second });
    }
  } else {
    const byMonth = {};
    (payRes.data || []).forEach(function (r) {
      const k = monthKey(r.date);
      if (!byMonth[k]) byMonth[k] = { first: 0, second: 0 };
      const sk = storeKey(r.store);
      if (sk) byMonth[k][sk] += Number(r.amount) || 0;
    });
    for (let i = 0; i < months; i++) {
      const k = addMonths(endMonth, -(months - 1) + i);
      const v = byMonth[k] || { first: 0, second: 0 };
      trend.push({ month: k, first: v.first, second: v.second, total: v.first + v.second });
    }
  }

  return json({
    from: from, to: to,
    stores: stores, total: total,
    revenue: total.total,
    vat: vat,
    paidTotal: paidTotal, unpaidTotal: unpaidTotal,
    expenses: expenses,
    expenseTotal: expenseTotal,
    net: total.total - expenseTotal,
    trend: trend
  });
}

// ---------------------------------------------------------------- CSV 내보내기 / 가져오기 / 세금계산서
function csvResponse(rows, filename) {
  const body = '\uFEFF' + toCsv(rows);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename)
    }
  });
}

async function exportRoute(req, url, cfg) {
  if (req.method !== 'GET') return notAllowed('GET');
  const p = url.searchParams;
  const table = String(p.get('table') || '');
  if (!CSV_HEADERS[table]) return bad('내보낼 표를 지정해주세요 (bookings/customers/payments/expenses).');
  const filters = [];
  const from = p.get('from'), to = p.get('to');
  if (from && isIsoDate(from)) filters.push(['date', 'gte', from]);
  if (to && isIsoDate(to)) filters.push(['date', 'lte', to]);

  const opts = { filters: filters };
  if (table === 'payments') opts.select = PAYMENT_SELECT;
  const res = await sbSelectAll(cfg, table, opts);
  if (!res.ok) return dbFail(res, TABLE_LABEL[table] + ' 조회');

  const header = CSV_HEADERS[table];
  const lines = [header];
  sortRows(table, res.data || []).forEach(function (r) { lines.push(rowToCsv(table, r)); });
  const today = new Date().toISOString().slice(0, 10);
  return csvResponse(lines, 'unscented_' + TABLE_LABEL[table] + '_' + today + '.csv');
}

async function importRoute(req, url, cfg) {
  if (req.method !== 'POST') return notAllowed('POST');
  const table = String(url.searchParams.get('table') || '');
  if (IMPORT_TABLES.indexOf(table) < 0) return bad('가져올 표를 지정해주세요 (bookings/customers/payments/expenses).');
  let csvText = '';
  const contentType = String(req.headers.get('content-type') || '');
  if (contentType.indexOf('application/json') >= 0) {
    const body = await readJson(req);
    if (body === null) return bad('요청 본문을 읽지 못했어요.');
    csvText = String(body.csv || '');
  } else {
    csvText = await readBodyText(req);
  }
  if (!csvText.trim()) return bad('CSV 내용이 비어 있어요.');
  try {
    const result = await applyImport(cfg, table, csvText);
    return json(result);
  } catch (e) {
    if (e instanceof ImportError) return json({ error: 'import_failed', message: e.message }, 400);
    throw e;
  }
}

async function taxRoute(req, url, cfg) {
  if (req.method !== 'GET') return notAllowed('GET');
  const p = url.searchParams;
  const from = p.get('from'), to = p.get('to');
  if (!isIsoDate(from) || !isIsoDate(to)) return bad('시작일과 종료일을 선택해주세요.');
  if (from > to) return bad('시작일이 종료일보다 늦을 수 없어요.');
  const res = await sbSelectAll(cfg, 'payments', {
    select: 'date,amount,status,biz_no,biz_name,biz_owner,email,store',
    filters: [['date', 'gte', from], ['date', 'lte', to], ['status', 'eq', '세금계산서발행']],
    order: 'date.asc'
  });
  if (!res.ok) return dbFail(res, '세금계산서 대상 조회');
  const rows = res.data || [];
  const lines = [TAX_HEADERS];
  rows.forEach(function (r) { lines.push(taxRowForPayment(r)); });
  if (!rows.length) return json({ error: 'empty', message: '해당 기간에 "세금계산서발행"으로 등록된 결제기록이 없어요.' }, 404);
  return csvResponse(lines, 'unscented_세금계산서_' + from + '_' + to + '.csv');
}

// ---------------------------------------------------------------- 진입점
export default async (req) => {
  const session = sessionFromRequest(req);
  if (!session.ok) {
    if (session.reason === 'no_secret') {
      return notConfigured(['ADMIN_SESSION_SECRET'], '관리자 API');
    }
    return unauthorized();
  }
  const cfg = supabaseConfig();
  if (!cfg.ok) return notConfigured(cfg.missing, '관리자 API');

  const url = new URL(req.url);
  const resource = String(url.searchParams.get('resource') || '');

  try {
    switch (resource) {
      case 'bookings': return await bookingsRoute(req, url, cfg);
      case 'customers': return await customersRoute(req, url, cfg);
      case 'payments': return await paymentsRoute(req, url, cfg);
      case 'expenses': return await expensesRoute(req, url, cfg);
      case 'summary': return await summaryRoute(req, url, cfg);
      case 'export': return await exportRoute(req, url, cfg);
      case 'import': return await importRoute(req, url, cfg);
      case 'tax': return await taxRoute(req, url, cfg);
      default:
        return bad('알 수 없는 요청이에요. resource=bookings|customers|payments|expenses|summary|export|import|tax');
    }
  } catch (err) {
    return json({ error: 'server_error', message: String(err && err.message ? err.message : err) }, 500);
  }
};
