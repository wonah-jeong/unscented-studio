// /admin 입력칸이 iOS Safari 에서 자동 확대되지 않도록 글자가 16px 이상인지 확인한다.
// (iOS Safari 는 input/select/textarea 의 계산된 font-size 가 16px 미만이면 포커스할 때 화면을 확대한다.)
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

// /admin 화면에 실제로 나오는 입력칸들: 로그인, 예약 폼(admin.js 가 그리는 마크업), 지출 폼, 가져오기, 세금계산서.
const MARKUP = `
<section class="login"><form class="login-box">
  <input type="password" id="loginPassword" placeholder="관리자 비밀번호">
</form></section>
<main><form class="admin-form" id="addEntryForm">
  <div class="row2"><select name="store"><option>1호점</option></select><input type="date" name="date"></div>
  <div class="row2 time-row"><select name="startHour"><option>10</option></select><select name="startMin"><option>00</option></select></div>
  <input type="text" name="name" placeholder="고객 이름">
  <div class="row2"><input type="text" name="phone4" placeholder="연락처 뒷 4자리"><input type="number" name="party" placeholder="인원"></div>
  <input type="text" name="note" placeholder="특이사항">
  <div class="row2 cust-search-row"><input type="text" id="custSearchInput" placeholder="이름 또는 연락처로 검색"><button type="button">검색</button></div>
  <div class="cust-new-form"><input type="text" id="custNewName"><input type="tel" id="custNewPhone"></div>
  <div class="row2"><input type="number" name="amount"><select name="issueStatus"><option>발행안함</option></select></div>
  <div class="biz-fields">
    <input type="text" name="bizNo"><input type="text" name="bizName"><input type="text" name="bizOwner"><input type="email" name="bizEmail">
    <label class="save-to-cust"><input type="checkbox" name="saveToCustomer"> 이 정보를 고객 정보에도 저장</label>
  </div>
  <div class="row2"><input type="tel" name="notifyPhone"></div>
  <input type="text" name="custEditName"><input type="tel" name="custEditPhone">
</form>
<form class="exp-form open" id="expForm">
  <div class="row2"><input type="date" id="expDate"><input type="number" id="expAmount"></div>
  <div class="row2"><input type="text" id="expItem"><select id="expStore"><option>공통</option></select></div>
  <input type="text" id="expNote">
</form>
<div class="import-box"><select id="importTable"><option>예약 CSV</option></select><input type="file" id="importFile"></div>
<div class="tax-form"><div class="row2"><input type="date" id="taxFrom"><input type="date" id="taxTo"></div></div>
</main>`;

async function makeDoc() {
  const css = await readFile(path.join(ROOT, 'public/admin/admin.css'), 'utf8');
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${css}</style></head><body>${MARKUP}</body></html>`,
    { url: 'https://unscented.test/admin/' }
  );
  return dom.window;
}

test('iOS 자동 확대 방지: /admin 의 입력칸 글자는 모두 16px 이상이다', { skip: skip }, async function () {
  const window = await makeDoc();
  const els = Array.from(window.document.querySelectorAll('input,select,textarea'));
  assert.ok(els.length >= 20, '검사할 입력칸이 충분히 있어야 한다: ' + els.length);

  const tooSmall = [];
  for (const el of els) {
    const size = parseFloat(window.getComputedStyle(el).fontSize);
    if (!(size >= 16)) {
      tooSmall.push((el.id || el.getAttribute('name') || el.type || el.tagName) + '=' + size + 'px');
    }
  }
  assert.deepEqual(tooSmall, [], '16px 미만 입력칸: ' + tooSmall.join(', '));
});

test('입력칸 높이는 예전(14px × 1.6)과 같게 유지된다', { skip: skip }, async function () {
  const window = await makeDoc();
  for (const el of window.document.querySelectorAll('input[type=text],input[type=tel],input[type=number],input[type=date],input[type=password],select')) {
    const lh = parseFloat(window.getComputedStyle(el).lineHeight);
    assert.ok(Math.abs(lh - 22.4) < 0.5, (el.id || el.getAttribute('name') || el.tagName) + ' 줄 높이 ' + lh + 'px');
  }
});

test('admin.css 에 입력칸을 16px 미만으로 만드는 규칙이 없다', async function () {
  const css = await readFile(path.join(ROOT, 'public/admin/admin.css'), 'utf8');
  const rules = css.match(/[^{}]+\{[^{}]*\}/g) || [];
  const bad = [];
  for (const rule of rules) {
    const selectors = rule.slice(0, rule.indexOf('{'));
    if (!/\b(input|select|textarea)\b/.test(selectors)) continue;
    const m = rule.match(/font-size\s*:\s*([^;}]+)/);
    if (!m) continue;
    const v = m[1].trim();
    if (/inherit/.test(v)) continue;
    const px = parseFloat(v);
    if (isNaN(px)) continue;
    if (px < 16) bad.push(selectors.trim() + ' { font-size: ' + v + ' }');
  }
  assert.deepEqual(bad, [], '16px 미만 규칙: ' + bad.join(' / '));
});
