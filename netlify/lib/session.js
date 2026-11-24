// Netlify Functions 공통: 관리자 세션(HMAC 서명 쿠키) 유틸.
//
// 쿠키 한 번 받으면 30일 동안 비밀번호를 다시 묻지 않는다.
// 토큰은 "payload.signature" 형태이고 payload 는 {exp: <ms>} 를 담은 base64url(JSON).
// 서명 키는 환경변수 ADMIN_SESSION_SECRET — 이 값을 바꾸면 모든 기존 세션이 로그아웃된다.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'unscented_admin';
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30일(초)

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(data, secret) {
  return b64url(createHmac('sha256', secret).update(data).digest());
}

/** 두 문자열을 길이 누출 없이 비교 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    // 길이가 달라도 같은 시간이 걸리도록 자기 자신과 비교만 하고 false
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function createToken(secret, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const payload = { exp: now + SESSION_MAX_AGE * 1000, iat: now };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return body + '.' + sign(body, secret);
}

/** 유효하면 payload({exp, iat}), 아니면 null */
export function verifyToken(token, secret, nowMs) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const body = parts[0];
  const sig = parts[1];
  const expected = sign(body, secret);
  if (!safeEqual(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number') return null;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (payload.exp <= now) return null;
  return payload;
}

export function readCookie(req, name) {
  let raw = '';
  try { raw = req.headers.get('cookie') || ''; } catch (e) { raw = ''; }
  const want = name || COOKIE_NAME;
  const parts = String(raw).split(';');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    if (p.slice(0, eq) === want) {
      return decodeURIComponent(p.slice(eq + 1));
    }
  }
  return '';
}

function isHttps(req) {
  try {
    const proto = req.headers.get('x-forwarded-proto');
    if (proto) return String(proto).split(',')[0].trim() === 'https';
    return true; // Netlify 배포 환경은 항상 https
  } catch (e) {
    return true;
  }
}

export function sessionCookie(req, token, maxAge) {
  const age = typeof maxAge === 'number' ? maxAge : SESSION_MAX_AGE;
  const attrs = [
    COOKIE_NAME + '=' + encodeURIComponent(token),
    'Path=/'
  ];
  if (isHttps(req)) attrs.push('Secure');
  attrs.push('HttpOnly', 'SameSite=Lax', 'Max-Age=' + age);
  return attrs.join('; ');
}

export function clearCookie(req) {
  const attrs = [COOKIE_NAME + '=', 'Path=/'];
  if (isHttps(req)) attrs.push('Secure');
  attrs.push('HttpOnly', 'SameSite=Lax', 'Max-Age=0');
  return attrs.join('; ');
}

/** 요청의 관리자 세션이 유효한지 */
export function sessionFromRequest(req) {
  const secret = String(process.env.ADMIN_SESSION_SECRET || '');
  if (!secret) return { ok: false, reason: 'no_secret' };
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return { ok: false, reason: 'no_cookie' };
  const payload = verifyToken(token, secret);
  if (!payload) return { ok: false, reason: 'invalid' };
  return { ok: true, payload: payload };
}
