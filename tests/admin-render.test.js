// 로컬 웹서버에 실제로 올려서 /admin 이 오류 없이 그려지는지 확인한다.
// (jsdom 이 없으면 건너뛴다)

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './serve.js';

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (e) {
  JSDOM = null;
}
const skip = JSDOM ? false : 'jsdom 이 설치되어 있지 않습니다 (npm install 필요)';

const TODAY = new Date();
const TODAY_ISO = TODAY.getFullYear() + '-' + String(TODAY.getMonth() + 1).padStart(2, '0') + '-' + String(TODAY.getDate()).padStart(2, '0');

function fixtures() {
  return {
    bookings: [
      { id: 'b1', book_key: 'r1', store: '1호점', date: TODAY_ISO, start_time: '11:00', end_time: '14:00', name: '김지우', phone4: '3519', party: '1', note: '' }
    ],
    payments: [
      { id: 'p1', pay_key: 'r1', store: '1호점', date: TODAY_ISO, start_time: '11:00', end_time: '14:00', amount: 200000, status: '카드결제', paid: true, alt_phone: '', sms: false, customer: null }
    ]
  };
}

test('/admin: 로컬 서버에서 페이지가 오류 없이 렌더링된다', { skip: skip }, async function () {
  const server = await startServer(0);
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const errors = [];
  const data = fixtures();

  const dom = await JSDOM.fromURL(base + '/admin/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse: function (window) {
      window.Element.prototype.scrollIntoView = function () {};
      window.fetch = async function (input) {
        const url = String(input);
        const ok = function (body) {
          return {
            ok: true, status: 200, headers: { get: function () { return null; } },
            json: async function () { return body; }, text: async function () { return JSON.stringify(body); }
          };
        };
        const params = new URL(url, base).searchParams;
        if (url.indexOf('/admin-auth') > -1) {
          if (url.indexOf('action=login') > -1) return ok({ authenticated: true });
          return ok({ authenticated: false, configured: true });
        }
        if (url.indexOf('/admin-api') > -1) {
          const r = params.get('resource');
          if (r === 'bookings') return ok({ rows: data.bookings });
          if (r === 'payments') return ok({ rows: data.payments });
          if (r === 'summary') {
            return ok({
              from: TODAY_ISO, to: TODAY_ISO,
              stores: { first: { tax: 0, cash: 0, card: 200000, none: 0, total: 200000 }, second: { tax: 0, cash: 0, card: 0, none: 0, total: 0 } },
              total: { tax: 0, cash: 0, card: 200000, none: 0, total: 200000 },
              revenue: 200000, vat: 20000, paidTotal: 200000, unpaidTotal: 0,
              expenses: [], expenseTotal: 0, net: 200000, trend: []
            });
          }
          return ok({ rows: [] });
        }
        return ok({});
      };
      window.addEventListener('error', function (e) { errors.push(String(e.message || e.error)); });
      window.addEventListener('unhandledrejection', function (e) { errors.push('unhandledrejection: ' + e.reason); });
    }
  });

  try {
    const { window } = dom;
    window.console.error = function () { errors.push(Array.prototype.join.call(arguments, ' ')); };
    await new Promise(function (r) { setTimeout(r, 150); });

    const doc = window.document;
    assert.equal(doc.getElementById('boot').hidden, true, '로딩 표시가 사라져야 한다');
    assert.equal(doc.getElementById('loginView').hidden, false, '로그인 화면이 보여야 한다');

    // 로그인 → 달력
    doc.getElementById('loginPassword').value = 'pw';
    doc.getElementById('loginForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(function (r) { setTimeout(r, 150); });

    assert.equal(doc.getElementById('appView').hidden, false, '로그인 후 본문이 보여야 한다');
    assert.equal(doc.querySelectorAll('.cal-cell').length, 42, '달력 42칸');
    assert.match(doc.querySelector('.cal-cell.today').textContent, /11:00-14:00/);

    // 하루 상세
    doc.querySelector('.cal-cell.today').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(function (r) { setTimeout(r, 150); });
    assert.equal(doc.getElementById('dayModal').classList.contains('open'), true);
    assert.match(doc.getElementById('modalList').textContent, /200,000원 · 카드결제/);
    assert.match(doc.getElementById('modalList').textContent, /입금완료/);
    assert.ok(doc.getElementById('addEntryForm'));

    assert.deepEqual(errors, [], '콘솔 오류: ' + errors.join(' | '));
  } finally {
    dom.window.close();
    await new Promise(function (r) { server.close(r); });
  }
});
