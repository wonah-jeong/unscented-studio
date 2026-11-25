// Netlify Function: GET /.netlify/functions/bookings
//
// 고객용 실시간 예약현황 API. Supabase 의 "bookings" 표에서 한국시간 기준
// 어제부터의 예약만 읽어, 기존과 똑같은 형식으로 돌려준다.
//
//   { first: { "2026-11-24": [ { start:"12:00", end:"15:00", name:"이*아", phone4:"6687", party:"2" } ] },
//     second: { ... } }
//
// - 이름은 항상 마스킹한다(첫 글자 + 가운데 글자, 나머지 '*').
// - 메모(특이사항)는 관리자 전용이라 조회조차 하지 않는다.
// - 종료시간이 24:00 을 넘는 예약(자정을 넘겨 이어짐)은 시작한 날과 다음날 양쪽에 표시한다.
// - 지난 날짜 예약은 요청 시점 기준으로 자동으로 빠진다.
//
// 필요한 환경변수 (Netlify 사이트 > Environment variables)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { json, notConfigured } from '../lib/http.js';
import { supabaseConfig, sbSelectAll } from '../lib/supabase.js';
import { buildPublicView, todayIsoKst, yesterdayIsoKst } from '../lib/booking-view.js';

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
  }

  const cfg = supabaseConfig();
  if (!cfg.ok) return notConfigured(cfg.missing, '고객용 예약현황 API');

  const today = todayIsoKst();
  const from = yesterdayIsoKst(); // 어제 시작해서 자정을 넘긴 예약까지 오늘로 이어 보이게 하려면 어제부터 읽어야 한다

  try {
    const res = await sbSelectAll(cfg, 'bookings', {
      select: 'store,date,start_time,end_time,name,phone4,party',
      filters: [['date', 'gte', from]],
      order: 'date.asc,start_time.asc'
    });
    if (!res.ok) {
      return json({ error: 'fetch_failed', message: res.error && res.error.message ? res.error.message : 'Supabase 조회 실패' }, 502);
    }
    return json(buildPublicView(res.data || [], today), 200, { 'cache-control': 'public, max-age=30' });
  } catch (err) {
    return json({ error: 'fetch_failed', message: String(err && err.message ? err.message : err) }, 502);
  }
};
