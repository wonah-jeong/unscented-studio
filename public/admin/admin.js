/* ==========================================================================
   전용 관리자(/admin) 화면 로직
   - 로그인: /.netlify/functions/admin-auth (30일 유지 쿠키)
   - 데이터: /.netlify/functions/admin-api  (모든 쓰기는 서버에서 서비스 롤 키로만)
   기존 아티팩트 관리자 화면의 기능(달력, 일별 모달, 예약 CRUD, 고객 연결,
   결제/발행/입금, 지출·매출, CSV 내보내기·가져오기)을 그대로 옮겼다.
   ========================================================================== */
(function () {
  'use strict';

  var API = '/.netlify/functions/admin-api';
  var AUTH = '/.netlify/functions/admin-auth';

  var STORE_NAME = { first: '1호점', second: '2호점' };
  var STORE_KEY = { '1호점': 'first', '2호점': 'second' };
  var STATUS_LABEL = { none: '발행안함', tax: '세금계산서발행', cash: '현금영수증발행', card: '카드결제' };
  var STATUS_KEY = { '발행안함': 'none', '세금계산서발행': 'tax', '현금영수증발행': 'cash', '카드결제': 'card' };
  var DOW = ['일', '월', '화', '수', '목', '금', '토'];

  // ------------------------------------------------------------------ 유틸
  function $(id) { return document.getElementById(id); }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function isoOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayIso() { return isoOf(new Date()); }
  function shiftIso(iso, days) {
    var p = String(iso).split('-');
    return isoOf(new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10) + days));
  }
  function timeToMin(t) {
    var p = String(t || '').split(':');
    var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
    if (isNaN(h)) return 0;
    return h * 60 + (isNaN(m) ? 0 : m);
  }
  function minToTime(mins) { return pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60); }
  function isOvernight(end) { return timeToMin(end) > 1440; }
  function fmtEnd(end) {
    var mins = timeToMin(end);
    return mins > 1440 ? '익일 ' + minToTime(mins - 1440) : end;
  }
  function fmtWon(n) { return (Number(n) || 0).toLocaleString('ko-KR') + '원'; }
  function shortWon(n) {
    n = Number(n) || 0;
    if (n >= 100000000) return (Math.round(n / 10000000) / 10) + '억';
    if (n >= 10000) return Math.round(n / 10000) + '만';
    return n.toLocaleString('ko-KR');
  }
  function monthRange(y, m) {
    var from = y + '-' + pad2(m) + '-01';
    var last = new Date(y, m, 0).getDate();
    return { from: from, to: y + '-' + pad2(m) + '-' + pad2(last) };
  }
  function digits(v) { return String(v == null ? '' : v).replace(/[^0-9]/g, ''); }
  function last4(v) {
    var d = digits(v);
    return d.slice(-4);
  }
  function storeKeyOf(name) { return STORE_KEY[name] || null; }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  // ------------------------------------------------------------------ 서버 통신
  function qs(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.join('&');
  }

  function apiUrl(resource, params) {
    var q = qs(params);
    return API + '?resource=' + encodeURIComponent(resource) + (q ? '&' + q : '');
  }

  async function apiCall(method, resource, params, body) {
    var res = await fetch(apiUrl(resource, params), {
      method: method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 401) {
      showLogin('다시 로그인해주세요.');
      throw new Error('로그인이 필요해요.');
    }
    if (!res.ok) {
      var msg = (data && (data.message || data.error)) || ('요청 실패 (' + res.status + ')');
      throw new Error(msg);
    }
    return data || {};
  }
  function apiGet(resource, params) { return apiCall('GET', resource, params); }

  // ------------------------------------------------------------------ 상태
  var state = {
    store: 'first',
    year: new Date().getFullYear(),
    month: new Date().getMonth(),          // 0-based
    bookings: { first: {}, second: {} },   // store -> iso -> [row]
    loadedFrom: null,
    loadedTo: null,
    modalIso: null,
    dayPayments: {},                       // pay_key -> payment row
    dayPaymentsReady: false,
    editingKey: null,                      // 수정 중인 예약의 book_key (없으면 새 예약)
    selectedCustomer: null,
    revYear: new Date().getFullYear(),
    revMonth: new Date().getMonth() + 1
  };

  // ------------------------------------------------------------------ 로그인
  function showLogin(message) {
    $('boot').hidden = true;
    $('appView').hidden = true;
    $('loginView').hidden = false;
    var msg = $('loginMsg');
    msg.textContent = message || '';
    var pw = $('loginPassword');
    if (pw) { pw.value = ''; pw.focus(); }
  }

  function showApp() {
    $('boot').hidden = true;
    $('loginView').hidden = true;
    $('appView').hidden = false;
  }

  async function checkSession() {
    var res = await fetch(AUTH + '?action=session', { credentials: 'same-origin', cache: 'no-store' });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.message) || '세션을 확인하지 못했어요.');
    if (data && data.configured === false) {
      return { authenticated: false, message: data.message };
    }
    return data || { authenticated: false };
  }

  async function boot() {
    try {
      var session = await checkSession();
      if (session.authenticated) {
        showApp();
        await loadMonth(true);
        await loadRevenue();
      } else {
        showLogin(session.message || '');
      }
    } catch (e) {
      showLogin(e.message || '서버에 연결하지 못했어요.');
    }
  }

  $('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = $('loginBtn');
    var msg = $('loginMsg');
    var pw = $('loginPassword').value;
    if (!pw) { msg.textContent = '비밀번호를 입력해주세요.'; return; }
    btn.disabled = true;
    msg.textContent = '확인 중…';
    try {
      var res = await fetch(AUTH + '?action=login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'login', password: pw })
      });
      var data = null;
      try { data = await res.json(); } catch (e2) { data = null; }
      if (!res.ok) throw new Error((data && data.message) || '로그인하지 못했어요.');
      $('loginPassword').value = '';
      msg.textContent = '';
      showApp();
      await loadMonth(true);
      await loadRevenue();
    } catch (err) {
      msg.textContent = err.message || '로그인하지 못했어요.';
    } finally {
      btn.disabled = false;
    }
  });

  $('logoutBtn').addEventListener('click', async function () {
    try {
      await fetch(AUTH + '?action=logout', { method: 'POST', credentials: 'same-origin' });
    } catch (e) { /* 무시 */ }
    state.bookings = { first: {}, second: {} };
    showLogin('로그아웃했어요.');
  });

  // ------------------------------------------------------------------ 탭
  function setTab(name) {
    ['bookings', 'revenue', 'data'].forEach(function (t) {
      var panel = $('tab-' + t);
      if (panel) panel.classList.toggle('active', t === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    if (name === 'revenue' && !state.rev) loadRevenue();
  }
  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
    b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
  });

  // ------------------------------------------------------------------ 달력
  function monthCells(y, m) {
    var first = new Date(y, m, 1);
    var startDow = first.getDay();
    var cells = [];
    for (var i = 0; i < 42; i++) {
      var d = new Date(y, m, 1 - startDow + i);
      cells.push({ iso: isoOf(d), dom: d.getDate(), inMonth: d.getMonth() === m });
    }
    return cells;
  }

  function rowsFor(storeKey, iso) {
    var byDate = state.bookings[storeKey] || {};
    return byDate[iso] || [];
  }

  // 전날 시작해서 이 날짜까지 이어지는 예약 (표시 전용 — 원본은 전날에만 있음)
  function carryOverFor(storeKey, iso) {
    var prev = rowsFor(storeKey, shiftIso(iso, -1)).filter(function (e) { return isOvernight(e.end_time); });
    return prev.map(function (e) {
      return {
        start: '00:00', end: minToTime(timeToMin(e.end_time) - 1440),
        src: e, srcIso: shiftIso(iso, -1)
      };
    });
  }

  function setStore(store) {
    state.store = store;
    Array.prototype.forEach.call(document.querySelectorAll('#storeSwitch button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-store') === store);
    });
    renderCal();
  }
  Array.prototype.forEach.call(document.querySelectorAll('#storeSwitch button'), function (b) {
    b.addEventListener('click', function () {
      closeDay();
      setStore(b.getAttribute('data-store'));
    });
  });

  function renderCal() {
    var label = $('calLabel');
    label.textContent = state.year + '년 ' + (state.month + 1) + '월';
    var cells = monthCells(state.year, state.month);
    var grid = $('calGrid');
    var html = DOW.map(function (d) { return '<div class="cal-dow">' + d + '</div>'; }).join('');
    var today = todayIso();
    cells.forEach(function (c) {
      var own = rowsFor(state.store, c.iso);
      var list = carryOverFor(state.store, c.iso).concat(own);
      var cls = 'cal-cell' + (c.inMonth ? '' : ' other') + (c.iso === today ? ' today' : '');
      var visible = list.slice(0, 4);
      var extra = list.length - visible.length;
      var slots = visible.map(function (e) {
        if (e.src) return '<div class="slot cont">~' + esc(e.end) + '</div>';
        var endTxt = isOvernight(e.end_time) ? minToTime(timeToMin(e.end_time) - 1440) : e.end_time;
        return '<div class="slot">' + esc(e.start_time) + '-' + esc(endTxt) + '</div>';
      }).join('');
      if (extra > 0) slots += '<div class="slot more">+' + extra + '건</div>';
      html += '<div class="' + cls + '" data-iso="' + c.iso + '"><div class="d">' + c.dom + '</div>' + slots + '</div>';
    });
    grid.innerHTML = html;
    Array.prototype.forEach.call(grid.querySelectorAll('.cal-cell'), function (cell) {
      cell.addEventListener('click', function () { openDay(cell.getAttribute('data-iso')); });
    });
  }

  async function loadMonth(initial) {
    var cells = monthCells(state.year, state.month);
    var from = cells[0].iso, to = cells[cells.length - 1].iso;
    try {
      var data = await apiGet('bookings', { from: from, to: to });
      state.bookings = { first: {}, second: {} };
      (data.rows || []).forEach(function (r) {
        var key = storeKeyOf(r.store);
        if (!key) return;
        if (!state.bookings[key][r.date]) state.bookings[key][r.date] = [];
        state.bookings[key][r.date].push(r);
      });
      state.loadedFrom = from;
      state.loadedTo = to;
      renderCal();
      if (!initial && state.modalIso) renderDayList();
    } catch (e) {
      if (!initial) toast(e.message);
      $('calGrid').innerHTML = '<div class="loading" style="grid-column:1/-1;">' + esc(e.message) + '</div>';
    }
  }

  $('calPrev').addEventListener('click', function () {
    state.month -= 1;
    if (state.month < 0) { state.month = 11; state.year -= 1; }
    loadMonth();
  });
  $('calNext').addEventListener('click', function () {
    state.month += 1;
    if (state.month > 11) { state.month = 0; state.year += 1; }
    loadMonth();
  });
  $('refreshBtn').addEventListener('click', function () { loadMonth(); toast('새로 불러왔어요.'); });

  // ------------------------------------------------------------------ 하루 상세
  function fmtDateLabel(iso) {
    var p = iso.split('-');
    return parseInt(p[1], 10) + '월 ' + parseInt(p[2], 10) + '일';
  }

  function closeDay() {
    $('dayModal').classList.remove('open');
    state.modalIso = null;
    state.editingKey = null;
  }
  $('modalClose').addEventListener('click', closeDay);
  $('dayModal').addEventListener('click', function (e) { if (e.target.id === 'dayModal') closeDay(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && $('dayModal').classList.contains('open')) closeDay();
  });

  async function openDay(iso) {
    state.modalIso = iso;
    state.editingKey = null;
    state.selectedCustomer = null;
    state.dayPayments = {};
    state.dayPaymentsReady = false;
    $('modalTitle').textContent = fmtDateLabel(iso);
    $('dayModal').classList.add('open');
    renderDay();
    buildForm();
    await loadDayPayments();
  }

  async function loadDayPayments() {
    var iso = state.modalIso, store = state.store;
    var got = {}, ok = false;
    try {
      var data = await apiGet('payments', { date: iso, store: STORE_NAME[store] });
      (data.rows || []).forEach(function (p) { got[p.pay_key] = p; });
      ok = true;
    } catch (e) {
      ok = false;
    }
    if (state.modalIso !== iso || state.store !== store) return;
    if (ok) {
      state.dayPayments = got;
      state.dayPaymentsReady = true;
      renderDayList();
    } else {
      setSaveStatus('결제 정보를 불러오지 못했어요. 창을 닫았다가 다시 열어주세요.');
    }
  }

  function renderDay() {
    var iso = state.modalIso;
    if (!iso) return;
    var list = rowsFor(state.store, iso);
    var carry = carryOverFor(state.store, iso);
    $('modalSub').textContent = STORE_NAME[state.store] + ' 예약현황 · 총 ' + list.length + '건' +
      (carry.length ? ' (+전날에서 이어지는 예약 ' + carry.length + '건)' : '');
    renderDayList();
  }

  function payBadgeHtml(pay) {
    if (!pay) return '';
    var label = pay.status || '발행안함';
    var amount = pay.amount;
    if (label === '발행안함' && !amount) return '';
    var cls = STATUS_KEY[label] || '';
    var amt = amount ? fmtWon(amount) : '';
    return '<span class="pay-badge ' + cls + '">' + esc([amt, label].filter(Boolean).join(' · ')) + '</span>';
  }

  function renderDayList() {
    var iso = state.modalIso;
    if (!iso) return;
    var list = rowsFor(state.store, iso);
    var carry = carryOverFor(state.store, iso);

    var carryHtml = carry.map(function (c) {
      return '<div class="modal-row cont">' +
        '<div class="row-top"><span>00:00 - ' + esc(c.end) + ' · 전날 ' + esc(c.src.start_time) + ' 시작 예약</span>' +
        '<button type="button" class="cont-go" data-src-iso="' + c.srcIso + '">전날 보기</button></div>' +
        '<div class="row-meta">' + esc(metaOf(c.src)) + '</div>' +
        '</div>';
    }).join('');

    var rowsHtml = list.map(function (e) {
      var pay = state.dayPayments[e.book_key];
      var paid = !!(pay && pay.paid);
      var badge = payBadgeHtml(pay);
      var alt = pay ? digits(pay.alt_phone) : '';
      var notify = (alt || (pay && pay.sms))
        ? '<span class="pay-badge">' + esc([alt ? '안내번호 ' + alt.slice(-4) : '', pay && pay.sms ? '문자발송' : ''].filter(Boolean).join(' · ')) + '</span>'
        : '';
      var toggle = pay
        ? '<button type="button" class="paid-toggle' + (paid ? ' on' : '') + '" data-paid-key="' + esc(e.book_key) + '">' +
          (paid ? '✓ 입금완료' : '입금확인') + '</button>'
        : '';
      return '<div class="modal-row">' +
        '<div class="row-top"><span>' + esc(e.start_time) + ' - ' + esc(fmtEnd(e.end_time)) + '</span>' +
        '<span class="row-actions">' +
        '<button type="button" class="row-edit" data-edit-key="' + esc(e.book_key) + '">수정</button>' +
        '<button type="button" class="row-del" data-del-key="' + esc(e.book_key) + '">삭제</button>' +
        '</span></div>' +
        '<div class="row-meta">' + esc(metaOf(e)) + '</div>' +
        (badge || notify || toggle ? '<div class="badge-row">' + badge + notify + toggle + '</div>' : '') +
        '</div>';
    }).join('');

    var emptyHtml = (carry.length || list.length) ? '' : '<p class="modal-empty">예약된 시간이 없습니다.</p>';
    var el = $('modalList');
    el.innerHTML = carryHtml + rowsHtml + emptyHtml;

    Array.prototype.forEach.call(el.querySelectorAll('.cont-go'), function (b) {
      b.addEventListener('click', function () {
        var iso2 = b.getAttribute('data-src-iso');
        var p = iso2.split('-');
        state.year = parseInt(p[0], 10); state.month = parseInt(p[1], 10) - 1;
        renderCal();
        openDay(iso2);
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll('.row-edit'), function (b) {
      b.addEventListener('click', function () { startEdit(b.getAttribute('data-edit-key')); });
    });
    Array.prototype.forEach.call(el.querySelectorAll('.row-del'), function (b) {
      b.addEventListener('click', function () {
        if (b.getAttribute('data-confirm') === '1') { deleteBooking(b.getAttribute('data-del-key')); return; }
        b.setAttribute('data-confirm', '1');
        b.textContent = '정말 삭제?';
        if (b._t) clearTimeout(b._t);
        b._t = setTimeout(function () {
          b.setAttribute('data-confirm', '0');
          b.textContent = '삭제';
        }, 3000);
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll('.paid-toggle'), function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-paid-key');
        var pay = state.dayPayments[key];
        if (!pay || b.disabled) return;
        var next = !pay.paid;
        b.disabled = true;
        apiCall('PATCH', 'payments', { id: pay.id }, { paid: next }).then(function (res) {
          pay.paid = !!(res.row && res.row.paid);
          b.classList.toggle('on', pay.paid);
          b.textContent = pay.paid ? '✓ 입금완료' : '입금확인';
          b.disabled = false;
        }).catch(function (err) {
          b.disabled = false;
          toast(err.message);
        });
      });
    });
  }

  function metaOf(e) {
    return (e.name || '이름 미입력') + ' · ' + (e.phone4 || '-') + ' · ' + (e.party || '-') + '명' +
      (e.note ? ' · ' + e.note : '');
  }

  // 하루 창 안에서 이동 (입력 중이면 한 번 더 눌러야 이동)
  var navPending = 0;
  function entryFormDirty() {
    var f = $('addEntryForm');
    if (!f) return false;
    if (state.editingKey) return true;
    var names = ['name', 'phone4', 'party', 'note', 'amount', 'bizNo', 'bizName', 'bizOwner', 'bizEmail', 'notifyPhone'];
    for (var i = 0; i < names.length; i++) {
      var el = f.elements[names[i]];
      if (el && String(el.value || '').trim()) return true;
    }
    return !!state.selectedCustomer;
  }
  var navTimer = null;
  function moveDay(delta) {
    if (!state.modalIso) return;
    if (entryFormDirty() && navPending !== delta) {
      navPending = delta;
      setSaveStatus('입력 중인 내용이 있어요. 이동하려면 화살표를 한 번 더 눌러주세요.');
      if (navTimer) clearTimeout(navTimer);
      navTimer = setTimeout(function () { navPending = 0; }, 3000);
      return;
    }
    navPending = 0;
    var next = shiftIso(state.modalIso, delta);
    var p = next.split('-');
    var y = parseInt(p[0], 10), m = parseInt(p[1], 10) - 1;
    if (y !== state.year || m !== state.month) {
      state.year = y; state.month = m;
      renderCal();
      loadMonth();
    }
    openDay(next);
  }
  $('dayPrev').addEventListener('click', function () { moveDay(-1); });
  $('dayNext').addEventListener('click', function () { moveDay(1); });

  // ------------------------------------------------------------------ 예약 입력 폼
  function hourOptions(forEnd) {
    var out = '';
    for (var h = 0; h < 24; h++) {
      var hh = pad2(h);
      out += '<option value="' + hh + '">' + hh + '</option>';
    }
    if (forEnd) out += '<option value="24">24 (자정)</option>';
    return out;
  }
  function minuteOptions() {
    return ['00', '15', '30', '45'].map(function (m) {
      return '<option value="' + m + '">' + m + '</option>';
    }).join('');
  }
  function ensureMinute(select, val) {
    if (!select) return;
    select.value = val;
    if (select.value !== val) {
      var opt = document.createElement('option');
      opt.value = val; opt.textContent = val;
      select.insertBefore(opt, select.firstChild);
      select.value = val;
    }
  }

  function buildForm() {
    var iso = state.modalIso;
    var wrap = $('formWrap');
    if (!iso) { wrap.innerHTML = ''; return; }
    wrap.innerHTML =
      '<form class="admin-form" id="addEntryForm" autocomplete="off">' +
      '  <div class="form-title-row"><span class="label" id="formTitle">+ 예약 추가</span>' +
      '    <button type="button" class="cancel-edit" id="cancelEditBtn" style="display:none;">취소</button></div>' +
      '  <div id="dateRow" style="display:none;">' +
      '    <span class="label">지점·날짜 (바꾸면 그 날짜로 옮겨져요)</span>' +
      '    <div class="row2"><select name="store"><option value="first">1호점</option><option value="second">2호점</option></select>' +
      '      <input type="date" name="date" value="' + iso + '"></div>' +
      '  </div>' +
      '  <div><span class="label">시작 시간</span><div class="row2 time-row">' +
      '    <select name="startHour">' + hourOptions() + '</select><span class="time-sep">:</span>' +
      '    <select name="startMin">' + minuteOptions() + '</select></div></div>' +
      '  <div><span class="label">종료 시간 (시작보다 이르게 고르면 다음날 종료로 저장돼요)</span><div class="row2 time-row">' +
      '    <select name="endHour">' + hourOptions(true) + '</select><span class="time-sep">:</span>' +
      '    <select name="endMin">' + minuteOptions() + '</select></div>' +
      '    <div class="time-preview" id="timePreview"></div></div>' +
      '  <input type="text" name="name" placeholder="고객 이름">' +
      '  <div class="row2">' +
      '    <input type="text" name="phone4" maxlength="4" inputmode="numeric" placeholder="연락처 뒷 4자리">' +
      '    <input type="number" name="party" min="1" placeholder="인원">' +
      '  </div>' +
      '  <input type="text" name="note" placeholder="특이사항 (선택 · 고객 화면에는 안 보여요)">' +
      '  <div class="pay-section">' +
      '    <span class="label">고객 연결 (선택 · 결제/세금계산서 기록용)</span>' +
      '    <div class="cust-selected" id="custSelected" style="display:none;"></div>' +
      '    <div id="custEdit"></div>' +
      '    <div class="row2 cust-search-row"><input type="text" id="custSearchInput" placeholder="이름 또는 연락처로 검색">' +
      '      <button type="button" id="custSearchBtn">검색</button></div>' +
      '    <div class="cust-results" id="custResults"></div>' +
      '    <button type="button" class="cust-new-btn" id="custNewBtn">+ 새 고객으로 등록</button>' +
      '    <div class="cust-new-form" id="custNewForm" style="display:none;">' +
      '      <input type="text" id="custNewName" placeholder="고객 이름">' +
      '      <input type="tel" id="custNewPhone" placeholder="연락처 (전체, 예: 010-1234-5678)">' +
      '      <button type="button" id="custNewConfirm">등록하고 선택</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="row2">' +
      '    <input type="number" name="amount" min="0" step="1" placeholder="결제금액 (원, 선택)">' +
      '    <select name="issueStatus">' +
      '      <option value="none">발행안함</option><option value="tax">세금계산서발행</option>' +
      '      <option value="cash">현금영수증발행</option><option value="card">카드결제</option></select>' +
      '  </div>' +
      '  <div class="biz-fields" id="bizFields" style="display:none;">' +
      '    <p class="biz-hint">세금계산서 발행을 위해 필요해요.</p>' +
      '    <input type="text" name="bizNo" placeholder="사업자등록번호 (- 없이)">' +
      '    <input type="text" name="bizName" placeholder="사업자 상호">' +
      '    <input type="text" name="bizOwner" placeholder="사업자 성명 (대표자명)">' +
      '    <input type="email" name="bizEmail" placeholder="이메일 (선택)">' +
      '    <label class="save-to-cust"><input type="checkbox" name="saveToCustomer" checked> 이 정보를 고객 정보에도 저장</label>' +
      '  </div>' +
      '  <div class="pay-section">' +
      '    <span class="label">안내 받을 번호 (선택 · 비워두면 고객 연락처로 발송)</span>' +
      '    <div class="row2"><input type="tel" name="notifyPhone" inputmode="tel" placeholder="예: 010-1234-5678"></div>' +
      '    <label class="save-to-cust"><input type="checkbox" name="notifySms"> 카톡 대신 문자로 보내기</label>' +
      '  </div>' +
      '  <button type="submit" id="submitBtn">추가하기</button>' +
      '  <div class="save-status" id="saveStatus"></div>' +
      '</form>';

    var form = $('addEntryForm');
    $('cancelEditBtn').addEventListener('click', cancelEdit);
    form.elements.issueStatus.addEventListener('change', function () {
      updateIssueStatusUI();
      form.removeAttribute('data-overlap-ack');
    });
    ['startHour', 'startMin', 'endHour', 'endMin'].forEach(function (n) {
      form.elements[n].addEventListener('change', function () {
        updateTimePreview();
        form.removeAttribute('data-overlap-ack');
      });
    });
    form.elements.store.addEventListener('change', function () { form.removeAttribute('data-overlap-ack'); });
    form.elements.date.addEventListener('change', function () { form.removeAttribute('data-overlap-ack'); });
    updateTimePreview();
    refreshCustSelected();
    updateIssueStatusUI();

    $('custSearchBtn').addEventListener('click', runCustSearch);
    $('custSearchInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runCustSearch(); }
    });
    $('custNewBtn').addEventListener('click', function () {
      var box = $('custNewForm');
      var show = box.style.display === 'none';
      box.style.display = show ? 'flex' : 'none';
      if (show) $('custNewName').value = form.elements.name.value || '';
    });
    $('custNewConfirm').addEventListener('click', createAndSelectCustomer);

    form.addEventListener('submit', onSubmitBooking);
  }

  function setSaveStatus(msg) {
    var el = $('saveStatus');
    if (el) el.textContent = msg || '';
  }

  function computeTimes(startHour, startMin, endHour, endMin) {
    var start = startHour + ':' + startMin;
    var s = timeToMin(start);
    var e = parseInt(endHour, 10) * 60 + parseInt(endMin, 10);
    if (e > 1440) e -= 1440;
    if (e === s) return { error: '시작 시간과 종료 시간이 같아요.' };
    if (e < s) e += 1440;
    var mins = e - s;
    if (mins > 18 * 60) return { error: '예약 시간이 18시간을 넘어요. 종료 시간을 다시 확인해주세요.' };
    return { start: start, end: minToTime(e), mins: mins, overnight: e > 1440 };
  }

  function durationLabel(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    return '총 ' + (h ? h + '시간' : '') + (m ? (h ? ' ' : '') + m + '분' : '');
  }

  function updateTimePreview() {
    var form = $('addEntryForm');
    var el = $('timePreview');
    if (!form || !el) return;
    var t = computeTimes(form.elements.startHour.value, form.elements.startMin.value, form.elements.endHour.value, form.elements.endMin.value);
    el.classList.remove('overnight');
    if (t.error) { el.textContent = t.error; return; }
    if (t.overnight) {
      el.classList.add('overnight');
      el.textContent = '→ 다음날 ' + minToTime(timeToMin(t.end) - 1440) + ' 종료 (' + durationLabel(t.mins) + ')';
    } else {
      el.textContent = '→ ' + t.start + ' ~ ' + t.end + ' (' + durationLabel(t.mins) + ')';
    }
  }

  function refreshCustSelected() {
    var box = $('custSelected');
    if (!box) return;
    if (state.selectedCustomer) {
      var c = state.selectedCustomer;
      box.style.display = 'flex';
      box.innerHTML = '<span>선택됨: ' + esc(c.name) + (c.phone4 ? ' (' + esc(c.phone4) + ')' : '') + '</span>' +
        '<span class="btns"><button type="button" id="custEditBtn">정보 수정</button>' +
        '<button type="button" id="custClearBtn">변경</button></span>';
      $('custClearBtn').addEventListener('click', function () {
        state.selectedCustomer = null;
        var ed = $('custEdit');
        if (ed) ed.innerHTML = '';
        refreshCustSelected();
      });
      $('custEditBtn').addEventListener('click', openCustEdit);
      maybePrefillBiz();
    } else {
      box.style.display = 'none';
      box.innerHTML = '';
    }
  }

  function maybePrefillBiz() {
    var form = $('addEntryForm');
    var c = state.selectedCustomer;
    if (!form || !c || form.elements.issueStatus.value !== 'tax') return;
    if (!form.elements.bizNo.value) form.elements.bizNo.value = c.biz_no || '';
    if (!form.elements.bizName.value) form.elements.bizName.value = c.biz_name || '';
    if (!form.elements.bizOwner.value) form.elements.bizOwner.value = c.biz_owner || '';
    if (!form.elements.bizEmail.value) form.elements.bizEmail.value = c.email || '';
  }

  function updateIssueStatusUI() {
    var form = $('addEntryForm');
    var bizEl = $('bizFields');
    if (!form || !bizEl) return;
    var on = form.elements.issueStatus.value === 'tax';
    bizEl.style.display = on ? 'flex' : 'none';
    if (on) maybePrefillBiz();
  }

  // 고객 검색
  async function runCustSearch() {
    var q = $('custSearchInput').value.trim();
    var results = $('custResults');
    if (!q) { results.innerHTML = ''; return; }
    results.innerHTML = '<div class="cust-result-empty">검색 중…</div>';
    try {
      var data = await apiGet('customers', { q: q });
      var rows = data.rows || [];
      if (!rows.length) { results.innerHTML = '<div class="cust-result-empty">일치하는 고객이 없어요.</div>'; return; }
      results.innerHTML = rows.map(function (r, i) {
        var ph4 = last4(r.phone);
        return '<button type="button" class="cust-result-btn" data-i="' + i + '">' + esc(r.name || '이름 없음') +
          (ph4 ? ' (' + esc(ph4) + ')' : '') + '</button>';
      }).join('');
      Array.prototype.forEach.call(results.querySelectorAll('.cust-result-btn'), function (b) {
        b.addEventListener('click', function () {
          var r = rows[parseInt(b.getAttribute('data-i'), 10)];
          selectCustomer(r);
          results.innerHTML = '';
          $('custSearchInput').value = '';
        });
      });
    } catch (e) {
      results.innerHTML = '<div class="cust-result-empty">' + esc(e.message) + '</div>';
    }
  }

  function selectCustomer(r) {
    var form = $('addEntryForm');
    state.selectedCustomer = {
      id: r.id, name: r.name || '', phone4: last4(r.phone),
      biz_no: r.biz_no || '', biz_name: r.biz_name || '', biz_owner: r.biz_owner || '', email: r.email || ''
    };
    if (form && r.name) form.elements.name.value = r.name;
    if (form && last4(r.phone)) form.elements.phone4.value = last4(r.phone);
    refreshCustSelected();
  }

  async function createAndSelectCustomer() {
    var nm = $('custNewName').value.trim();
    var ph = $('custNewPhone').value.trim();
    if (!nm || !ph) { setSaveStatus('새 고객의 이름과 연락처를 입력해주세요.'); return; }
    if (!/^0\d{8,10}$/.test(digits(ph))) { setSaveStatus('연락처를 다시 확인해주세요. (예: 010-1234-5678)'); return; }
    setSaveStatus('고객 등록 중…');
    try {
      var res = await apiCall('POST', 'customers', {}, { name: nm, phone: ph });
      var row = res.row || {};
      selectCustomer(row);
      $('custNewName').value = '';
      $('custNewPhone').value = '';
      $('custNewForm').style.display = 'none';
      setSaveStatus('');
    } catch (e) {
      setSaveStatus(e.message);
    }
  }

  // 고객 정보(이름·연락처) 수정 — 두 번 눌러야 저장
  async function openCustEdit() {
    var el = $('custEdit');
    var c = state.selectedCustomer;
    if (!el || !c) return;
    el.innerHTML = '<div class="cust-result-empty">고객 정보 불러오는 중…</div>';
    var cur;
    try {
      var data = await apiGet('customers', { q: c.name });
      var hit = (data.rows || []).filter(function (r) { return r.id === c.id; })[0];
      if (!hit) throw new Error('고객을 찾지 못했어요.');
      cur = { name: hit.name || '', phone: hit.phone || '' };
    } catch (e) {
      el.innerHTML = '<div class="cust-result-empty">' + esc(e.message) + '</div>';
      return;
    }
    if (state.selectedCustomer !== c) return;
    el.innerHTML =
      '<div class="cust-new-form" style="display:flex;">' +
      '  <p class="biz-hint" style="margin:0;">고객 정보 수정 (고객 목록에 저장돼요)</p>' +
      '  <input type="text" id="custEditName" placeholder="고객 이름">' +
      '  <input type="tel" id="custEditPhone" placeholder="연락처 (예: 010-1234-5678)">' +
      '  <div class="row2"><button type="button" id="custEditSave" style="flex:1;">저장</button>' +
      '    <button type="button" id="custEditCancel" style="flex:1;background:#fff;color:#3c3934;border:1px solid #3c3934;">취소</button></div>' +
      '  <div class="cust-result-empty" id="custEditMsg"></div>' +
      '</div>';
    var nameEl = $('custEditName'), phoneEl = $('custEditPhone');
    var msgEl = $('custEditMsg'), saveEl = $('custEditSave');
    nameEl.value = cur.name;
    phoneEl.value = cur.phone;
    var ack = null;
    function reset() { ack = null; saveEl.textContent = '저장'; msgEl.textContent = ''; }
    nameEl.addEventListener('input', reset);
    phoneEl.addEventListener('input', reset);
    $('custEditCancel').addEventListener('click', function () { el.innerHTML = ''; });
    saveEl.addEventListener('click', async function () {
      var nm = nameEl.value.trim(), ph = phoneEl.value.trim();
      if (!nm) { msgEl.textContent = '이름을 입력해주세요.'; return; }
      if (!/^0\d{8,10}$/.test(digits(ph))) { msgEl.textContent = '연락처를 다시 확인해주세요.'; return; }
      var patch = {}, changes = [];
      if (nm !== cur.name) { patch.name = nm; changes.push('이름: ' + (cur.name || '(없음)') + ' → ' + nm); }
      if (digits(ph) !== digits(cur.phone)) { patch.phone = ph; changes.push('연락처: ' + (cur.phone || '(없음)') + ' → ' + ph); }
      if (!changes.length) { msgEl.textContent = '바뀐 내용이 없어요.'; return; }
      var sig = nm + '|' + ph;
      if (ack !== sig) {
        ack = sig;
        msgEl.textContent = changes.join(' / ') + ' — 맞으면 한 번 더 눌러주세요.';
        saveEl.textContent = '확인하고 저장';
        return;
      }
      saveEl.disabled = true;
      msgEl.textContent = '저장 중…';
      try {
        await apiCall('PATCH', 'customers', { id: c.id }, patch);
        cur = { name: nm, phone: ph };
        var form = $('addEntryForm');
        c.name = nm;
        var old4 = c.phone4;
        c.phone4 = last4(ph);
        if (form && form.elements.phone4 && old4 && form.elements.phone4.value === old4) form.elements.phone4.value = c.phone4;
        refreshCustSelected();
        el.innerHTML = '<div class="cust-result-empty">저장했어요.</div>';
        setTimeout(function () { if ($('custEdit') === el) el.innerHTML = ''; }, 3000);
      } catch (e) {
        saveEl.disabled = false;
        ack = null;
        saveEl.textContent = '저장';
        msgEl.textContent = '저장하지 못했어요: ' + e.message;
      }
    });
  }

  // 겹치는 예약 찾기
  function findOverlaps(storeKey, iso, start, end, selfKey) {
    var s = timeToMin(start), e = timeToMin(end);
    var out = [];
    function check(rows, offset, prefix) {
      (rows || []).forEach(function (b) {
        if (selfKey && b.book_key === selfKey) return;
        var bs = timeToMin(b.start_time) + offset, be = timeToMin(b.end_time) + offset;
        if (bs < e && s < be) out.push(prefix + b.start_time + '-' + fmtEnd(b.end_time) + (b.name ? ' ' + b.name : ''));
      });
    }
    check(rowsFor(storeKey, shiftIso(iso, -1)), -1440, '전날 ');
    check(rowsFor(storeKey, iso), 0, '');
    if (e > 1440) check(rowsFor(storeKey, shiftIso(iso, 1)), 1440, '다음날 ');
    return out;
  }

  // 달력 범위 밖 날짜를 수정·이동할 때 그 날짜 예약을 잠깐 받아온다 (겹침 확인용)
  async function ensureDayLoaded(storeKey, iso) {
    if (state.loadedFrom && iso >= state.loadedFrom && iso <= state.loadedTo) return;
    try {
      var data = await apiGet('bookings', { from: iso, to: iso, store: STORE_NAME[storeKey] });
      var bucket = {};
      (data.rows || []).forEach(function (r) {
        if (!bucket[r.date]) bucket[r.date] = [];
        bucket[r.date].push(r);
      });
      Object.keys(bucket).forEach(function (d) { state.bookings[storeKey][d] = bucket[d]; });
    } catch (e) { /* 겹침 확인은 부가 기능 — 실패해도 저장은 진행 */ }
  }

  function startEdit(key) {
    if (!state.dayPaymentsReady) { setSaveStatus('결제 정보를 불러오는 중이에요. 잠깐 뒤에 다시 눌러주세요.'); return; }
    var row = null;
    rowsFor(state.store, state.modalIso).forEach(function (r) { if (r.book_key === key) row = r; });
    if (!row) return;
    var form = $('addEntryForm');
    if (!form) { buildForm(); form = $('addEntryForm'); }
    state.editingKey = key;
    form.removeAttribute('data-overlap-ack');
    $('dateRow').style.display = 'block';
    form.elements.store.value = state.store;
    form.elements.date.value = state.modalIso;
    var sp = String(row.start_time || '00:00').split(':');
    var endMin = timeToMin(row.end_time || '00:00');
    var endShown = endMin > 1440 ? minToTime(endMin - 1440) : (row.end_time || '00:00');
    var ep = endShown.split(':');
    ensureMinute(form.elements.startMin, sp[1]);
    form.elements.startHour.value = sp[0];
    ensureMinute(form.elements.endMin, ep[1]);
    form.elements.endHour.value = ep[0];
    form.elements.name.value = row.name || '';
    form.elements.phone4.value = row.phone4 || '';
    form.elements.party.value = row.party || '';
    form.elements.note.value = row.note || '';
    $('formTitle').textContent = '예약 수정';
    $('submitBtn').textContent = '수정 완료';
    $('cancelEditBtn').style.display = 'inline-block';

    // 결제기록이 있으면 고객 연결·결제/발행 정보도 함께
    var pay = state.dayPayments[key];
    state.selectedCustomer = null;
    form.elements.notifyPhone.value = (pay && pay.alt_phone) || '';
    form.elements.notifySms.checked = !!(pay && pay.sms);
    if (pay) {
      if (pay.customer && pay.customer.id) {
        state.selectedCustomer = {
          id: pay.customer.id, name: pay.customer.name || '', phone4: row.phone4 || '',
          biz_no: pay.biz_no || '', biz_name: pay.biz_name || '', biz_owner: pay.biz_owner || '', email: pay.email || ''
        };
      }
      form.elements.amount.value = pay.amount == null ? '' : pay.amount;
      var sk = STATUS_KEY[pay.status] || 'none';
      form.elements.issueStatus.value = sk;
      form.elements.bizNo.value = pay.biz_no || '';
      form.elements.bizName.value = pay.biz_name || '';
      form.elements.bizOwner.value = pay.biz_owner || '';
      form.elements.bizEmail.value = pay.email || '';
    }
    refreshCustSelected();
    updateIssueStatusUI();
    updateTimePreview();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function cancelEdit() {
    state.editingKey = null;
    state.selectedCustomer = null;
    buildForm();
  }

  async function onSubmitBooking(e) {
    e.preventDefault();
    var form = $('addEntryForm');
    if (!form) return;
    var t = computeTimes(form.elements.startHour.value, form.elements.startMin.value, form.elements.endHour.value, form.elements.endMin.value);
    if (t.error) { setSaveStatus(t.error); return; }
    var start = t.start, end = t.end;

    var targetIso = state.modalIso, targetStore = state.store;
    if (state.editingKey) {
      var picked = String(form.elements.date.value || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(picked)) { setSaveStatus('날짜를 선택해주세요.'); return; }
      targetIso = picked;
      targetStore = form.elements.store.value === 'second' ? 'second' : 'first';
    }

    var issueStatus = form.elements.issueStatus.value || 'none';
    if (issueStatus !== 'none' && !state.selectedCustomer) { setSaveStatus('발행하려면 먼저 고객을 선택해주세요.'); return; }
    var bizNo = form.elements.bizNo.value.trim(), bizName = form.elements.bizName.value.trim();
    var bizOwner = form.elements.bizOwner.value.trim(), bizEmail = form.elements.bizEmail.value.trim();
    if (issueStatus === 'tax' && (!bizNo || !bizName || !bizOwner)) {
      setSaveStatus('세금계산서 발행에는 사업자등록번호·상호·성명이 필요해요.');
      return;
    }
    var notifyPhone = (form.elements.notifyPhone.value || '').trim();
    if (notifyPhone && !/^0\d{8,10}$/.test(digits(notifyPhone))) {
      setSaveStatus('안내 받을 번호를 다시 확인해주세요. (예: 010-1234-5678)');
      return;
    }

    var amountRaw = (form.elements.amount.value || '').trim();
    var amount = amountRaw === '' ? null : parseInt(amountRaw, 10);
    if (amount !== null && (isNaN(amount) || amount < 0)) { setSaveStatus('결제금액을 숫자로 입력해주세요.'); return; }

    var bookKey = state.editingKey || ('r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    var payload = {
      book_key: bookKey,
      store: STORE_NAME[targetStore],
      date: targetIso,
      start_time: start,
      end_time: end,
      name: form.elements.name.value.trim(),
      phone4: digits(form.elements.phone4.value).slice(0, 4),
      party: form.elements.party.value.trim(),
      note: form.elements.note.value.trim()
    };

    var submitBtn = $('submitBtn');
    if (submitBtn.disabled) return;

    // 겹치는 예약 확인 (한 번 알려주고, 같은 내용으로 다시 누르면 저장)
    await ensureDayLoaded(targetStore, targetIso);
    var conflicts = findOverlaps(targetStore, targetIso, start, end, state.editingKey);
    var ack = targetStore + '|' + targetIso + '|' + start + '|' + end;
    if (conflicts.length && form.getAttribute('data-overlap-ack') !== ack) {
      form.setAttribute('data-overlap-ack', ack);
      setSaveStatus('⚠️ 겹치는 예약이 있어요: ' + conflicts.join(', ') + ' — 그래도 저장하려면 버튼을 한 번 더 눌러주세요.');
      return;
    }

    submitBtn.disabled = true;
    setSaveStatus('저장 중…');
    var hadPayment = !!(state.editingKey && state.dayPayments[state.editingKey]);
    var needsPayment = !!(state.selectedCustomer || amount !== null || issueStatus !== 'none' ||
      notifyPhone || form.elements.notifySms.checked || hadPayment);

    try {
      var saved = await apiCall('POST', 'bookings', {}, payload);
      var row = saved.row || payload;

      if (needsPayment) {
        setSaveStatus('결제/발행 정보 저장 중…');
        var existing = state.dayPayments[bookKey];
        var payBody = {
          pay_key: bookKey,
          store: payload.store,
          date: payload.date,
          start_time: payload.start_time,
          end_time: payload.end_time,
          customer_id: state.selectedCustomer ? state.selectedCustomer.id : null,
          amount: amount,
          status: STATUS_LABEL[issueStatus] || '발행안함',
          biz_no: issueStatus === 'tax' ? bizNo : '',
          biz_name: issueStatus === 'tax' ? bizName : '',
          biz_owner: issueStatus === 'tax' ? bizOwner : '',
          email: issueStatus === 'tax' ? bizEmail : '',
          alt_phone: notifyPhone,
          sms: !!form.elements.notifySms.checked,
          paid: existing ? !!existing.paid : false,
          note: existing ? (existing.note || '') : ''
        };
        await apiCall('POST', 'payments', {}, payBody);
        if (issueStatus === 'tax' && state.selectedCustomer && form.elements.saveToCustomer.checked) {
          try {
            await apiCall('PATCH', 'customers', { id: state.selectedCustomer.id }, {
              biz_no: bizNo, biz_name: bizName, biz_owner: bizOwner, email: bizEmail
            });
          } catch (e2) { /* 부가정보 저장 실패는 무시 */ }
        }
      }

      state.editingKey = null;
      state.selectedCustomer = null;
      setSaveStatus('저장했어요.');
      toast('저장했어요.');

      var p = payload.date.split('-');
      var ny = parseInt(p[0], 10), nm = parseInt(p[1], 10) - 1;
      if (ny !== state.year || nm !== state.month) { state.year = ny; state.month = nm; }
      if (targetStore !== state.store) setStore(targetStore);
      await loadMonth();
      await openDay(payload.date);
      return row;
    } catch (err) {
      setSaveStatus('저장하지 못했어요: ' + err.message);
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function deleteBooking(key) {
    var row = null;
    rowsFor(state.store, state.modalIso).forEach(function (r) { if (r.book_key === key) row = r; });
    if (!row) return;
    try {
      await apiCall('DELETE', 'bookings', { book_key: key });
      toast('삭제했어요.');
      await loadMonth();
      await openDay(state.modalIso);
    } catch (e) {
      toast(e.message);
    }
  }

  // ------------------------------------------------------------------ 매출
  function setExpFormOpen(open) {
    var f = $('expForm');
    if (!f) return;
    f.classList.toggle('open', open);
    if (open && !$('expDate').value) {
      var range = monthRange(state.revYear, state.revMonth);
      var today = todayIso();
      $('expDate').value = (today >= range.from && today <= range.to) ? today : range.from;
    }
  }
  $('expAddBtn').addEventListener('click', function () {
    setExpFormOpen(!$('expForm').classList.contains('open'));
  });

  async function loadRevenue() {
    var range = monthRange(state.revYear, state.revMonth);
    $('revMonthLabel').textContent = state.revYear + '년 ' + state.revMonth + '월';
    $('revStores').innerHTML = '<div class="loading">불러오는 중…</div>';
    $('expArea').innerHTML = '<div class="loading">불러오는 중…</div>';
    $('revNet').innerHTML = '';
    $('revChart').innerHTML = '<div class="loading">불러오는 중…</div>';
    try {
      var data = await apiGet('summary', { from: range.from, to: range.to, months: 12 });
      state.rev = data;
      renderStores(data);
      renderExpenses(data);
      renderNet(data);
      renderChart(data.trend || []);
    } catch (e) {
      $('revStores').innerHTML = '<div class="loading">' + esc(e.message) + '</div>';
      $('expArea').innerHTML = '';
    }
  }

  function storeBlock(label, s, isTotal) {
    var total = s.tax + s.cash + s.card + s.none;
    var vat = Math.round((s.tax + s.cash + s.card) * 0.1);
    return '<div class="rev-store' + (isTotal ? ' total' : '') + '">' +
      '<div class="rev-store-title">' + esc(label) + '<b>' + fmtWon(total) + '</b></div>' +
      '<div class="rev-grid">' +
      '<div class="rev-tile"><div class="k"><i class="dot tax"></i>세금계산서</div><div class="v">' + fmtWon(s.tax) + '</div></div>' +
      '<div class="rev-tile"><div class="k"><i class="dot cash"></i>현금영수증</div><div class="v">' + fmtWon(s.cash) + '</div></div>' +
      '<div class="rev-tile"><div class="k"><i class="dot card"></i>카드결제</div><div class="v">' + fmtWon(s.card) + '</div></div>' +
      '<div class="rev-tile"><div class="k"><i class="dot none"></i>발행안함</div><div class="v">' + fmtWon(s.none) + '</div></div>' +
      '</div>' +
      '<div class="rev-vat">미리 떼어둘 부가세 (세금계산서·현금영수증·카드 합의 10%) — <b>' + fmtWon(vat) + '</b></div>' +
      '</div>';
  }

  function renderStores(data) {
    var total = {
      tax: data.stores.first.tax + data.stores.second.tax,
      cash: data.stores.first.cash + data.stores.second.cash,
      card: data.stores.first.card + data.stores.second.card,
      none: data.stores.first.none + data.stores.second.none
    };
    $('revStores').innerHTML =
      storeBlock('1호점', data.stores.first, false) +
      storeBlock('2호점', data.stores.second, false) +
      storeBlock('합계 (1호점 + 2호점)', total, true) +
      '<div class="desc">입금완료 ' + fmtWon(data.paidTotal) + ' · 미입금 ' + fmtWon(data.unpaidTotal) + '</div>';
  }

  function renderExpenses(data) {
    var exps = data.expenses || [];
    if (!exps.length) {
      $('expArea').innerHTML = '<div class="exp-empty">이번 달에 등록된 비용이 없어요.</div>';
      return;
    }
    var rows = exps.map(function (r) {
      var d = String(r.date || '');
      var dtxt = d ? (parseInt(d.slice(5, 7), 10) + '.' + pad2(parseInt(d.slice(8, 10), 10))) : '';
      return '<tr><td>' + esc(dtxt) + '</td><td>' + esc(r.item) + '</td>' +
        '<td><span class="pill">' + esc(r.store) + '</span></td>' +
        '<td class="memo">' + esc(r.note) + '</td>' +
        '<td class="amt">' + fmtWon(r.amount) + '</td>' +
        '<td><button type="button" class="exp-del" data-id="' + esc(r.id) + '" title="삭제">×</button></td></tr>';
    }).join('');
    $('expArea').innerHTML = '<div class="exp-wrap"><table class="exp-table"><thead><tr>' +
      '<th>날짜</th><th>항목</th><th>지점</th><th>메모</th><th style="text-align:right">금액</th><th></th>' +
      '</tr></thead><tbody>' + rows +
      '<tr class="total"><td colspan="4">이번 달 비용 합계</td><td class="amt">' + fmtWon(data.expenseTotal) + '</td><td></td></tr>' +
      '</tbody></table></div>';

    Array.prototype.forEach.call($('expArea').querySelectorAll('.exp-del'), function (b) {
      b.addEventListener('click', function () {
        if (b.getAttribute('data-confirm') !== '1') {
          b.setAttribute('data-confirm', '1');
          b.textContent = '✓';
          if (b._t) clearTimeout(b._t);
          b._t = setTimeout(function () {
            b.setAttribute('data-confirm', '0');
            b.textContent = '×';
          }, 3000);
          return;
        }
        if (b._t) clearTimeout(b._t);
        b.disabled = true;
        apiCall('DELETE', 'expenses', { id: b.getAttribute('data-id') }).then(function () {
          toast('지출을 삭제했어요.');
          loadRevenue();
        }).catch(function (e) {
          b.disabled = false;
          $('expStatus').textContent = e.message;
        });
      });
    });
  }

  function renderNet(data) {
    $('revNet').innerHTML =
      '<div><div class="net-label">' + state.revMonth + '월 순매출</div>' +
      '<div class="net-sub">총매출 ' + fmtWon(data.revenue) + ' − 비용 ' + fmtWon(data.expenseTotal) + '</div></div>' +
      '<div class="net-value">' + fmtWon(data.net) + '</div>';
  }

  function renderChart(trend) {
    var maxTotal = 0;
    trend.forEach(function (t) { if (t.total > maxTotal) maxTotal = t.total; });
    if (maxTotal <= 0) {
      $('revChart').innerHTML = '<div class="chart-empty">최근 12개월간 매출 데이터가 없어요.</div>';
      return;
    }
    var curKey = state.revYear + '-' + pad2(state.revMonth);
    var MAXH = 140;
    var html = '<div class="chart">';
    trend.forEach(function (t) {
      var h1 = Math.round((t.first / maxTotal) * MAXH);
      var h2 = Math.round((t.second / maxTotal) * MAXH);
      var mm = parseInt(String(t.month).slice(5, 7), 10);
      var yy = String(t.month).slice(2, 4);
      var label = mm === 1 ? yy + "'." + mm + '월' : mm + '월';
      var isCur = t.month === curKey;
      var title = t.month + ' · 1호점 ' + fmtWon(t.first) + ' · 2호점 ' + fmtWon(t.second);
      html += '<div class="chart-col' + (isCur ? ' cur' : '') + '" title="' + esc(title) + '">' +
        '<div class="total">' + (t.total > 0 ? shortWon(t.total) : '') + '</div>' +
        '<div class="chart-bar" style="height:' + MAXH + 'px">' +
        '<div class="seg s1" style="height:' + h1 + 'px"></div>' +
        '<div class="seg s2" style="height:' + h2 + 'px"></div>' +
        '</div>' +
        '<div class="m">' + esc(label) + '</div>' +
        '</div>';
    });
    html += '</div>';
    $('revChart').innerHTML = html;
  }

  $('revPrev').addEventListener('click', function () {
    state.revMonth -= 1;
    if (state.revMonth < 1) { state.revMonth = 12; state.revYear -= 1; }
    loadRevenue();
  });
  $('revNext').addEventListener('click', function () {
    state.revMonth += 1;
    if (state.revMonth > 12) { state.revMonth = 1; state.revYear += 1; }
    loadRevenue();
  });

  $('expForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var date = $('expDate').value;
    var amount = Number($('expAmount').value);
    var item = $('expItem').value.trim();
    var store = $('expStore').value;
    var note = $('expNote').value.trim();
    var status = $('expStatus');
    if (!date || !amount || !item) { status.textContent = '날짜, 금액, 항목명을 입력해주세요.'; return; }
    status.textContent = '저장 중…';
    try {
      await apiCall('POST', 'expenses', {}, { date: date, amount: amount, item: item, store: store, note: note });
      $('expForm').reset();
      setExpFormOpen(false);
      status.textContent = '';
      var range = monthRange(state.revYear, state.revMonth);
      if (date >= range.from && date <= range.to) { loadRevenue(); }
      else { toast('다른 달에 저장했어요.'); }
    } catch (err) {
      status.textContent = err.message;
    }
  });

  // ------------------------------------------------------------------ CSV 내보내기 / 가져오기
  async function download(resource, params, fallbackName) {
    var res = await fetch(apiUrl(resource, params), { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) { showLogin('다시 로그인해주세요.'); return; }
    if (!res.ok) {
      var msg = '다운로드하지 못했어요.';
      try { var j = await res.json(); if (j && j.message) msg = j.message; } catch (e) { /* 무시 */ }
      throw new Error(msg);
    }
    var blob = await res.blob();
    var cd = res.headers.get('content-disposition') || '';
    var m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    var name = m ? decodeURIComponent(m[1]) : fallbackName;
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-export]'), function (b) {
    b.addEventListener('click', async function () {
      var table = b.getAttribute('data-export');
      var status = $('exportStatus');
      status.textContent = 'CSV 만드는 중…';
      try {
        await download('export', { table: table }, 'unscented_' + table + '_' + todayIso() + '.csv');
        status.textContent = '다운로드했어요.';
      } catch (e) {
        status.textContent = e.message;
      }
    });
  });

  $('importBtn').addEventListener('click', async function () {
    var table = $('importTable').value;
    var input = $('importFile');
    var status = $('importStatus');
    var resultEl = $('importResult');
    if (!input.files || !input.files[0]) { status.textContent = 'CSV 파일을 선택해주세요.'; return; }
    var file = input.files[0];
    status.textContent = '가져오는 중… (파일이 크면 조금 걸려요)';
    resultEl.hidden = true;
    try {
      var text = await file.text();
      var res = await apiCall('POST', 'import', { table: table }, { csv: text });
      status.textContent = '완료: ' + (res.written || 0) + '건 반영' +
        (res.updated ? ', 갱신 ' + res.updated + '건' : '') +
        (res.skipped ? ', 건너뜀 ' + res.skipped + '건' : '') +
        (res.errors && res.errors.length ? ', 실패 ' + res.errors.length + '건' : '');
      if (res.errors && res.errors.length) {
        resultEl.hidden = false;
        resultEl.textContent = res.errors.map(function (e) {
          return e.line ? (e.line + '번째 줄: ' + e.message) : e.message;
        }).join('\n');
      }
      input.value = '';
      await loadMonth();
      await loadRevenue();
      toast('가져오기 완료');
    } catch (e) {
      status.textContent = e.message;
    }
  });

  // ------------------------------------------------------------------ 세금계산서
  function openTax() {
    var range = monthRange(state.revYear, state.revMonth);
    if (!$('taxFrom').value) $('taxFrom').value = range.from;
    if (!$('taxTo').value) $('taxTo').value = range.to;
    $('taxStatus').textContent = '';
    $('taxModal').classList.add('open');
  }
  $('taxOpenBtn').addEventListener('click', openTax);
  $('taxModalClose').addEventListener('click', function () { $('taxModal').classList.remove('open'); });
  $('taxModal').addEventListener('click', function (e) {
    if (e.target.id === 'taxModal') $('taxModal').classList.remove('open');
  });
  $('taxRunBtn').addEventListener('click', async function () {
    var from = $('taxFrom').value, to = $('taxTo').value;
    var status = $('taxStatus');
    if (!from || !to) { status.textContent = '시작일과 종료일을 선택해주세요.'; return; }
    if (from > to) { status.textContent = '시작일이 종료일보다 늦을 수 없어요.'; return; }
    status.textContent = '만드는 중…';
    try {
      await download('tax', { from: from, to: to }, 'unscented_세금계산서.csv');
      status.textContent = '다운로드했어요.';
    } catch (e) {
      status.textContent = e.message;
    }
  });

  // ------------------------------------------------------------------ 시작
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
