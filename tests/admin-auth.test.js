import { test } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../netlify/functions/admin-auth.js';
import { verifyToken, createToken, COOKIE_NAME, SESSION_MAX_AGE } from '../netlify/lib/session.js';
import { clearEnv, setEnv, req, jsonBody } from './helpers.js';

const FN = 'https://unscented.test/.netlify/functions/admin-auth';
const SECRET = 'session-secret-test';

function login(password, ip) {
  return handler(new Request(FN + '?action=login', Object.assign(jsonBody({ action: 'login', password: password }), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': ip || '1.1.1.1' }
  })));
}

function sessionGet(cookie) {
  const headers = cookie ? { cookie: cookie } : {};
  return handler(new Request(FN + '?action=session', { headers: headers }));
}

test('환경변수가 없으면 세션 확인은 configured:false 로 안내한다', async function () {
  clearEnv();
  const res = await sessionGet('');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.authenticated, false);
  assert.equal(body.configured, false);
  assert.deepEqual(body.missing, ['ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET']);
  assert.match(body.message, /ADMIN_PASSWORD/);
});

test('환경변수가 없으면 로그인은 500 not_configured', async function () {
  clearEnv();
  const res = await login('pw-1234');
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'not_configured');
});

test('비밀번호가 틀리면 401, 맞으면 30일짜리 HttpOnly 쿠키를 준다', async function () {
  setEnv();
  const bad = await login('nope');
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, 'invalid_password');
  assert.equal(bad.headers.get('set-cookie'), null);

  const ok = await login('pw-1234');
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.authenticated, true);
  const cookie = ok.headers.get('set-cookie');
  assert.ok(cookie, 'Set-Cookie 헤더가 있어야 한다');
  assert.match(cookie, new RegExp('^' + COOKIE_NAME + '='));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, new RegExp('Max-Age=' + SESSION_MAX_AGE));

  // 쿠키 안의 토큰은 서명이 맞고 만료가 약 30일 뒤
  const token = decodeURIComponent(cookie.split(';')[0].split('=')[1]);
  const payload = verifyToken(token, SECRET);
  assert.ok(payload, '서명이 유효해야 한다');
  const days = (payload.exp - Date.now()) / 86400000;
  assert.ok(days > 29.9 && days <= 30.01, '30일 유지: ' + days);
  clearEnv();
});

test('유효한 쿠키로 세션 확인하면 authenticated:true', async function () {
  setEnv();
  const ok = await login('pw-1234', '2.2.2.2');
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  const res = await sessionGet(cookie);
  const body = await res.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.configured, true);
  assert.ok(body.expiresAt);
  clearEnv();
});

test('위조·변조·만료된 쿠키는 모두 거절한다', async function () {
  setEnv();
  const token = createToken(SECRET);
  const parts = token.split('.');

  const tampered = await sessionGet(COOKIE_NAME + '=' + encodeURIComponent(parts[0] + '.' + 'x'.repeat(parts[1].length)));
  assert.equal((await tampered.json()).authenticated, false);

  const forgedPayload = Buffer.from(JSON.stringify({ exp: Date.now() + 100000 })).toString('base64url');
  const forged = await sessionGet(COOKIE_NAME + '=' + encodeURIComponent(forgedPayload + '.' + parts[1]));
  assert.equal((await forged.json()).authenticated, false);

  const expiredToken = createToken(SECRET, Date.now() - (SESSION_MAX_AGE + 10) * 1000);
  const expired = await sessionGet(COOKIE_NAME + '=' + encodeURIComponent(expiredToken));
  assert.equal((await expired.json()).authenticated, false);

  const garbage = await sessionGet(COOKIE_NAME + '=hello');
  assert.equal((await garbage.json()).authenticated, false);
  clearEnv();
});

test('로그아웃은 쿠키를 즉시 만료시킨다', async function () {
  setEnv();
  const res = await handler(new Request(FN + '?action=logout', Object.assign(jsonBody({ action: 'logout' }), {
    method: 'POST', headers: { 'content-type': 'application/json' }
  })));
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, new RegExp('^' + COOKIE_NAME + '=;'));
  assert.match(cookie, /Max-Age=0/);
  assert.equal((await res.json()).authenticated, false);
  clearEnv();
});

test('비밀번호를 여러 번 틀리면 잠시 막는다(429)', async function () {
  setEnv();
  let last;
  for (let i = 0; i < 9; i++) {
    last = await login('wrong-' + i, '9.9.9.9');
  }
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error, 'too_many_attempts');
  // 다른 IP 는 영향 없음
  const other = await login('pw-1234', '8.8.8.8');
  assert.equal(other.status, 200);
  clearEnv();
});

test('JSON 이 아닌 본문은 400', async function () {
  setEnv();
  const res = await handler(new Request(FN, { method: 'POST', body: 'not-json', headers: { 'content-type': 'application/json' } }));
  assert.equal(res.status, 400);
  clearEnv();
});
