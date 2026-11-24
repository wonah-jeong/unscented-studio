// Netlify Function: /.netlify/functions/admin-auth
//
// 전용 관리자(/admin) 로그인·로그아웃·세션 확인.
//
//   GET  ?action=session   → { authenticated: true/false, expiresAt }
//   POST {action:"login", password:"..."}  → 성공 시 30일짜리 서명 쿠키 발급
//   POST {action:"logout"}                 → 쿠키 삭제
//
// 쿠키는 HttpOnly + Secure + SameSite=Lax 라서 자바스크립트로 읽을 수 없고,
// HMAC 서명이라 위조할 수 없다. 서명 키(ADMIN_SESSION_SECRET)를 바꾸면
// 기존 세션은 모두 무효가 된다.
//
// 필요한 환경변수
//   ADMIN_PASSWORD        관리자 비밀번호 (한 번 입력하면 30일 유지)
//   ADMIN_SESSION_SECRET  쿠키 서명 키 (충분히 긴 임의 문자열)

import { createHash } from 'node:crypto';
import { json, readJson, clientIp, notConfigured } from '../lib/http.js';
import {
  createToken, sessionCookie, clearCookie, safeEqual, sessionFromRequest, SESSION_MAX_AGE
} from '../lib/session.js';

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map(); // ip -> { count, firstAt } (함수 인스턴스 안에서만 유지되는 완만한 방어)

function config() {
  const password = String(process.env.ADMIN_PASSWORD || '');
  const secret = String(process.env.ADMIN_SESSION_SECRET || '');
  const missing = [];
  if (!password) missing.push('ADMIN_PASSWORD');
  if (!secret) missing.push('ADMIN_SESSION_SECRET');
  return { password: password, secret: secret, missing: missing, ok: missing.length === 0 };
}

function tooManyAttempts(ip, now) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (now - rec.firstAt > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function noteFailure(ip, now) {
  const rec = attempts.get(ip);
  if (!rec || now - rec.firstAt > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAt: now });
    return;
  }
  rec.count += 1;
}

function sha256(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

export default async (req) => {
  const cfg = config();
  const url = new URL(req.url);
  const now = Date.now();

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!cfg.ok) {
      // 아직 환경변수를 넣지 않은 상태 — 화면에서 안내할 수 있게 200 으로 알려준다.
      return json({
        authenticated: false,
        configured: false,
        missing: cfg.missing,
        message: '서버 환경변수가 설정되지 않았어요: ' + cfg.missing.join(', ') +
          '. Netlify > Site configuration > Environment variables 에서 설정한 뒤 다시 배포해주세요.'
      });
    }
    const session = sessionFromRequest(req);
    return json({
      authenticated: !!session.ok,
      configured: true,
      expiresAt: session.ok ? new Date(session.payload.exp).toISOString() : null
    });
  }

  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' });
  }

  if (!cfg.ok) return notConfigured(cfg.missing, '관리자 로그인');

  const body = await readJson(req);
  if (!body) return json({ error: 'bad_request', message: '요청 형식을 읽지 못했어요.' }, 400);
  const action = String(body.action || url.searchParams.get('action') || 'login');

  if (action === 'logout') {
    return json({ authenticated: false }, 200, { 'set-cookie': clearCookie(req) });
  }

  if (action !== 'login') {
    return json({ error: 'bad_action', message: '알 수 없는 요청이에요.' }, 400);
  }

  const ip = clientIp(req);
  if (tooManyAttempts(ip, now)) {
    return json({
      error: 'too_many_attempts',
      message: '비밀번호를 여러 번 틀렸어요. 10분 뒤에 다시 시도해주세요.'
    }, 429);
  }

  const given = String(body.password == null ? '' : body.password);
  if (!safeEqual(sha256(given), sha256(cfg.password))) {
    noteFailure(ip, now);
    return json({ error: 'invalid_password', message: '비밀번호가 맞지 않아요.' }, 401);
  }

  attempts.delete(ip);
  const token = createToken(cfg.secret, now);
  return json({
    authenticated: true,
    expiresAt: new Date(now + SESSION_MAX_AGE * 1000).toISOString()
  }, 200, { 'set-cookie': sessionCookie(req, token) });
};
