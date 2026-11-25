-- ============================================================================
-- Unscented 렌탈스튜디오 — Supabase 스키마
--
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여넣고 실행하면 됩니다.
-- 여러 번 실행해도 안전하도록(idempotent) 작성했습니다.
--
-- 테이블 4개
--   bookings  : 예약 (기존 Airtable "예약" 표 — 고객용 캘린더가 읽는 가벼운 미러)
--   customers : 고객 (기존 Airtable "고객" 표)
--   payments  : 결제기록 (기존 Airtable "결제기록" 표)
--   expenses  : 지출 (기존 Airtable "지출" 표)
--
-- 보안
--   네 테이블 모두 RLS(Row Level Security)를 켜고 정책을 하나도 만들지 않습니다.
--   → anon/authenticated 키로는 아무 행도 읽거나 쓸 수 없습니다.
--   → Netlify Function 이 SUPABASE_SERVICE_ROLE_KEY(서비스 롤 키)로만 접근합니다.
--   서비스 롤 키는 RLS 를 우회하므로 "브라우저에 절대 노출하지 않는" 서버 전용
--   환경변수로만 쓰세요.
--
-- 시간 표기 규칙(기존 데이터와 동일)
--   start_time / end_time 은 "HH:MM" 문자열입니다. 자정 종료는 "24:00",
--   다음날 새벽까지 이어지면 24를 더해 저장합니다(다음날 01:30 종료 → "25:30").
--   시간을 time 타입이 아니라 text 로 두는 이유가 이것입니다.
-- ============================================================================

begin;

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- updated_at 자동 갱신용 트리거 함수 ------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ================================ 예약 =====================================
create table if not exists public.bookings (
  id          uuid primary key default gen_random_uuid(),
  book_key    text not null,                                -- 예약키 (브라우저가 만드는 고유 id, 예: rhbrpoig8f1cbf)
  store       text not null check (store in ('1호점', '2호점')),
  date        date not null,
  start_time  text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time    text not null check (end_time   ~ '^[0-4][0-9]:[0-5][0-9]$'),  -- 24:00~47:59 = 자정/다음날 종료
  name        text not null default '',
  phone4      text not null default '',                     -- 연락처 뒷 4자리
  party       text not null default '',                     -- 인원
  note        text not null default '',                     -- 특이사항 (관리자 전용 — 고객용 API 는 절대 내보내지 않음)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists bookings_book_key_key on public.bookings (book_key);
create index if not exists bookings_date_idx          on public.bookings (date);
create index if not exists bookings_store_date_idx    on public.bookings (store, date);
create index if not exists bookings_phone4_idx        on public.bookings (phone4);

comment on table  public.bookings            is '예약 (기존 Airtable 예약 표)';
comment on column public.bookings.book_key   is '예약키 — 결제기록의 pay_key 와 1:1로 연결되는 예약 고유 id';
comment on column public.bookings.store      is '매장: 1호점 / 2호점';
comment on column public.bookings.end_time   is '종료시간 "HH:MM". 자정=24:00, 다음날 새벽=24를 더한 값(예: 25:30)';
comment on column public.bookings.note       is '특이사항 — 관리자 전용, 고객용 캘린더 응답에는 포함되지 않음';

-- ================================ 고객 =====================================
create table if not exists public.customers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text not null default '',                     -- 전체 연락처 (예: 010-1234-5678)
  biz_no      text not null default '',                     -- 사업자등록번호
  biz_name    text not null default '',                     -- 상호
  biz_owner   text not null default '',                     -- 대표자명
  email       text not null default '',                     -- 이메일 (세금계산서 발행용)
  note        text not null default '',                     -- 메모
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists customers_name_idx      on public.customers (name);
create index if not exists customers_phone_idx     on public.customers (phone);
create index if not exists customers_name_lower_idx on public.customers (lower(name));

comment on table  public.customers             is '고객 (기존 Airtable 고객 표)';
comment on column public.customers.phone       is '전체 연락처. 검색은 이름/연락처 부분일치';
comment on column public.customers.biz_no      is '사업자등록번호 (- 없이 저장)';

-- ============================== 결제기록 ===================================
create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  pay_key      text not null,                               -- 예약키(bookings.book_key)와 동일한 값
  store        text not null check (store in ('1호점', '2호점')),
  date         date not null,
  start_time   text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time     text not null check (end_time   ~ '^[0-4][0-9]:[0-5][0-9]$'),
  customer_id  uuid references public.customers (id) on delete set null,
  amount       bigint check (amount is null or amount >= 0), -- 결제금액(원). null = 미입력
  status       text not null default '발행안함'
               check (status in ('발행안함', '세금계산서발행', '현금영수증발행', '카드결제')),
  biz_no       text not null default '',
  biz_name     text not null default '',
  biz_owner    text not null default '',
  email        text not null default '',
  paid         boolean not null default false,              -- 입금완료
  alt_phone    text not null default '',                    -- 안내 받을 번호(추가연락처). 비우면 고객 연락처로 발송
  sms          boolean not null default false,              -- 카톡 대신 문자로 보내기
  note         text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists payments_pay_key_key on public.payments (pay_key);
create index if not exists payments_date_idx          on public.payments (date);
create index if not exists payments_store_date_idx    on public.payments (store, date);
create index if not exists payments_customer_idx      on public.payments (customer_id);
create index if not exists payments_status_date_idx   on public.payments (status, date);

comment on table  public.payments             is '결제기록 (기존 Airtable 결제기록 표)';
comment on column public.payments.pay_key     is '예약키 — bookings.book_key 와 같은 값. 이 값으로 예약과 짝지음';
comment on column public.payments.customer_id is '연결된 고객 (customers.id)';
comment on column public.payments.status      is '발행상태: 발행안함 / 세금계산서발행 / 현금영수증발행 / 카드결제';

-- ================================ 지출 =====================================
create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  date        date not null,
  item        text not null,                                -- 항목명 (예: 임대료)
  amount      bigint not null check (amount >= 0),          -- 금액(원)
  store       text not null default '공통' check (store in ('1호점', '2호점', '공통')),
  note        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists expenses_date_idx       on public.expenses (date);
create index if not exists expenses_store_date_idx on public.expenses (store, date);

comment on table  public.expenses       is '지출 (기존 Airtable 지출 표)';
comment on column public.expenses.store is '지출 지점: 1호점 / 2호점 / 공통';

-- updated_at 트리거 ---------------------------------------------------------
drop trigger if exists bookings_set_updated_at  on public.bookings;
drop trigger if exists customers_set_updated_at on public.customers;
drop trigger if exists payments_set_updated_at  on public.payments;
drop trigger if exists expenses_set_updated_at  on public.expenses;

create trigger bookings_set_updated_at  before update on public.bookings  for each row execute function public.set_updated_at();
create trigger customers_set_updated_at before update on public.customers for each row execute function public.set_updated_at();
create trigger payments_set_updated_at  before update on public.payments  for each row execute function public.set_updated_at();
create trigger expenses_set_updated_at  before update on public.expenses  for each row execute function public.set_updated_at();

-- ================================ 보안 =====================================
-- RLS 를 켜고 정책을 만들지 않는다 → anon/authenticated 로는 아무것도 못 함.
alter table public.bookings  enable row level security;
alter table public.customers enable row level security;
alter table public.payments  enable row level security;
alter table public.expenses  enable row level security;

-- RLS 위에 한 겹 더: 테이블 권한 자체를 anon/authenticated 에서 회수한다.
revoke all on table public.bookings  from anon, authenticated;
revoke all on table public.customers from anon, authenticated;
revoke all on table public.payments  from anon, authenticated;
revoke all on table public.expenses  from anon, authenticated;

-- 서비스 롤(Netlify Function 전용)만 접근한다.
grant all on table public.bookings  to service_role;
grant all on table public.customers to service_role;
grant all on table public.payments  to service_role;
grant all on table public.expenses  to service_role;

commit;

-- 확인용 (선택): 실행 후 아래 주석을 풀어 확인하면 네 테이블이 보입니다.
-- select table_name, (select count(*) from pg_policies p where p.tablename = t.table_name) as policies
-- from information_schema.tables t
-- where t.table_schema = 'public' and t.table_name in ('bookings','customers','payments','expenses');
