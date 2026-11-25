// /admin 화면이 실제 브라우저처럼 그려지는지 확인한다 (jsdom).
// jsdom 이 없으면(설치 전) 이 파일은 건너뛴다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (e) {
  JSDOM = null;
}

const skip = JSDOM ? false : 'jsdom 이 설치되어 있지 않습니다 (npm install 필요)';

function flush(ms) {
  return new Promise(function (r) { setTimeout(r, ms || 15); });
}

function summaryFixture() {
  const trend = [];
  for (let i = 0; i < 12; i++) {
    trend.push({ month: '2026-' + String(i + 1).padStart(2, '0'), first: 100000 * (i + 1), second: 50000, total: 100000 * (i + 1) + 50000 });
  }
  return {
    from: '2026-11-01', to: '2026-11-30',
    stores: {
      first: { tax: 100000, cash: 50000, card: 0, none: 0, total: 150000 },
      second: { tax: 0, cash: 0, card: 200000, none: 0, total: 200000 }
    },
    total: { tax: 100000, cash: 50000, card: 200000, none: 0, total: 350000 },
    revenue: 350000, vat: 35000, paidTotal: 300000, unpaidTotal: 50000,
    expenses: [{ id: 'e1', date: '2026-11-05', item: '임대료', amount: 120000, store: '공통', note: '' }],
    expenseTotal: 120000, net: 230000, trend: trend
  };
}

async function makePage(fixtures) {
  const html = (await readFile(path.join(ROOT, 'public/admin/index.html'), 'utf8'))
    .replace('<script src="/admin/admin.js"></script>', '');
  const js = await readFile(path.join(ROOT, 'public/admin/admin.js'), 'utf8');

  const calls = [];
  const errors = [];

  const dom = new JSDOM(html, {
    url: 'https://unscented.test/admin/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse: function (window) {
      window.Element.prototype.scrollIntoView = function () {};
      window.fetch = async function (input, init) {
        const url = String(input);
        const opts = init || {};
        calls.push({ url: url, method: (opts.method || 'GET').toUpperCase(), body: opts.body });
        const respond = function (body, status) {
          const st = status || 200;
          return {
            ok: st >= 200 && st < 300,
            status: st,
            headers: { get: function () { return null; } },
            json: async function () { return body; },
            text: async function () { return JSON.stringify(body); },
            blob: async function () { return new Blob([JSON.stringify(body)]); }
          };
        };
        if (url.indexOf('/.netlify/functions/admin-auth') > -1) {
          if (url.indexOf('action=login') > -1) return respond({ authenticated: true });
          if (url.indexOf('action=logout') > -1) return respond({ authenticated: false });
          return respond({ authenticated: false, configured: true });
        }
        if (url.indexOf('/.netlify/functions/admin-api') > -1) {
          const params = new URL(url, 'https://x').searchParams;
          const resource = params.get('resource');
          if (resource === 'bookings') return respond({ rows: fixtures.bookings || [] });
          if (resource === 'payments') return respond({ rows: fixtures.payments || [] });
          if (resource === 'summary') return respond(fixtures.summary || summaryFixture());
          if (resource === 'customers') return respond({ rows: fixtures.customers || [] });
          return respond({ rows: [] });
        }
        return respond({}, 404);
      };
      window.addEventListener('error', function (e) { errors.push(String(e.message || e.error)); });
    }
  });

  const { window } = dom;
  window.console.error = function () { errors.push(Array.prototype.join.call(arguments, ' ')); };
  window.console.warn = function () {};

  if (window.document.readyState === 'loading') {
    await new Promise(function (r) { window.addEventListener('load', r); });
  }
  window.eval(js);
  if (window.document.readyState === 'loading') {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  }
  await flush(30);
  return { dom, window, calls, errors };
}

const TODAY = new Date();
function iso(y, m, d) { return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
const TODAY_ISO = iso(TODAY.getFullYear(), TODAY.getMonth() + 1, TODAY.getDate());

test('/admin: 처음 열면 로그인 화면이 뜨고 오류가 없다', { skip: skip }, async function () {
  const page = await makePage({});
  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  assert.equal(page.window.document.getElementById('loginView').hidden, false);
  assert.equal(page.window.document.getElementById('appView').hidden, true);
  assert.match(page.window.document.getElementById('loginForm').textContent, /관리자 로그인/);
  page.dom.window.close();
});

test('/admin: 로그인하면 달력이 그려지고 예약 시간이 보인다', { skip: skip }, async function () {
  const page = await makePage({
    bookings: [
      { id: 'b1', book_key: 'r1', store: '1호점', date: TODAY_ISO, start_time: '13:00', end_time: '15:00', name: '김수현', phone4: '1234', party: '2', note: '조용히' },
      { id: 'b2', book_key: 'r2', store: '1호점', date: TODAY_ISO, start_time: '22:00', end_time: '25:30', name: '홍길동', phone4: '5678', party: '4', note: '' }
    ]
  });
  const doc = page.window.document;
  doc.getElementById('loginPassword').value = 'pw';
  doc.getElementById('loginForm').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(40);

  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  assert.equal(doc.getElementById('appView').hidden, false);
  assert.equal(doc.getElementById('loginView').hidden, true);
  assert.match(doc.getElementById('calLabel').textContent, /년 \d+월/);

  const cells = doc.querySelectorAll('.cal-cell');
  assert.equal(cells.length, 42);
  const todayCell = doc.querySelector('.cal-cell.today');
  assert.ok(todayCell, '오늘 칸이 표시되어야 한다');
  const slots = Array.from(todayCell.querySelectorAll('.slot')).map(function (s) { return s.textContent; });
  assert.deepEqual(slots, ['13:00-15:00', '22:00-01:30']);
  page.dom.window.close();
});

test('/admin: 날짜를 누르면 예약 목록·결제 배지·입력 폼이 뜬다', { skip: skip }, async function () {
  const page = await makePage({
    bookings: [
      { id: 'b1', book_key: 'r1', store: '1호점', date: TODAY_ISO, start_time: '13:00', end_time: '15:00', name: '김수현', phone4: '1234', party: '2', note: '조용히' }
    ],
    payments: [
      { id: 'p1', pay_key: 'r1', store: '1호점', date: TODAY_ISO, start_time: '13:00', end_time: '15:00', amount: 150000, status: '세금계산서발행', paid: false, alt_phone: '', sms: false, customer: { id: 'c1', name: '김수현', phone: '010-1234-5678' } }
    ]
  });
  const doc = page.window.document;
  doc.getElementById('loginPassword').value = 'pw';
  doc.getElementById('loginForm').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(40);

  doc.querySelector('.cal-cell.today').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await flush(40);

  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  const modal = doc.getElementById('dayModal');
  assert.equal(modal.classList.contains('open'), true);
  const list = doc.getElementById('modalList').textContent;
  assert.match(list, /13:00 - 15:00/);
  assert.match(list, /김수현 · 1234 · 2명 · 조용히/);
  assert.match(list, /150,000원 · 세금계산서발행/);
  assert.match(doc.getElementById('formWrap').textContent, /\+ 예약 추가/);
  assert.ok(doc.getElementById('addEntryForm'), '입력 폼이 있어야 한다');
  page.dom.window.close();
});

test('/admin: 예약 추가 폼이 올바른 페이로드로 저장한다', { skip: skip }, async function () {
  const page = await makePage({});
  const doc = page.window.document;
  doc.getElementById('loginPassword').value = 'pw';
  doc.getElementById('loginForm').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(40);
  doc.querySelector('.cal-cell.today').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await flush(40);

  const form = doc.getElementById('addEntryForm');
  const el = form.elements;
  el.startHour.value = '10';
  el.startMin.value = '00';
  el.endHour.value = '12';
  el.endMin.value = '00';
  el.name.value = '새손님';
  el.phone4.value = '4321';
  el.party.value = '3';
  el.note.value = '첫 방문';
  form.dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(60);

  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  const post = page.calls.filter(function (c) { return c.method === 'POST' && c.url.indexOf('resource=bookings') > -1; })[0];
  assert.ok(post, '예약 저장 요청이 있어야 한다');
  const body = JSON.parse(post.body);
  assert.equal(body.store, '1호점');
  assert.equal(body.date, TODAY_ISO);
  assert.equal(body.start_time, '10:00');
  assert.equal(body.end_time, '12:00');
  assert.equal(body.name, '새손님');
  assert.equal(body.phone4, '4321');
  assert.equal(body.party, '3');
  assert.equal(body.note, '첫 방문');
  assert.ok(body.book_key);
  page.dom.window.close();
});

test('/admin: 입금완료 토글은 그 결제기록만 바꾼다', { skip: skip }, async function () {
  const page = await makePage({
    bookings: [
      { id: 'b1', book_key: 'r1', store: '1호점', date: TODAY_ISO, start_time: '13:00', end_time: '15:00', name: '김수현', phone4: '1234', party: '2', note: '' }
    ],
    payments: [
      { id: 'p1', pay_key: 'r1', store: '1호점', date: TODAY_ISO, start_time: '13:00', end_time: '15:00', amount: 150000, status: '카드결제', paid: false, alt_phone: '', sms: false, customer: null }
    ]
  });
  const doc = page.window.document;
  doc.getElementById('loginPassword').value = 'pw';
  doc.getElementById('loginForm').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(40);
  doc.querySelector('.cal-cell.today').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await flush(40);

  const toggle = doc.querySelector('.paid-toggle');
  assert.ok(toggle, '입금확인 버튼이 있어야 한다');
  toggle.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await flush(40);

  const patch = page.calls.filter(function (c) { return c.method === 'PATCH'; })[0];
  assert.ok(patch, '입금완료 처리는 PATCH 로 나간다');
  assert.match(patch.url, /resource=payments&id=p1/);
  assert.deepEqual(JSON.parse(patch.body), { paid: true });
  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  page.dom.window.close();
});

test('/admin: 삭제는 확인을 한 번 더 받은 뒤 예약키로 지운다', { skip: skip }, async function () {
  const page = await makePage({
    bookings: [
      { id: 'b1', book_key: 'r1', store: '1호점', date: TODAY_ISO, start_time: '13:00', end_time: '15:00', name: '김수현', phone4: '1234', party: '2', note: '' }
    ]
  });
  const doc = page.window.document;
  doc.getElementById('loginPassword').value = 'pw';
  doc.getElementById('loginForm').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(40);
  doc.querySelector('.cal-cell.today').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await flush(40);

  const del = doc.querySelector('.row-del');
  del.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await flush(10);
  assert.equal(del.textContent, '정말 삭제?');
  assert.equal(page.calls.filter(function (c) { return c.method === 'DELETE'; }).length, 0, '한 번 눌러서는 지우지 않는다');

  del.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await flush(50);
  const call = page.calls.filter(function (c) { return c.method === 'DELETE'; })[0];
  assert.ok(call, '두 번째 클릭에서 삭제 요청');
  assert.match(call.url, /resource=bookings&book_key=r1/);
  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  page.dom.window.close();
});

test('/admin: 매출 탭에 매장별 합계·비용·순매출·차트가 그려진다', { skip: skip }, async function () {
  const page = await makePage({});
  const doc = page.window.document;
  doc.getElementById('loginPassword').value = 'pw';
  doc.getElementById('loginForm').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(40);

  const revTab = doc.querySelector('#tabs button[data-tab="revenue"]');
  revTab.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await flush(40);

  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  assert.equal(doc.getElementById('tab-revenue').classList.contains('active'), true);
  const stores = doc.getElementById('revStores').textContent;
  assert.match(stores, /1호점/);
  assert.match(stores, /150,000원/);
  assert.match(stores, /350,000원/);
  assert.match(doc.getElementById('expArea').textContent, /임대료/);
  assert.match(doc.getElementById('revNet').textContent, /230,000원/);
  assert.equal(doc.querySelectorAll('#revChart .chart-col').length, 12);
  page.dom.window.close();
});

test('/admin: 데이터 탭에서 내보내기·가져오기 UI 가 보인다', { skip: skip }, async function () {
  const page = await makePage({});
  const doc = page.window.document;
  doc.getElementById('loginPassword').value = 'pw';
  doc.getElementById('loginForm').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(40);
  doc.querySelector('#tabs button[data-tab="data"]').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await flush(20);

  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  assert.equal(doc.querySelectorAll('[data-export]').length, 4);
  assert.equal(doc.getElementById('importTable').options.length, 4);
  assert.ok(doc.getElementById('importFile'));
  page.dom.window.close();
});

async function loginAndOpenToday(page) {
  const doc = page.window.document;
  doc.getElementById('loginPassword').value = 'pw';
  doc.getElementById('loginForm').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(40);
  doc.querySelector('.cal-cell.today').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await flush(40);
  return doc;
}

function clickOn(win, el) {
  el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
}

test('/admin: 예약창 바깥 어두운 배경을 누르면 닫히고, 창 안을 누르면 닫히지 않는다', { skip: skip }, async function () {
  const page = await makePage({
    bookings: [
      { id: 'b1', book_key: 'r1', store: '1호점', date: TODAY_ISO, start_time: '13:00', end_time: '15:00', name: '김수현', phone4: '1234', party: '2', note: '' }
    ]
  });
  const doc = await loginAndOpenToday(page);
  const modal = doc.getElementById('dayModal');
  const sheet = modal.querySelector('.sheet');
  assert.equal(modal.classList.contains('open'), true, '날짜를 누르면 예약창이 열린다');

  // 창 안쪽(시트)을 누르면 이벤트가 배경까지 올라가도 닫히지 않는다
  clickOn(page.window, sheet.querySelector('.sheet-sub'));
  await flush(10);
  assert.equal(modal.classList.contains('open'), true, '창 안을 눌러서는 닫히면 안 된다');

  // 창 안에서 드래그/선택하다가 배경에서 손을 뗀 경우(click 대상이 배경)도 닫히지 않는다
  doc.getElementById('modalList').dispatchEvent(new page.window.MouseEvent('mousedown', { bubbles: true }));
  modal.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await flush(10);
  assert.equal(modal.classList.contains('open'), true, '드래그 끝 클릭으로는 닫히면 안 된다');

  // 바깥 배경을 누르면 닫힌다
  clickOn(page.window, modal);
  await flush(10);
  assert.equal(modal.classList.contains('open'), false, '배경을 누르면 닫혀야 한다');
  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  page.dom.window.close();
});

test('/admin: 세금계산서 창도 바깥 배경을 누르면 닫힌다', { skip: skip }, async function () {
  const page = await makePage({});
  const doc = await loginAndOpenToday(page);
  const modal = doc.getElementById('taxModal');

  doc.getElementById('taxOpenBtn').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
  await flush(10);
  assert.equal(modal.classList.contains('open'), true, '세금계산서 창이 열린다');

  clickOn(page.window, modal.querySelector('.sheet'));
  await flush(10);
  assert.equal(modal.classList.contains('open'), true, '창 안을 눌러서는 닫히면 안 된다');

  clickOn(page.window, modal);
  await flush(10);
  assert.equal(modal.classList.contains('open'), false, '배경을 누르면 닫혀야 한다');
  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  page.dom.window.close();
});

test('/admin: HTML 안에서 참조하는 id 가 모두 존재하고 중복이 없다', { skip: skip }, async function () {
  const html = await readFile(path.join(ROOT, 'public/admin/index.html'), 'utf8');
  const js = await readFile(path.join(ROOT, 'public/admin/admin.js'), 'utf8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const ids = Array.from(doc.querySelectorAll('[id]')).map(function (el) { return el.id; });
  const dupes = ids.filter(function (id, i) { return ids.indexOf(id) !== i; });
  assert.deepEqual(dupes, [], '중복 id: ' + dupes.join(', '));

  // 폼·고객 패널은 JS 가 그려 넣으므로, JS 템플릿 안의 id="..." 까지 합쳐서 확인한다.
  const jsIds = Array.from(js.matchAll(/id="([A-Za-z0-9_-]+)"/g)).map(function (m) { return m[1]; });
  const known = new Set(ids.concat(jsIds));
  const refs = Array.from(js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)).map(function (m) { return m[1]; });
  const missing = Array.from(new Set(refs)).filter(function (id) { return !known.has(id); });
  assert.deepEqual(missing, [], '어디에도 없는 id 참조: ' + missing.join(', '));
});
