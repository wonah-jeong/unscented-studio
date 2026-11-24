// 표(테이블) 공통 정의 — CSV 헤더, 값 변환, 홈택스 세금계산서 양식.
// 관리자 화면·API·CSV 내보내기·가져오기가 모두 이 정의를 함께 쓴다.

export const STORES = ['1호점', '2호점'];
export const EXPENSE_STORES = ['1호점', '2호점', '공통'];
export const STATUSES = ['발행안함', '세금계산서발행', '현금영수증발행', '카드결제'];

export const TABLE_LABEL = {
  bookings: '예약',
  customers: '고객',
  payments: '결제',
  expenses: '지출'
};

// 내보내기 CSV 헤더 — 기존 관리자 화면의 "전체 데이터 내보내기"와 같은 순서/이름.
// (결제만 추가연락처·문자여부·메모를 뒤에 덧붙여, 내보낸 파일을 그대로 다시 가져와도 값이 보존되게 했다.)
export const CSV_HEADERS = {
  bookings: ['매장', '날짜', '시작', '종료', '이름', '연락처(뒷4자리)', '인원', '메모'],
  customers: ['이름', '연락처', '사업자등록번호', '상호', '대표자명', '이메일', '메모'],
  payments: ['매장', '날짜', '시작', '종료', '연결된고객', '연락처(전체)', '금액', '발행상태', '사업자등록번호', '상호', '대표자명', '이메일', '입금완료', '추가연락처', '문자여부', '메모'],
  expenses: ['날짜', '항목', '금액', '매장', '메모']
};

export function yn(b) { return b ? 'Y' : 'N'; }

export function paymentCustomerName(p) {
  if (!p) return '';
  if (p.customer && p.customer.name) return p.customer.name;
  if (p.customer_name) return p.customer_name;
  return '';
}
export function paymentCustomerPhone(p) {
  if (!p) return '';
  if (p.customer && p.customer.phone) return p.customer.phone;
  return '';
}

/** 행 → CSV 한 줄 (배열) */
export function rowToCsv(table, r) {
  if (table === 'bookings') {
    return [r.store, r.date, r.start_time, r.end_time, r.name, r.phone4, r.party, r.note];
  }
  if (table === 'customers') {
    return [r.name, r.phone, r.biz_no, r.biz_name, r.biz_owner, r.email, r.note];
  }
  if (table === 'payments') {
    return [
      r.store, r.date, r.start_time, r.end_time, paymentCustomerName(r), paymentCustomerPhone(r),
      r.amount == null ? '' : r.amount, r.status, r.biz_no, r.biz_name, r.biz_owner, r.email, yn(r.paid),
      r.alt_phone, yn(r.sms), r.note
    ];
  }
  if (table === 'expenses') {
    return [r.date, r.item, r.amount, r.store, r.note];
  }
  return [];
}

export function sortRows(table, rows) {
  const list = (rows || []).slice();
  if (table === 'bookings' || table === 'payments') {
    list.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.start_time !== b.start_time) return a.start_time < b.start_time ? -1 : 1;
      return 0;
    });
  } else if (table === 'expenses') {
    list.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  } else {
    list.sort(function (a, b) { return String(a.name || '') < String(b.name || '') ? -1 : 1; });
  }
  return list;
}

// ---------------------------------------------------------------- 홈택스 세금계산서
// 기존 관리자 화면이 쓰던 홈택스 업로드 양식(60칸) 그대로.
export const TAX_HEADERS = [
  '전자세금계산서종류', '작성일자', '공급자등록번호', '공급자종사업장번호', '공급자상호', '공급자성명', '공급자사업장주소', '공급자업태', '공급자종목', '공급자이메일',
  '공급받는자등록번호', '공급받는자종사업장번호', '공급받는자상호', '공급받는자성명', '공급받는자사업장주소', '공급받는자업태', '공급받는자종목', '공급받는자이메일1', '공급받는자이메일2',
  '공급가액합계', '세액합계', '비고',
  '일자1', '품목1', '규격1', '수량1', '단가1', '공급가액1', '세액1', '품목비고1',
  '일자2', '품목2', '규격2', '수량2', '단가2', '공급가액2', '세액2', '품목비고2',
  '일자3', '품목3', '규격3', '수량3', '단가3', '공급가액3', '세액3', '품목비고3',
  '일자4', '품목4', '규격4', '수량4', '단가4', '공급가액4', '세액4', '품목비고4',
  '현금', '수표', '어음', '외상미수금', '영수청구'
];

// 공급자(사장님) 정보 — 기존 관리자 화면에 박혀 있던 값 그대로.
export const SUPPLIER = {
  bizNo: '7623601014',
  name: '언센티드',
  owner: '정원아'
};

function pad2(n) { n = parseInt(n, 10); return (n < 10 ? '0' : '') + n; }

/** 결제기록 1건 → 홈택스 CSV 한 줄. 작성일자는 그 달 마지막 날로 넣는다(기존과 동일). */
export function taxRowForPayment(p) {
  const iso = String(p.date || '');
  const parts = iso.split('-');
  const y = parts[0] || '0000';
  const m = parseInt(parts[1], 10) || 1;
  const d = parseInt(parts[2], 10) || 1;
  const lastDay = new Date(parseInt(y, 10), m, 0).getDate();
  const writeDate = '' + y + pad2(m) + pad2(lastDay);
  const amount = Number(p.amount) || 0;
  const supply = Math.round(amount / 1.1);
  const vat = amount - supply;
  const bizNo = String(p.biz_no || '').replace(/[^0-9]/g, '');
  const row = new Array(TAX_HEADERS.length).fill('');
  row[0] = '01'; row[1] = writeDate;
  row[2] = SUPPLIER.bizNo; row[4] = SUPPLIER.name; row[5] = SUPPLIER.owner;
  row[10] = bizNo; row[12] = p.biz_name || ''; row[13] = p.biz_owner || ''; row[17] = p.email || '';
  row[19] = String(supply); row[20] = String(vat);
  row[22] = pad2(d); row[27] = String(supply); row[28] = String(vat);
  row[58] = '01';
  return row;
}
