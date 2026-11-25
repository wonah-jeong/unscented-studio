import { test } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../netlify/functions/bookings.js';
import {
  maskName, buildPublicView, todayIsoKst, yesterdayIsoKst, timeToMin, minToTime, isOvernight
} from '../netlify/lib/booking-view.js';
import { clearEnv, setEnv, mockFetch, jsonRes } from './helpers.js';

const FN = 'https://unscented.test/.netlify/functions/bookings';
const SB = 'https://test-project.supabase.co/rest/v1/bookings';

test('이름 마스킹: 첫 글자 + 가운데 글자만 남기고 나머지는 *', function () {
  // 기존(운영 중) 함수와 완전히 같은 규칙: 첫 글자와 가운데 글자만 남기고 나머지는 '*'
  assert.equal(maskName('김수'), '김수');            // 2글자는 그대로
  assert.equal(maskName('홍길동'), '홍길*');          // 3글자: 0,1 유지
  assert.equal(maskName('남궁민수현'), '남*민**');    // 4글자: 0,2 유지
  assert.equal(maskName('김수현영호'), '김*현**');
  assert.equal(maskName(''), '');
  assert.equal(maskName(null), '');
});

test('시간 표기: 24:00 초과만 다음날(자정 넘김)로 본다', function () {
  assert.equal(isOvernight('24:00'), false);
  assert.equal(isOvernight('25:30'), true);
  assert.equal(minToTime(timeToMin('25:30') - 1440), '01:30');
});

test('buildPublicView: 자정 넘긴 예약은 시작한 날과 다음날 양쪽에 보인다', function () {
  const rows = [
    { store: '1호점', date: '2026-11-20', start_time: '22:00', end_time: '25:30', name: '홍길동', phone4: '1234', party: '2' }
  ];
  const view = buildPublicView(rows, '2026-11-20');
  assert.deepEqual(view.first['2026-11-20'], [{ start: '22:00', end: '01:30', name: '홍길*', phone4: '1234', party: '2' }]);
  assert.deepEqual(view.first['2026-11-21'], [{ start: '00:00', end: '01:30', name: '홍길*', phone4: '1234', party: '2' }]);
  // 오늘(11-20)보다 이전 날짜는 내보내지 않는다
  assert.equal(view.first['2026-11-19'], undefined);
});

test('buildPublicView: 지난 날짜 예약은 응답에서 빠지고, 메모는 어디에도 없다', function () {
  const rows = [
    { store: '2호점', date: '2026-11-18', start_time: '10:00', end_time: '12:00', name: '김수', phone4: '1111', party: '1', note: '조용히' },
    { store: '2호점', date: '2026-11-24', start_time: '13:00', end_time: '15:00', name: '박영희', phone4: '2222', party: '3', note: '반려동물' }
  ];
  const view = buildPublicView(rows, '2026-11-24');
  assert.deepEqual(Object.keys(view.second), ['2026-11-24']);
  assert.deepEqual(Object.keys(view.second['2026-11-24'][0]).sort(), ['end', 'name', 'party', 'phone4', 'start']);
  assert.equal(JSON.stringify(view).indexOf('반려동물'), -1);
});

test('buildPublicView: 같은 날 예약은 시작시간 순으로 정렬된다', function () {
  const rows = [
    { store: '1호점', date: '2026-11-24', start_time: '18:00', end_time: '20:00', name: '가나다', phone4: '', party: '' },
    { store: '1호점', date: '2026-11-24', start_time: '09:00', end_time: '11:00', name: '라마바', phone4: '', party: '' }
  ];
  const view = buildPublicView(rows, '2026-11-24');
  assert.deepEqual(view.first['2026-11-24'].map(function (e) { return e.start; }), ['09:00', '18:00']);
});

test('buildPublicView: 알 수 없는 매장/날짜는 무시한다', function () {
  const view = buildPublicView([
    { store: '3호점', date: '2026-11-24', start_time: '10:00', end_time: '11:00' },
    { store: '1호점', date: '', start_time: '10:00', end_time: '11:00' },
    null
  ], '2026-11-24');
  assert.deepEqual(view, { first: {}, second: {} });
});

test('KST 오늘/어제는 Asia/Seoul 기준이다', function () {
  // 2026-11-23 15:30 UTC = 2026-11-24 00:30 KST
  const now = new Date('2026-11-23T15:30:00Z');
  assert.equal(todayIsoKst(now), '2026-11-24');
  assert.equal(yesterdayIsoKst(now), '2026-11-23');
  // UTC 로는 아직 24일이지만 KST 는 25일
  assert.equal(todayIsoKst(new Date('2026-11-24T16:00:00Z')), '2026-11-25');
});

test('환경변수가 없으면 not_configured 로 안내한다', async function () {
  clearEnv();
  const res = await handler(new Request(FN));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'not_configured');
  assert.deepEqual(body.missing, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  assert.match(body.message, /SUPABASE_URL/);
});

test('Supabase 에서 어제 이후만, 메모를 뺀 필드만 읽어 고객용 형식으로 돌려준다', async function () {
  setEnv();
  const today = todayIsoKst();
  const yesterday = yesterdayIsoKst();
  const calls = mockFetch(function (url) {
    assert.ok(url.startsWith(SB), '예약 표를 읽어야 한다: ' + url);
    return jsonRes([
      { store: '1호점', date: today, start_time: '12:00', end_time: '15:00', name: '이서아', phone4: '6687', party: '2' },
      { store: '2호점', date: yesterday, start_time: '23:00', end_time: '26:00', name: '김지우', phone4: '3519', party: '1' }
    ]);
  });
  try {
    const res = await handler(new Request(FN));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.match(res.headers.get('cache-control') || '', /max-age=30/);
    const body = await res.json();

    assert.deepEqual(body.first[today], [{ start: '12:00', end: '15:00', name: '이서*', phone4: '6687', party: '2' }]);
    // 어제 23시에 시작해 26:00(다음날 02:00)에 끝난 예약 → 오늘 00:00-02:00 으로도 보인다
    assert.deepEqual(body.second[today], [{ start: '00:00', end: '02:00', name: '김지*', phone4: '3519', party: '1' }]);
    assert.equal(body.second[yesterday], undefined);

    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get('date'), 'gte.' + yesterday);
    assert.equal(url.searchParams.get('select'), 'store,date,start_time,end_time,name,phone4,party');
    assert.equal(url.searchParams.get('select').indexOf('note'), -1);
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('Supabase 오류는 502 fetch_failed 로 전달한다', async function () {
  setEnv();
  const calls = mockFetch(function () {
    return jsonRes({ message: 'key expired' }, 401);
  });
  try {
    const res = await handler(new Request(FN));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'fetch_failed');
    assert.match(body.message, /SUPABASE_SERVICE_ROLE_KEY/);
  } finally {
    calls.restore();
    clearEnv();
  }
});

test('GET 이외의 메서드는 405', async function () {
  setEnv();
  const res = await handler(new Request(FN, { method: 'POST' }));
  assert.equal(res.status, 405);
  clearEnv();
});

test('1,000행을 넘는 응답은 페이지를 이어서 모두 읽는다', async function () {
  setEnv();
  const today = todayIsoKst();
  let page = 0;
  const calls = mockFetch(function (url) {
    const offset = parseInt(new URL(url).searchParams.get('offset') || '0', 10);
    page += 1;
    if (offset === 0) {
      return jsonRes(Array.from({ length: 1000 }, function (_, i) {
        return { store: '1호점', date: today, start_time: '10:00', end_time: '11:00', name: '고객' + i, phone4: '0000', party: '1' };
      }));
    }
    return jsonRes([
      { store: '1호점', date: today, start_time: '20:00', end_time: '21:00', name: '마지막손님', phone4: '9999', party: '1' }
    ]);
  });
  try {
    const body = await (await handler(new Request(FN))).json();
    assert.equal(page, 2);
    assert.equal(body.first[today].length, 1001);
  } finally {
    calls.restore();
    clearEnv();
  }
});
