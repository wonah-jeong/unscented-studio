import { test } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../netlify/functions/admin-api.js';
import { clearEnv, setEnv, mockFetch, jsonRes, sessionCookieHeader } from './helpers.js';

const FN = 'https://unscented.test/.netlify/functions/admin-api';
const SB = 'https://test-project.supabase.co/rest/v1/';

function call(query, opts) {
  const o = opts || {};
  const headers = Object.assign({ cookie: sessionCookieHeader() }, o.headers || {});
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  return handler(new Request(FN + '?' + query, {
    method: o.method || 'GET',
    headers: headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body)
  }));
}

test('로그인 쿠키가 없으면 모든 요청을 401 로 막는다', async function () {
  setEnv();
  const res = await handler(new Request(FN + '?resource=bookings', { headers: {} }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
  clearEnv();
});

test('ADMIN_SESSION_SECRET 이 없으면 설정 안내를 준다', async function () {
  setEnv({ ADMIN_SESSION_SECRET: undefined });
  const res = await handler(new Request(FN + '?resource=bookings', { headers: { cookie: 'unscented_admin=x' } }));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'not_configured');
  assert.deepEqual(body.missing, ['ADMIN_SESSION_SECRET']);
  clearEnv();
});

test('Supabase 환경변수가 없으면 설정 안내를 준다', async function () {
  setEnv({ SUPABASE_URL: undefined });
  const res = await call('resource=bookings');
  assert.equal(res.status, 500);
  assert.deepEqual((await res.json()).missing, ['SUPABASE_URL']);
  clearEnv();
});

test('예약 목록: 기간·지점 조건을 PostgREST 쿼리로 옮긴다', async function () {
  setEnv();
  const calls = mockFetch(function (url) {
    assert.ok(url.indexOf(SB + 'bookings') === 0, url);
    return jsonRes([{ id: 'u1', book_key: 'r1', store: '1호점', date: '2026-11-24', start_time: '10:00', end_time: '12:00', name: '김수', phone4: '1234', party: '2', note: '메모' }]);
  });
  try {
    const res = await call('resource=bookings&from=2026-11-01&to=2026-11-30&store=1호점');
    const body = await res.json();
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].note, '메모');
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get('date'), 'gte.2026-11-01');
    assert.equal(u.searchParams.get('date'), 'gte.2026-11-01');
    assert.equal(u.searchParams.getAll('date').indexOf('lte.2026-11-30') >= 0, true);
    assert.equal(u.searchParams.get('store'), 'eq.1호점');
    assert.equal(calls[0].header('apikey'), 'service-role-test-key');
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('예약 저장은 book_key 기준 upsert(중복 방지)', async function () {
  setEnv();
  const calls = mockFetch(function (url, init) {
    return jsonRes([JSON.parse(init.body)[0]]);
  });
  try {
    const res = await call('resource=bookings', {
      method: 'POST',
      body: { book_key: 'r-abc', store: '2호점', date: '2026-11-25', start_time: '22:00', end_time: '25:30', name: '홍길동', phone4: '5678', party: '3', note: '늦은 퇴실' }
    });
    assert.equal(res.status, 200);
    const u = new URL(calls[0].url);
    assert.equal(calls[0].method, 'POST');
    assert.equal(u.searchParams.get('on_conflict'), 'book_key');
    assert.match(calls[0].header('Prefer'), /resolution=merge-duplicates/);
    const sent = JSON.parse(calls[0].body);
    assert.equal(sent[0].end_time, '25:30');
    assert.equal(sent[0].store, '2호점');
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('예약 입력값 검증: 매장/날짜/시간 형식이 틀리면 400', async function () {
  setEnv();
  const bad1 = await call('resource=bookings', { method: 'POST', body: { store: '3호점', date: '2026-11-25', start_time: '10:00', end_time: '11:00' } });
  assert.equal(bad1.status, 400);
  const bad2 = await call('resource=bookings', { method: 'POST', body: { store: '1호점', date: '2026-13-01', start_time: '10:00', end_time: '11:00' } });
  assert.equal(bad2.status, 400);
  const bad3 = await call('resource=bookings', { method: 'POST', body: { store: '1호점', date: '2026-11-25', start_time: '9:00', end_time: '11:00' } });
  assert.equal(bad3.status, 400);
  const bad4 = await call('resource=bookings', { method: 'POST', body: { store: '1호점', date: '2026-11-25', start_time: '10:00' } });
  assert.equal(bad4.status, 400);
  assert.match((await bad4.json()).message, /end_time/);
  clearEnv();
});

test('예약 삭제는 결제기록도 함께 지운다', async function () {
  setEnv();
  const calls = mockFetch(function (url, init) {
    assert.equal(init.method, 'DELETE');
    return jsonRes([{}]);
  });
  try {
    const res = await call('resource=bookings&book_key=r-abc', { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deleted, 1);
    assert.equal(body.paymentDeleted, true);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/bookings\?book_key=eq\.r-abc/);
    assert.match(calls[1].url, /\/payments\?pay_key=eq\.r-abc/);
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('고객 검색은 이름·연락처 부분일치 or 조건을 쓴다', async function () {
  setEnv();
  const calls = mockFetch(function () {
    return jsonRes([{ id: 'c1', name: '김수현', phone: '010-1234-5678' }]);
  });
  try {
    const res = await call('resource=customers&q=' + encodeURIComponent('김수'));
    const body = await res.json();
    assert.equal(body.rows.length, 1);
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get('or'), '(name.ilike.*김수*,phone.ilike.*김수*)');
    assert.equal(u.searchParams.get('limit'), '30');
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('고객 등록/수정/삭제', async function () {
  setEnv();
  const calls = mockFetch(function (url, init) {
    if (init.method === 'POST') return jsonRes([{ id: 'c9', name: '새고객', phone: '010-0000-1111' }]);
    return jsonRes([{ id: 'c9' }]);
  });
  try {
    const created = await call('resource=customers', { method: 'POST', body: { name: '새고객', phone: '010-0000-1111' } });
    assert.equal((await created.json()).row.id, 'c9');
    assert.equal(JSON.parse(calls[0].body)[0].name, '새고객');

    const patched = await call('resource=customers&id=11111111-1111-4111-8111-111111111111', { method: 'PATCH', body: { phone: '010-2222-3333' } });
    assert.equal(patched.status, 200);
    assert.match(calls[1].url, /id=eq\.11111111-1111-4111-8111-111111111111/);

    const del = await call('resource=customers&id=11111111-1111-4111-8111-111111111111', { method: 'DELETE' });
    assert.equal(del.status, 200);

    const noName = await call('resource=customers', { method: 'POST', body: { name: '  ' } });
    assert.equal(noName.status, 400);
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('결제기록: 하루치 조회(고객 조인), 저장(upsert), 입금완료 토글', async function () {
  setEnv();
  const calls = mockFetch(function (url, init) {
    if (init.method === 'PATCH') return jsonRes([{ id: 'p1', paid: true }]);
    if (init.method === 'POST') return jsonRes([{ id: 'p1' }]);
    return jsonRes([{ id: 'p1', pay_key: 'r1', store: '1호점', date: '2026-11-24', amount: 150000, status: '세금계산서발행', paid: false, customer: { id: 'c1', name: '김수현', phone: '010-1234-5678' } }]);
  });
  try {
    const list = await call('resource=payments&date=2026-11-24&store=1호점');
    const body = await list.json();
    assert.equal(body.rows[0].customer.name, '김수현');
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get('date'), 'eq.2026-11-24');
    assert.equal(u.searchParams.get('store'), 'eq.1호점');
    assert.match(u.searchParams.get('select'), /customer:customers/);

    const saved = await call('resource=payments', {
      method: 'POST',
      body: {
        pay_key: 'r1', store: '1호점', date: '2026-11-24', start_time: '10:00', end_time: '12:00',
        customer_id: 'c1', amount: 150000, status: '세금계산서발행', paid: false
      }
    });
    assert.equal(saved.status, 200);
    assert.equal(new URL(calls[1].url).searchParams.get('on_conflict'), 'pay_key');

    const toggle = await call('resource=payments&id=11111111-1111-4111-8111-111111111111', { method: 'PATCH', body: { paid: true } });
    assert.equal((await toggle.json()).row.paid, true);

    const badStatus = await call('resource=payments', {
      method: 'POST',
      body: { pay_key: 'r1', store: '1호점', date: '2026-11-24', start_time: '10:00', end_time: '12:00', status: '몰라' }
    });
    assert.equal(badStatus.status, 400);
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('지출: 등록·조회·삭제와 입력 검증', async function () {
  setEnv();
  const calls = mockFetch(function (url, init) {
    if (init.method === 'POST') return jsonRes([{ id: 'e1' }]);
    if (init.method === 'DELETE') return jsonRes([{ id: 'e1' }]);
    return jsonRes([{ id: 'e1', date: '2026-11-05', item: '임대료', amount: 500000, store: '공통', note: '' }]);
  });
  try {
    const list = await call('resource=expenses&from=2026-11-01&to=2026-11-30');
    assert.equal((await list.json()).rows.length, 1);

    const created = await call('resource=expenses', { method: 'POST', body: { date: '2026-11-05', item: '임대료', amount: '500,000', store: '공통' } });
    assert.equal(created.status, 200);
    assert.equal(JSON.parse(calls[1].body)[0].amount, 500000);

    const noAmount = await call('resource=expenses', { method: 'POST', body: { date: '2026-11-05', item: '임대료', amount: '' } });
    assert.equal(noAmount.status, 400);

    const del = await call('resource=expenses&id=11111111-1111-4111-8111-111111111111', { method: 'DELETE' });
    assert.equal(del.status, 200);
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('매출 요약: 매장별·발행상태별 합계, 부가세, 비용, 순매출, 12개월 추이', async function () {
  setEnv();
  const calls = mockFetch(function (url) {
    const u = new URL(url);
    const select = u.searchParams.get('select') || '';
    if (u.pathname.indexOf('/payments') >= 0) {
      if (select === 'store,date,amount') {
        // 추이용(12개월)
        return jsonRes([
          { store: '1호점', date: '2026-10-10', amount: 1000000 },
          { store: '2호점', date: '2026-10-11', amount: 500000 },
          { store: '1호점', date: '2026-11-10', amount: 300000 }
        ]);
      }
      return jsonRes([
        { store: '1호점', date: '2026-11-02', amount: 100000, status: '세금계산서발행', paid: true },
        { store: '1호점', date: '2026-11-03', amount: 50000, status: '현금영수증발행', paid: false },
        { store: '2호점', date: '2026-11-04', amount: 200000, status: '카드결제', paid: true },
        { store: '2호점', date: '2026-11-05', amount: 30000, status: '발행안함', paid: false }
      ]);
    }
    if (u.pathname.indexOf('/expenses') >= 0) {
      return jsonRes([
        { id: 'e1', date: '2026-11-05', item: '임대료', amount: 120000, store: '공통', note: '' },
        { id: 'e2', date: '2026-11-09', item: '청소', amount: 30000, store: '1호점', note: '' }
      ]);
    }
    throw new Error('unexpected ' + url);
  });
  try {
    const res = await call('resource=summary&from=2026-11-01&to=2026-11-30&months=12');
    const body = await res.json();
    assert.deepEqual(body.stores.first, { tax: 100000, cash: 50000, card: 0, none: 0, total: 150000 });
    assert.deepEqual(body.stores.second, { tax: 0, cash: 0, card: 200000, none: 30000, total: 230000 });
    assert.equal(body.total.total, 380000);
    assert.equal(body.revenue, 380000);
    assert.equal(body.vat, Math.round((100000 + 50000 + 200000) * 0.1));
    assert.equal(body.expenseTotal, 150000);
    assert.equal(body.net, 230000);
    assert.equal(body.paidTotal, 300000);
    assert.equal(body.unpaidTotal, 80000);
    assert.equal(body.trend.length, 12);
    const oct = body.trend.filter(function (t) { return t.month === '2026-10'; })[0];
    assert.deepEqual(oct, { month: '2026-10', first: 1000000, second: 500000, total: 1500000 });
    const nov = body.trend.filter(function (t) { return t.month === '2026-11'; })[0];
    assert.equal(nov.total, 300000);
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('CSV 내보내기: 기존 관리자 화면과 같은 헤더·순서', async function () {
  setEnv();
  const calls = mockFetch(function () {
    return jsonRes([
      { store: '2호점', date: '2026-11-24', start_time: '18:00', end_time: '20:00', name: '나중', phone4: '2222', party: '1', note: '' },
      { store: '1호점', date: '2026-11-24', start_time: '09:00', end_time: '11:00', name: '먼저', phone4: '1111', party: '2', note: '쉼표, 있음' }
    ]);
  });
  try {
    const res = await call('resource=export&table=bookings');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''/);
    // BOM 은 UTF-8 BOM 바이트로 나간다 (text() 는 디코딩하면서 BOM 을 걷어낸다)
    const buf = new Uint8Array(await res.clone().arrayBuffer());
    assert.deepEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf]);
    const text = await res.text();
    const lines = text.split('\r\n');
    assert.equal(lines[0], '매장,날짜,시작,종료,이름,연락처(뒷4자리),인원,메모');
    assert.equal(lines[1], '1호점,2026-11-24,09:00,11:00,먼저,1111,2,"쉼표, 있음"');
    assert.equal(lines[2], '2호점,2026-11-24,18:00,20:00,나중,2222,1,');
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('예약 CSV 가져오기: Airtable 헤더를 읽어 book_key 기준으로 저장', async function () {
  setEnv();
  const calls = mockFetch(function () {
    return jsonRes([{ book_key: 'r1' }, { book_key: 'r2' }]);
  });
  try {
    const csv = '\uFEFF매장,날짜,시작,종료,이름,연락처(뒷4자리),인원,메모\r\n' +
      '1호점,2026-11-24,10:00,12:00,김수,1234,2,"조용히, 부탁"\r\n' +
      '2호점,2026.11.25,22:00,25:30,홍길동,5678,3,\r\n';
    const res = await call('resource=import&table=bookings', { method: 'POST', body: { csv: csv } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.written, 2);
    assert.equal(body.errors.length, 0);
    const sent = JSON.parse(calls[0].body);
    assert.equal(sent[0].note, '조용히, 부탁');
    assert.equal(sent[1].date, '2026-11-25');
    assert.equal(sent[1].end_time, '25:30');
    assert.equal(new URL(calls[0].url).searchParams.get('on_conflict'), 'book_key');
    assert.ok(sent[0].book_key && sent[1].book_key, '예약키가 없으면 새로 만든다');
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('가져오기: 필수 열이 없으면 400 과 안내', async function () {
  setEnv();
  const res = await call('resource=import&table=bookings', {
    method: 'POST',
    body: { csv: '이름,인원\r\n김수,2\r\n' }
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'import_failed');
  assert.match(body.message, /필수 열이 없어요: 날짜, 시작, 종료/);
  clearEnv();
});

test('가져오기: 잘못된 값은 줄 번호와 함께 건너뛴다', async function () {
  setEnv();
  const calls = mockFetch(function () { return jsonRes([{ book_key: 'r1' }]); });
  try {
    const csv = '매장,날짜,시작,종료,이름,연락처(뒷4자리),인원,메모\r\n' +
      '1호점,2026-11-24,10:00,12:00,김수,1234,2,\r\n' +
      '3호점,2026-11-25,10:00,12:00,김수,1234,2,\r\n';
    const res = await call('resource=import&table=bookings', { method: 'POST', body: { csv: csv } });
    const body = await res.json();
    assert.equal(body.written, 1);
    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0].line, 3);
    assert.match(body.errors[0].message, /1호점\/2호점/);
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('세금계산서 CSV: 홈택스 60칸 양식과 공급가액/세액 계산', async function () {
  setEnv();
  const calls = mockFetch(function () {
    return jsonRes([
      { store: '1호점', date: '2026-11-24', amount: 110000, status: '세금계산서발행', biz_no: '123-45-67890', biz_name: '테스트상호', biz_owner: '김대표', email: 'tax@example.com' }
    ]);
  });
  try {
    const res = await call('resource=tax&from=2026-11-01&to=2026-11-30');
    assert.equal(res.status, 200);
    const text = await res.text();
    const lines = text.split('\r\n');
    const header = lines[0].split(',');
    assert.equal(header.length, 59);
    assert.equal(header[0], '전자세금계산서종류');
    assert.equal(header[58], '영수청구');
    const row = lines[1].split(',');
    assert.equal(row.length, 59);
    assert.equal(row[0], '01');
    assert.equal(row[1], '20261130');
    assert.equal(row[2], '7623601014');
    assert.equal(row[10], '1234567890');
    assert.equal(row[19], '100000');
    assert.equal(row[20], '10000');
    assert.equal(row[22], '24');
    assert.equal(row[58], '01');
    assert.equal(new URL(calls[0].url).searchParams.getAll('status')[0], 'eq.세금계산서발행');
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('세금계산서 대상이 없으면 404 안내', async function () {
  setEnv();
  const calls = mockFetch(function () { return jsonRes([]); });
  try {
    const res = await call('resource=tax&from=2026-11-01&to=2026-11-30');
    assert.equal(res.status, 404);
    assert.match((await res.json()).message, /세금계산서발행/);
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('알 수 없는 resource / 메서드는 400·405', async function () {
  setEnv();
  const bad = await call('resource=nope');
  assert.equal(bad.status, 400);
  const wrongMethod = await call('resource=summary', { method: 'POST', body: {} });
  assert.equal(wrongMethod.status, 405);
  clearEnv();
});

test('테이블이 없으면 schema.sql 실행 안내를 준다', async function () {
  setEnv();
  const calls = mockFetch(function () {
    return jsonRes({ code: 'PGRST205', message: "Could not find the table 'public.bookings' in the schema cache" }, 404);
  });
  try {
    const res = await call('resource=bookings');
    assert.equal(res.status, 502);
    assert.match((await res.json()).message, /schema\.sql/);
  } finally {
    calls.restore();
    clearEnv();
  }
});
