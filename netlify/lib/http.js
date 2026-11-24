// Netlify Functions 공통 HTTP 유틸.
// (Netlify Functions 폴더 밖에 두어 함수 엔드포인트로 노출되지 않게 한다.)

export const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({}, JSON_HEADERS, extraHeaders)
  });
}

/** 환경변수가 없을 때: 화면에 그대로 보여줄 수 있는 한국어 안내와 함께 500 */
export function notConfigured(missing, detail) {
  return json({
    error: 'not_configured',
    missing: missing,
    message: '서버 환경변수가 설정되지 않았어요: ' + missing.join(', ') +
      '. Netlify > Site configuration > Environment variables 에 값을 넣고 다시 배포해주세요.' +
      (detail ? ' (' + detail + ')' : '')
  }, 500);
}

export async function readJson(req) {
  let text = '';
  try { text = await req.text(); } catch (e) { return null; }
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { return null; }
}

export async function readBodyText(req) {
  try { return await req.text(); } catch (e) { return ''; }
}

export function clientIp(req) {
  try {
    const h = req.headers;
    const fwd = h.get('x-nf-client-connection-ip') || h.get('x-forwarded-for') || '';
    return String(fwd).split(',')[0].trim() || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}
