// 테스트 공용 도우미 — fetch 목(mock), 응답, 세션 쿠키, 환경변수

import { createToken, COOKIE_NAME } from '../netlify/lib/session.js';

export function setEnv(overrides) {
  const base = {
    SUPABASE_URL: 'https://test-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
    ADMIN_PASSWORD: 'pw-1234',
    ADMIN_SESSION_SECRET: 'session-secret-test'
  };
  const values = Object.assign({}, base, overrides || {});
  Object.keys(values).forEach(function (k) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  });
}

export function clearEnv() {
  ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET'].forEach(function (k) {
    delete process.env[k];
  });
}

/** fetch 를 목으로 바꾸고, 호출 기록 배열을 돌려준다. handler(url, init, call) → Response */
export function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url);
    const headers = (init && init.headers) || {};
    const call = {
      url: url,
      method: ((init && init.method) || 'GET').toUpperCase(),
      headers: headers,
      header: function (name) {
        const lower = String(name).toLowerCase();
        const key = Object.keys(headers).filter(function (k) { return k.toLowerCase() === lower; })[0];
        return key ? headers[key] : undefined;
      },
      body: init && init.body
    };
    calls.push(call);
    const res = await handler(url, init, call);
    if (!res) throw new Error('mock fetch: 응답이 없습니다 ' + url);
    return res;
  };
  calls.restore = function () { globalThis.fetch = original; };
  return calls;
}

export function jsonRes(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json' }, extraHeaders || {})
  });
}

export function textRes(text, status, headers) {
  return new Response(text, {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, headers || {})
  });
}

export function sessionCookieHeader(secret) {
  const token = createToken(secret || 'session-secret-test');
  return COOKIE_NAME + '=' + encodeURIComponent(token);
}

export function req(url, init) {
  return new Request(url, init);
}

export function jsonBody(obj) {
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}
