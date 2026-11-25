# Supabase + 전용 관리자(/admin) 설정 안내

이 문서는 배포 후 한 번만 하면 되는 설정 순서입니다. 코드는 이미 다 들어가 있어서
아래 3단계만 하면 바로 동작합니다.

## 0. 무엇이 바뀌었나

| 구분 | 이전 | 지금 |
|---|---|---|
| 예약 데이터 | Airtable "예약" 표 (Netlify Function 이 토큰으로 조회) | Supabase `bookings` 표 |
| 고객·결제·지출 | 아티팩트 관리자 화면(브라우저)이 Airtable 커넥터로 직접 읽고 씀 | Supabase `customers` / `payments` / `expenses` 표 |
| 관리자 화면 | 사이트 안에 숨겨진 관리자 모드 | 별도 페이지 `/admin` (비밀번호 로그인, 30일 유지) |
| 고객용 예약현황 | `/.netlify/functions/bookings` | 그대로 (응답 형식 동일 — 사이트 코드는 수정 없음) |

고객용 API 응답은 이전과 100% 같은 모양입니다.

```json
{ "first": { "2026-11-24": [ { "start": "12:00", "end": "15:00", "name": "이서*", "phone4": "6687", "party": "2" } ] },
  "second": { } }
```

- 이름은 마스킹, 메모(특이사항)는 응답에 포함되지 않습니다.
- 자정을 넘는 예약(`end_time` 이 `24:00` 초과)은 시작한 날과 다음날 양쪽에 표시됩니다.
- 한국시간 기준 어제부터 읽어, 오늘로 이어지는 예약을 놓치지 않습니다.

## 1. Supabase 에 표 만들기

1. Supabase 프로젝트를 만듭니다 (무료 플랜으로 충분).
2. 왼쪽 **SQL Editor** 를 열고 `supabase/schema.sql` 파일 전체를 붙여넣고 **Run**.
   - 여러 번 실행해도 안전합니다.
   - 표 4개(`bookings`, `customers`, `payments`, `expenses`)와 인덱스가 생깁니다.
   - 네 표 모두 **RLS 가 켜져 있고 정책이 없습니다** → anon 키로는 아무것도 읽고 쓸 수 없습니다.
     오직 서버(Netlify Function)만 서비스 롤 키로 접근합니다.
3. **Project Settings > API** 에서 두 값을 복사해 둡니다.
   - `Project URL` → `SUPABASE_URL`
   - `service_role` 키 (secret) → `SUPABASE_SERVICE_ROLE_KEY`
   - ⚠️ service_role 키는 절대 브라우저나 저장소에 넣지 마세요. Netlify 환경변수에만 넣습니다.

## 2. Netlify 환경변수 4개

**Site configuration > Environment variables** 에 추가하고 다시 배포합니다.

| 이름 | 값 | 설명 |
|---|---|---|
| `SUPABASE_URL` | `https://xxxx.supabase.co` | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGci...` | service_role 키 (서버 전용) |
| `ADMIN_PASSWORD` | 원하는 비밀번호 | `/admin` 로그인 비밀번호 |
| `ADMIN_SESSION_SECRET` | 길고 무작위인 문자열 | 로그인 쿠키 서명 키. 바꾸면 기존 로그인이 모두 풀립니다 |

값이 없으면 사이트/관리자 화면에 무엇이 빠졌는지 한국어로 안내가 뜨고, 조용히 실패하지 않습니다.

## 3. 기존 데이터 옮기기 (Airtable CSV)

`/admin` → **데이터** 탭 → **가져오기**.

1. Airtable 에서 각 표를 **CSV 로 내려받습니다** (예약 / 고객 / 결제기록 / 지출).
2. 표를 고르고 파일을 올린 뒤 **가져오기**.
3. 순서는 **고객 → 예약 → 결제 → 지출** 을 권합니다.
   결제 CSV 의 "연결된 고객" 이름·연락처로 고객을 찾아 연결하기 때문입니다
   (없으면 새 고객으로 만들어 줍니다).

가져오기 규칙

- 첫 줄은 제목(헤더) 행이어야 합니다. 한글 헤더(Airtable/관리자 화면 그대로)와 영문 헤더를 모두 인식합니다.
- **예약·결제**는 예약키(`book_key` / `pay_key`)가 같으면 새로 쌓이지 않고 **갱신**됩니다.
  → 같은 파일을 두 번 올려도 중복이 생기지 않습니다. 예약키가 비어 있으면 새로 만들어 넣습니다.
- **고객**은 연락처(숫자만 비교) 또는 이름으로 기존 고객을 찾아 갱신합니다.
- **지출**은 자연키가 없어 (날짜·항목·금액·지점)이 같은 행이 이미 있으면 건너뜁니다.
- 잘못된 값은 줄 번호와 이유를 보여주고 그 줄만 건너뜁니다 (나머지는 저장).
- 한 번에 10,000건까지. 더 많으면 파일을 나눠 올려주세요.

## 4. 쓰는 법

- 주소: `https://<사이트>/admin` (또는 `/admin/`)
- 비밀번호를 한 번 넣으면 **30일** 동안 다시 묻지 않습니다. 다른 기기에서도 각각 한 번씩.
- **예약** 탭: 달력에서 날짜를 누르면 그 날 예약 목록 → 추가·수정·삭제.
  - 예약을 추가할 때 고객을 검색해 연결하면 결제/세금계산서 정보가 그 예약에 붙습니다.
  - 발행상태(발행안함 / 세금계산서발행 / 현금영수증발행 / 카드결제)와 결제금액, 입금완료를 그 자리에서 관리합니다.
  - 세금계산서를 발행하려면 사업자등록번호·상호·대표자명이 필요합니다.
  - 겹치는 예약이 있으면 한 번 알려주고, 한 번 더 누르면 그대로 저장합니다.
  - 자정을 넘기는 예약은 종료 시간을 시작보다 이르게 고르면 자동으로 다음날 종료로 저장됩니다.
- **매출** 탭: 월별 매장별·발행상태별 합계, 미리 떼어둘 부가세(10%), 이번 달 비용, 순매출, 최근 12개월 추이.
- **데이터** 탭: CSV 내보내기(예약/고객/결제/지출), CSV 가져오기.
- **세금계산서 CSV**: 예약 탭 오른쪽 위 버튼 → 기간 선택 → 홈택스 업로드 양식으로 다운로드.

## 5. 개발/검증

```bash
npm install        # jsdom (화면 렌더링 테스트용, 배포에는 영향 없음)
npm test           # 함수·API·화면 테스트 61개
npx netlify dev    # 함수까지 포함한 로컬 확인 (환경변수는 .env 에)
```

- `tests/bookings.test.js` — 고객용 API: 마스킹, 자정 넘김, KST 날짜 필터, 메모 제외, 오류 처리
- `tests/admin-auth.test.js` — 로그인/쿠키 서명/만료/위조/로그아웃/시도 제한
- `tests/admin-api.test.js` — 인증 가드, CRUD 가 만드는 PostgREST 쿼리, CSV 내보내기·가져오기, 매출 집계, 세금계산서
- `tests/admin-ui.test.js` · `tests/admin-render.test.js` — 로컬 서버에 올린 `/admin` 화면이 오류 없이 그려지는지, 달력·모달·저장·입금완료·삭제가 실제로 동작하는지

## 6. 참고: 표 구조

`bookings`
: `book_key`(예약키, 유니크) · `store`(1호점/2호점) · `date` · `start_time` · `end_time`(24:00 이상 = 자정 넘김) · `name` · `phone4` · `party` · `note`(관리자 전용) · `created_at` · `updated_at`

`customers`
: `name` · `phone` · `biz_no` · `biz_name` · `biz_owner` · `email` · `note`

`payments`
: `pay_key`(예약키와 동일, 유니크) · `store` · `date` · `start_time` · `end_time` · `customer_id`(→ customers) · `amount` · `status` · `biz_no` · `biz_name` · `biz_owner` · `email` · `paid`(입금완료) · `alt_phone`(안내 번호) · `sms` · `note`

`expenses`
: `date` · `item` · `amount` · `store`(1호점/2호점/공통) · `note`
