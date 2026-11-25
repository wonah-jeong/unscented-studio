// Netlify Functions 공통: Supabase(PostgREST) 호출 유틸.
//
// - SUPABASE_URL               : 예) https://abcdefgh.supabase.co
// - SUPABASE_SERVICE_ROLE_KEY  : 서비스 롤 키(브라우저에 절대 노출하지 않음)
//
// 스키마의 네 테이블은 RLS 가 켜져 있고 정책이 없으므로, 서비스 롤 키로만 접근된다.

export function supabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const missing = [];
  if (!url) missing.push('SUPABASE_URL');
  if (!key) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  return { url: url, key: key, missing: missing, ok: missing.length === 0 };
}

const REQUEST_TIMEOUT_MS = 15000;

// query 는 [키, 값] 쌍의 배열이다 — date=gte... & date=lte... 처럼 같은 키를 두 번 넣어야 하는
// 범위 조건이 있어서 객체가 아니라 쌍 배열로 다룬다.
function buildUrl(cfg, table, pairs) {
  const u = new URL(cfg.url + '/rest/v1/' + table);
  (pairs || []).forEach(function (p) {
    if (p[1] === undefined || p[1] === null) return;
    u.searchParams.append(p[0], String(p[1]));
  });
  return u.toString();
}

function filterPairs(filters, base) {
  const pairs = (base || []).slice();
  (filters || []).forEach(function (f) { pairs.push([f[0], f[1] + '.' + f[2]]); });
  return pairs;
}

function normalizeError(status, body) {
  let message = '';
  let code = '';
  let hint = '';
  if (body && typeof body === 'object') {
    message = body.message || body.error_description || body.error || '';
    code = String(body.code || '');
    hint = body.hint || body.details || '';
  } else if (typeof body === 'string') {
    message = body.slice(0, 300);
  }
  if (code === '42P01' || code === 'PGRST205' || /relation .* does not exist/i.test(message) || /Could not find the table/i.test(message)) {
    message = '테이블을 찾지 못했어요. Supabase SQL Editor 에서 supabase/schema.sql 을 먼저 실행해주세요. (' + message + ')';
  } else if (status === 401 || status === 403) {
    message = 'Supabase 키가 거절됐어요. SUPABASE_SERVICE_ROLE_KEY 가 서비스 롤 키인지 확인해주세요. (' + message + ')';
  }
  return { status: status, message: message || ('Supabase ' + status), code: code, hint: hint };
}

async function request(cfg, table, pairs, init) {
  const opts = init || {};
  const headers = Object.assign({
    apikey: cfg.key,
    Authorization: 'Bearer ' + cfg.key
  }, opts.headers || {});
  if (opts.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(buildUrl(cfg, table, pairs), {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (e) {
    return { ok: false, status: 0, data: null, error: { status: 0, message: 'Supabase 에 연결하지 못했어요: ' + (e && e.message ? e.message : String(e)) } };
  }
  const text = await res.text().catch(function () { return ''; });
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = text; }
  }
  if (!res.ok) {
    return { ok: false, status: res.status, data: null, error: normalizeError(res.status, body) };
  }
  return { ok: true, status: res.status, data: body, error: null };
}

/** 행 조회. filters: [['date','gte','2026-01-01'], ...]. raw: { or: '(name.ilike.*김*)' } 처럼 PostgREST 고유 파라미터. */
export async function sbSelect(cfg, table, opts) {
  const o = opts || {};
  const pairs = filterPairs(o.filters, [['select', o.select || '*']]);
  if (o.raw) Object.keys(o.raw).forEach(function (k) { pairs.push([k, o.raw[k]]); });
  if (o.order) pairs.push(['order', o.order]);
  if (o.limit) pairs.push(['limit', o.limit]);
  if (o.offset) pairs.push(['offset', o.offset]);
  return request(cfg, table, pairs, {
    headers: o.count ? { Prefer: 'count=exact' } : {}
  });
}

/** 1,000행 제한을 넘겨도 끝까지 읽는다(1,000행 단위 페이지). */
export async function sbSelectAll(cfg, table, opts) {
  const pageSize = 1000;
  const out = [];
  let offset = 0;
  for (;;) {
    const res = await sbSelect(cfg, table, Object.assign({}, opts, { limit: pageSize, offset: offset }));
    if (!res.ok) return res;
    const rows = res.data || [];
    for (let i = 0; i < rows.length; i++) out.push(rows[i]);
    if (rows.length < pageSize) break;
    offset += pageSize;
    if (offset >= 50000) break;
  }
  return { ok: true, status: 200, data: out, error: null };
}

/** 여러 행 upsert(기본: 충돌 시 병합). onConflict 는 유니크 컬럼명. */
export async function sbUpsert(cfg, table, rows, opts) {
  const o = opts || {};
  const pairs = [['select', '*']];
  if (o.onConflict) pairs.push(['on_conflict', o.onConflict]);
  const resolution = o.ignoreDuplicates ? 'ignore-duplicates' : 'merge-duplicates';
  return request(cfg, table, pairs, {
    method: 'POST',
    body: rows,
    headers: { Prefer: 'resolution=' + resolution + ',return=representation' }
  });
}

export async function sbInsert(cfg, table, rows) {
  return request(cfg, table, [['select', '*']], {
    method: 'POST',
    body: rows,
    headers: { Prefer: 'return=representation' }
  });
}

/** 부분 수정. filters 는 sbSelect 와 같은 형식. */
export async function sbPatch(cfg, table, filters, patch) {
  const pairs = filterPairs(filters, [['select', '*']]);
  return request(cfg, table, pairs, {
    method: 'PATCH',
    body: patch,
    headers: { Prefer: 'return=representation' }
  });
}

export async function sbDelete(cfg, table, filters) {
  // return=representation 으로 지운 행을 돌려받으려면 select 가 필요하다(없으면 204 + 빈 본문).
  const pairs = filterPairs(filters, [['select', '*']]);
  return request(cfg, table, pairs, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' }
  });
}
