import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, toCsv, rowsToObjects, normalizeHeader } from '../netlify/lib/csv.js';
import {
  normDate, normTime, normStore, normStoreTwo, normStatus, parseAmount, parseBool,
  parseTableCsv, digits
} from '../netlify/lib/import-tables.js';
import { taxRowForPayment, TAX_HEADERS, rowToCsv, CSV_HEADERS, sortRows } from '../netlify/lib/tables.js';

test('CSV 파서: 따옴표·쉼표·줄바꿈·BOM·CRLF', function () {
  const csv = '\uFEFFa,b,c\r\n1,"x, y","줄\n바꿈"\r\n"따옴""표",,\r\n';
  const rows = parseCsv(csv);
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', 'x, y', '줄\n바꿈'],
    ['따옴"표', '', '']
  ]);
  assert.deepEqual(rowsToObjects(rows)[0], { a: '1', b: 'x, y', c: '줄\n바꿈' });
});

test('CSV 파서: 빈 줄은 건너뛴다', function () {
  assert.deepEqual(parseCsv('a,b\r\n\r\n1,2\r\n\r\n'), [['a', 'b'], ['1', '2']]);
});

test('CSV 쓰기: 쉼표·따옴표·줄바꿈만 감싼다', function () {
  assert.equal(toCsv([['a', 'b,c', 'd"e', 'f\ng']]), 'a,"b,c","d""e","f\ng"');
});

test('헤더 정규화: 공백·괄호·BOM 제거', function () {
  assert.equal(normalizeHeader('\uFEFF연락처(뒷4자리)'), '연락처뒷4자리');
  assert.equal(normalizeHeader(' Book Key '), 'bookkey');
});

test('날짜·시간·매장·상태 정규화', function () {
  assert.equal(normDate('2026-11-24'), '2026-11-24');
  assert.equal(normDate('2026.1.5'), '2026-01-05');
  assert.equal(normDate('2026/12/31'), '2026-12-31');
  assert.equal(normDate('2026-02-30'), '');
  assert.equal(normDate(''), '');
  assert.equal(normTime('9:00'), '09:00');
  assert.equal(normTime('24:00'), '24:00');
  assert.equal(normTime('25:30'), '25:30');
  assert.equal(normTime('25:70'), '');
  assert.equal(normStore('1호점'), '1호점');
  assert.equal(normStore('2'), '2호점');
  assert.equal(normStore('공통'), '공통');
  assert.equal(normStoreTwo('공통'), '');
  assert.equal(normStatus('세금계산서'), '세금계산서발행');
  assert.equal(normStatus('카드'), '카드결제');
  assert.equal(normStatus(''), '발행안함');
  assert.equal(normStatus('???'), '');
  assert.equal(parseAmount('150,000원'), 150000);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseBool('Y'), true);
  assert.equal(parseBool('입금완료'), true);
  assert.equal(parseBool('N'), false);
  assert.equal(parseBool(''), false);
  assert.equal(digits('010-1234-5678'), '01012345678');
});

test('고객 CSV: 영문/한글 헤더 모두 읽는다', function () {
  const kr = parseTableCsv('customers', '이름,연락처,사업자등록번호,상호,대표자명,이메일,메모\n김수현,010-1234-5678,123-45-67890,상호명,김대표,a@b.c,단골\n');
  assert.equal(kr.records.length, 1);
  assert.equal(kr.records[0].name, '김수현');
  assert.equal(kr.records[0].biz_no, '123-45-67890');

  const en = parseTableCsv('customers', 'name,phone,bizno,bizname,bizowner,email,note\n박영희,010-9999-8888,,,,\n');
  assert.equal(en.records[0].name, '박영희');
});

test('결제 CSV: 발행상태·금액·입금완료·문자여부 매핑', function () {
  const parsed = parseTableCsv('payments',
    '예약키,매장,날짜,시작,종료,연결된고객,연락처(전체),금액,발행상태,사업자등록번호,상호,대표자명,이메일,입금완료,추가연락처,문자여부,메모\n' +
    'r1,1호점,2026-11-24,10:00,12:00,김수현,010-1234-5678,"150,000",세금계산서발행,111-22-33333,상호,대표,a@b.c,Y,010-0000-0000,Y,메모\n');
  const r = parsed.records[0];
  assert.equal(r.pay_key, 'r1');
  assert.equal(r.amount, 150000);
  assert.equal(r.status, '세금계산서발행');
  assert.equal(r.paid, true);
  assert.equal(r.sms, true);
  assert.equal(r._customerName, '김수현');
  assert.equal(r._customerPhone, '010-1234-5678');
});

test('지출 CSV: 매장이 비면 공통, 금액 필수', function () {
  const parsed = parseTableCsv('expenses', '날짜,항목,금액,매장,메모\n2026-11-05,임대료,500000,,\n2026-11-06,청소,,1호점,\n');
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].store, '공통');
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0].message, /금액/);
});

test('홈택스 세금계산서 행: 공급가액 = 금액/1.1 반올림, 세액 = 차액', function () {
  const row = taxRowForPayment({ date: '2026-11-24', amount: 110000, biz_no: '123-45-67890', biz_name: '상호', biz_owner: '대표', email: 'a@b.c' });
  assert.equal(row.length, TAX_HEADERS.length);
  assert.equal(row[19], '100000');
  assert.equal(row[20], '10000');
  assert.equal(row[1], '20261130');
  const odd = taxRowForPayment({ date: '2026-02-14', amount: 33333, biz_no: '1', biz_name: 'a', biz_owner: 'b' });
  assert.equal(Number(odd[19]) + Number(odd[20]), 33333);
});

test('내보내기 행: 결제는 고객 이름·연락처·입금여부 포함', function () {
  const row = rowToCsv('payments', {
    store: '1호점', date: '2026-11-24', start_time: '10:00', end_time: '12:00',
    amount: 150000, status: '카드결제', biz_no: '', biz_name: '', biz_owner: '', email: '',
    paid: true, alt_phone: '', sms: false, note: '',
    customer: { id: 'c1', name: '김수현', phone: '010-1234-5678' }
  });
  assert.equal(row.length, CSV_HEADERS.payments.length);
  assert.equal(row[4], '김수현');
  assert.equal(row[5], '010-1234-5678');
  assert.equal(row[12], 'Y');
  assert.equal(row[14], 'N');
});

test('정렬: 예약은 날짜·시작시간 순', function () {
  const rows = [
    { date: '2026-11-24', start_time: '18:00' },
    { date: '2026-11-24', start_time: '09:00' },
    { date: '2026-11-20', start_time: '10:00' }
  ];
  assert.deepEqual(sortRows('bookings', rows).map(function (r) { return r.date + ' ' + r.start_time; }),
    ['2026-11-20 10:00', '2026-11-24 09:00', '2026-11-24 18:00']);
});
