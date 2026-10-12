(function () {
  const { esc, request, toast, money, statusPill } = window.bl;
  const STORE_KEY = 'bl_employee';

  const $ = (id) => document.getElementById(id);
  let session = null; // { token, employee }
  let state = null; // /api/menu/today 結果
  let tab = 'menu';
  let selectedDate = null; // null = 今天

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY));
    } catch (_) {
      return null;
    }
  }

  function saveSession(value) {
    try {
      if (value) localStorage.setItem(STORE_KEY, JSON.stringify(value));
      else localStorage.removeItem(STORE_KEY);
    } catch (_) {
      /* 瀏覽器禁用儲存時，登入狀態只維持到重新整理 */
    }
  }

  // LIFF 整合點：正式版在這裡以 liff.getProfile().userId 比對綁定的員工編號，取代手動輸入。
  async function login(employeeId) {
    const data = await request('POST', '/api/auth/employee', { body: { employeeId } });
    session = { token: data.token, employee: data.employee };
    saveSession(session);
  }

  function logout() {
    session = null;
    state = null;
    saveSession(null);
    show();
  }

  async function api(method, url, body) {
    try {
      return await request(method, url, { token: session.token, body });
    } catch (err) {
      if (err.status === 401) {
        logout();
        throw new Error('登入已失效，請重新登入');
      }
      throw err;
    }
  }

  async function refresh() {
    state = await api('GET', `/api/menu${selectedDate ? `?date=${selectedDate}` : ''}`);
    render();
  }

  function show() {
    $('login').classList.toggle('hidden', Boolean(session));
    $('app').classList.toggle('hidden', !session);
    $('who').textContent = session ? `${session.employee.name}（${session.employee.id}）` : '';
    if (session) refresh().catch((e) => toast(e.message));
  }

  // ---------- 畫面 ----------

  function renderStatus() {
    const { ordering, cutoff, date, time } = state;
    const el = $('status');
    if (ordering.open) {
      el.className = 'notice ok';
      el.textContent = `${date}　每天訂餐截止 ${cutoff}（現在 ${time}），截止前可改單或取消；開放訂購當月任一天`;
    } else {
      el.className = 'notice warn';
      el.textContent = `${date}　目前無法訂餐：${ordering.reason}`;
    }
  }

  function renderMenu() {
    const groups = { lunch: '午餐', dinner: '晚餐' };
    const bookedMeals = new Set(state.myOrders.map((o) => o.meal));
    const dates = state.availableDates.includes(state.date)
      ? state.availableDates
      : [state.date, ...state.availableDates].sort();
    let html = `<div class="card"><label for="datePick">訂餐日期（當月）</label>
      <select id="datePick">${dates.map((d) => `<option value="${esc(d)}" ${d === state.date ? 'selected' : ''}>${esc(d)}${d === state.today ? '（今天）' : ''}</option>`).join('')}</select></div>`;
    Object.entries(groups).forEach(([meal, label]) => {
      const items = state.items.filter((i) => i.meal === meal);
      html += `<div class="card"><h2>${label}</h2>`;
      if (items.length === 0) html += '<p class="muted">這天尚未上架菜單</p>';
      items.forEach((item) => {
        const pay = Math.max(0, item.price - state.subsidy);
        const disabled = !state.ordering.open || bookedMeals.has(meal);
        html += `<div class="menu-item">
          <div><div>${esc(item.name)}</div>
            <div class="muted">定價 ${money(item.price)}，補貼後自付 <b>${money(pay)}</b></div></div>
          <button class="primary" data-order="${esc(item.id)}" ${disabled ? 'disabled' : ''}>
            ${bookedMeals.has(meal) ? '已訂' : '訂購'}</button>
        </div>`;
      });
      html += '</div>';
    });
    $('tab-menu').innerHTML = html;
  }

  function orderCard(order) {
    const canChange = order.changeable;
    const canDelegate = order.status === 'booked';
    let html = `<div class="card"><div class="row">
      <div><b>${esc(order.date)}　${esc(order.mealLabel)}　${esc(order.itemName)}</b>
        <div class="muted">自付 ${money(order.amount)}</div></div>
      ${statusPill(order.status)}</div>`;

    if (order.delegateId) {
      html += `<div class="notice info" style="margin-top:10px">
        <div>🤝 指定代領人：<b>${esc(order.delegateName)}</b>（${esc(order.delegateId)}）</div>
        <div class="muted">取餐口需出示下列委託碼，並由代領人輸入自己的員工編號</div>
        <div class="big-code">${esc(order.delegateCode)}</div>
        <div class="qr" data-qr="DLG:${esc(order.delegateCode)}"></div></div>`;
    }
    if (order.status === 'picked') {
      html += `<div class="muted" style="margin-top:8px">取餐人員編：${esc(order.pickedBy)}</div>`;
    }

    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">';
    if (canDelegate && !order.delegateId) {
      html += `<button data-delegate="${esc(order.id)}">🤝 委託同事代領</button>`;
    }
    if (canDelegate && order.delegateId) {
      html += `<button data-undelegate="${esc(order.id)}">取消委託</button>`;
    }
    if (canChange) {
      html += `<button data-transfer="${esc(order.id)}">轉讓訂餐</button>
               <button class="danger" data-cancel="${esc(order.id)}">取消訂單</button>`;
    }
    html += '</div></div>';
    return html;
  }

  function renderOrders() {
    let html = '';
    if (state.upcoming.length === 0) html += '<div class="card muted">本月今天起尚無訂單</div>';
    state.upcoming.forEach((o) => {
      html += orderCard(o);
    });
    if (state.delegatedToMe.length > 0) {
      html += `<div class="card"><h2>${esc(state.date)} 同事委託我代領</h2>`;
      state.delegatedToMe.forEach((o) => {
        html += `<div class="menu-item"><div>${esc(o.mealLabel)}　${esc(o.itemName)}
          <div class="muted">訂餐人：${esc(o.employeeName)}（${esc(o.employeeId)}）</div></div>
          ${statusPill(o.status)}</div>`;
      });
      html += '<p class="muted">取餐時請向對方索取委託碼，並輸入自己的員工編號。</p></div>';
    }
    $('tab-orders').innerHTML = html;
    drawQrs($('tab-orders'));
  }

  function renderPickup() {
    const id = session.employee.id;
    $('tab-pickup').innerHTML = `<div class="card">
      <h2>我的取餐碼</h2>
      <p class="muted">到取餐口出示，或在取餐口輸入員工編號。</p>
      <div class="qr" data-qr="EMP:${esc(id)}"></div>
      <div class="big-code">${esc(id)}</div></div>`;
    drawQrs($('tab-pickup'));
  }

  function drawQrs(root) {
    root.querySelectorAll('[data-qr]').forEach((el) => {
      if (typeof window.qrcode !== 'function') {
        el.textContent = '（QR Code 元件未載入，請改用上方代碼）';
        el.className = 'muted';
        return;
      }
      const qr = window.qrcode(0, 'M');
      qr.addData(el.dataset.qr);
      qr.make();
      el.innerHTML = qr.createImgTag(6, 8);
    });
  }

  function render() {
    renderStatus();
    renderMenu();
    renderOrders();
    renderPickup();
    ['menu', 'orders', 'pickup'].forEach((name) => {
      $(`tab-${name}`).classList.toggle('hidden', name !== tab);
    });
    document.querySelectorAll('.tabs button').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    });
    $('whoLine').textContent = `${session.employee.name}（${session.employee.id}）`;
  }

  // ---------- 事件 ----------

  async function act(fn, okMessage) {
    try {
      await fn();
      if (okMessage) toast(okMessage);
      await refresh();
    } catch (err) {
      toast(err.message, 3600);
    }
  }

  document.addEventListener('change', (event) => {
    if (event.target.id === 'datePick' && session) {
      selectedDate = event.target.value;
      refresh().catch((e) => toast(e.message));
    }
  });

  document.addEventListener('click', (event) => {
    const t = event.target.closest('button');
    if (!t || !session) return;
    const { dataset } = t;

    if (dataset.tab) {
      tab = dataset.tab;
      render();
    } else if (dataset.order) {
      act(() => api('POST', '/api/orders', { itemId: dataset.order, date: state.date }), '訂購成功');
    } else if (dataset.cancel) {
      if (confirm('確定取消這筆訂單？')) {
        act(() => api('DELETE', `/api/orders/${dataset.cancel}`), '已取消');
      }
    } else if (dataset.delegate) {
      const delegateId = prompt('請輸入指定代領同事的員工編號：');
      if (delegateId) {
        act(() => api('POST', `/api/orders/${dataset.delegate}/delegate`, { delegateId: delegateId.trim() }), '已產生委託碼');
        tab = 'orders';
      }
    } else if (dataset.undelegate) {
      act(() => api('DELETE', `/api/orders/${dataset.undelegate}/delegate`), '已取消委託');
    } else if (dataset.transfer) {
      const toEmployeeId = prompt('請輸入受讓同事的員工編號（轉讓後委託設定會一併清除）：');
      if (toEmployeeId) {
        act(() => api('POST', `/api/orders/${dataset.transfer}/transfer`, { toEmployeeId: toEmployeeId.trim() }), '已轉讓');
      }
    }
  });

  $('loginBtn').addEventListener('click', async () => {
    const msg = $('loginMsg');
    msg.classList.add('hidden');
    try {
      await login($('employeeId').value.trim());
      show();
    } catch (err) {
      msg.textContent = err.message;
      msg.classList.remove('hidden');
    }
  });
  $('employeeId').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('loginBtn').click();
  });
  $('logoutBtn').addEventListener('click', logout);

  session = loadSession();
  show();
})();
