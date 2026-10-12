(function () {
  const { esc, request, toast, money } = window.bl;
  const $ = (id) => document.getElementById(id);
  const KEY = 'bl_admin';

  let token = null;
  let menuItems = [];

  try {
    token = sessionStorage.getItem(KEY);
  } catch (_) {
    token = null;
  }

  async function api(method, url, body) {
    try {
      return await request(method, url, { token, body });
    } catch (err) {
      if (err.status === 401) logout();
      throw err;
    }
  }

  function fail(err) {
    toast(err.message, 3600);
  }

  function logout() {
    token = null;
    try {
      sessionStorage.removeItem(KEY);
    } catch (_) {
      /* ignore */
    }
    show();
  }

  function today() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    return parts;
  }

  function show() {
    $('login').classList.toggle('hidden', Boolean(token));
    $('app').classList.toggle('hidden', !token);
    $('logoutBtn').classList.toggle('hidden', !token);
    if (token) {
      ['reportDate', 'menuDate', 'exDate'].forEach((id) => {
        if (!$(id).value) $(id).value = today();
      });
      loadReport();
      loadMenu();
      loadEmployees();
      loadConfig();
    }
  }

  // ---------- 報表 ----------

  async function loadReport() {
    try {
      const r = await api('GET', `/api/admin/report?date=${$('reportDate').value}`);
      const tiers = Object.keys(r.byPrice).sort((a, b) => a - b)
        .map((p) => `<div class="stat"><div class="n">${r.byPrice[p]}</div><div class="l">${money(p)} 方案</div></div>`).join('');
      let html = `<div class="stats">
        <div class="stat"><div class="n">${r.totalOrders}</div><div class="l">總訂餐數</div></div>
        <div class="stat"><div class="n">${r.picked}</div><div class="l">已取餐</div></div>
        <div class="stat"><div class="n">${r.waiting}</div><div class="l">待取餐</div></div>
        <div class="stat"><div class="n">${r.unclaimedCount}</div><div class="l">未取餐</div></div>
        <div class="stat"><div class="n">${r.byMeal.lunch}／${r.byMeal.dinner}</div><div class="l">午餐／晚餐</div></div>
        ${tiers}</div>`;

      html += `<div class="card"><h2>未取餐與扣款追蹤</h2>
        <p class="muted">合計待處理金額 ${money(r.deductionTotal)}。「記錄未取餐」與「實際扣款」分開，需人事確認後才送薪資。</p>`;
      if (r.deductionList.length === 0) {
        html += '<p class="muted">目前沒有未取餐紀錄</p>';
      } else {
        html += '<table><tr><th>員編</th><th>姓名</th><th>餐別／品項</th><th class="num">金額</th><th>扣款狀態</th><th></th></tr>';
        r.deductionList.forEach((o) => {
          html += `<tr><td>${esc(o.employeeId)}</td><td>${esc(o.employeeName)}</td>
            <td>${esc(o.mealLabel)}　${esc(o.itemName)}</td><td class="num">${money(o.amount)}</td>
            <td>${deductionLabel(o.deductionStatus)}</td>
            <td><select data-deduction="${esc(o.id)}" aria-label="變更扣款狀態">
              ${['pending', 'sent_to_hr', 'waived'].map((s) => `<option value="${s}" ${s === o.deductionStatus ? 'selected' : ''}>${deductionText(s)}</option>`).join('')}
            </select></td></tr>`;
        });
        html += '</table>';
      }
      html += '</div>';
      $('reportBody').innerHTML = html;
    } catch (err) {
      fail(err);
    }
  }

  function deductionText(s) {
    return { pending: '待處理', sent_to_hr: '已送人事', waived: '已豁免' }[s] || s;
  }

  function deductionLabel(s) {
    const tone = s === 'waived' ? '' : s === 'sent_to_hr' ? 'ok' : 'warn';
    return `<span class="pill ${tone}">${esc(deductionText(s))}</span>`;
  }

  async function exportCsv() {
    try {
      const res = await fetch(`/api/admin/deductions.csv?date=${$('reportDate').value}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('匯出失敗');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `deductions-${$('reportDate').value}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      fail(err);
    }
  }

  // ---------- 菜單 ----------

  async function loadMenu() {
    try {
      menuItems = await api('GET', `/api/admin/menu?date=${$('menuDate').value}`);
      renderMenuRows();
    } catch (err) {
      fail(err);
    }
  }

  function renderMenuRows() {
    if (menuItems.length === 0) {
      $('menuRows').innerHTML = '<p class="muted">這天還沒有菜單，請新增品項。</p>';
      return;
    }
    $('menuRows').innerHTML = menuItems.map((item, i) => `<div class="row" style="margin-bottom:8px;flex-wrap:nowrap">
      <select data-i="${i}" data-f="meal" style="width:90px">
        <option value="lunch" ${item.meal === 'lunch' ? 'selected' : ''}>午餐</option>
        <option value="dinner" ${item.meal === 'dinner' ? 'selected' : ''}>晚餐</option></select>
      <input data-i="${i}" data-f="name" value="${esc(item.name)}" placeholder="品名">
      <input data-i="${i}" data-f="price" value="${esc(item.price)}" inputmode="numeric" style="width:90px" placeholder="金額">
      <button data-remove="${i}" aria-label="刪除品項">✕</button></div>`).join('');
  }

  async function saveMenu() {
    try {
      const items = menuItems.map((i) => ({ id: i.id, meal: i.meal, name: i.name, price: Number(i.price) }));
      menuItems = await api('PUT', '/api/admin/menu', { date: $('menuDate').value, items });
      renderMenuRows();
      toast('菜單已儲存');
    } catch (err) {
      fail(err);
    }
  }

  // ---------- 員工 ----------

  async function loadEmployees() {
    try {
      const list = await api('GET', '/api/admin/employees');
      $('employeeList').innerHTML = list.length === 0
        ? '<p class="muted">尚未匯入員工名單</p>'
        : `<p class="muted">共 ${list.length} 人</p><table><tr><th>員編</th><th>姓名</th><th>部門</th></tr>${
          list.slice(0, 200).map((e) => `<tr><td>${esc(e.id)}</td><td>${esc(e.name)}</td><td>${esc(e.dept)}</td></tr>`).join('')
        }</table>${list.length > 200 ? '<p class="muted">僅顯示前 200 筆</p>' : ''}`;
    } catch (err) {
      fail(err);
    }
  }

  async function importCsv() {
    const msg = $('importMsg');
    try {
      const r = await api('POST', '/api/admin/employees/import', { csv: $('csvText').value });
      msg.className = 'notice ok';
      msg.textContent = `匯入完成：新增 ${r.created}、更新 ${r.updated}、略過 ${r.errors.length}，目前共 ${r.total} 人`
        + (r.errors.length ? `（第 ${r.errors.map((e) => e.line).join('、')} 行有誤）` : '');
      loadEmployees();
    } catch (err) {
      msg.className = 'notice danger';
      msg.textContent = err.message;
    }
  }

  // ---------- 設定 ----------

  async function loadConfig() {
    try {
      const c = await api('GET', '/api/admin/config');
      $('cutoff').value = c.orderCutoff;
      $('subsidy').value = c.subsidy;
      const clock = await api('GET', '/api/admin/clock');
      $('clockNow').textContent = `${clock.taipei.date} ${clock.taipei.time}${clock.simulated ? '（模擬中）' : ''}`;
    } catch (err) {
      fail(err);
    }
  }

  async function setClock(value) {
    try {
      await api('PUT', '/api/admin/clock', { now: value });
      toast(value ? '已套用模擬時間' : '已恢復系統時間');
      loadConfig();
      loadReport();
    } catch (err) {
      fail(err);
    }
  }

  // ---------- 事件 ----------

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.tab) {
      ['report', 'menu', 'employees', 'settings'].forEach((n) => $(`tab-${n}`).classList.toggle('hidden', n !== t.dataset.tab));
      document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === t)));
    } else if (t.dataset.remove !== undefined) {
      menuItems.splice(Number(t.dataset.remove), 1);
      renderMenuRows();
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.f && t.dataset.i !== undefined) menuItems[Number(t.dataset.i)][t.dataset.f] = t.value;
  });

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.deduction) {
      try {
        await api('PUT', `/api/admin/deductions/${t.dataset.deduction}`, { status: t.value });
        toast('已更新扣款狀態');
        loadReport();
      } catch (err) {
        fail(err);
      }
    }
  });

  $('loginBtn').addEventListener('click', async () => {
    const msg = $('loginMsg');
    msg.classList.add('hidden');
    try {
      const r = await request('POST', '/api/auth/admin', { body: { password: $('password').value } });
      token = r.token;
      try {
        sessionStorage.setItem(KEY, token);
      } catch (_) {
        /* ignore */
      }
      show();
    } catch (err) {
      msg.textContent = err.message;
      msg.classList.remove('hidden');
    }
  });
  $('password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('loginBtn').click();
  });
  $('logoutBtn').addEventListener('click', logout);
  $('reportBtn').addEventListener('click', loadReport);
  $('exportBtn').addEventListener('click', exportCsv);
  $('menuLoad').addEventListener('click', loadMenu);
  $('menuAdd').addEventListener('click', () => {
    menuItems.push({ meal: 'lunch', name: '', price: 60 });
    renderMenuRows();
  });
  $('menuSave').addEventListener('click', saveMenu);
  $('importBtn').addEventListener('click', importCsv);
  $('csvFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) $('csvText').value = await file.text();
  });
  $('configSave').addEventListener('click', async () => {
    try {
      await api('PUT', '/api/admin/config', { orderCutoff: $('cutoff').value.trim(), subsidy: $('subsidy').value });
      toast('設定已儲存');
    } catch (err) {
      fail(err);
    }
  });
  $('exAdd').addEventListener('click', async () => {
    try {
      await api('PUT', '/api/admin/exemptions', { date: $('exDate').value, employeeId: $('exEmp').value, reason: $('exReason').value });
      toast('已加入例外名單');
      $('exEmp').value = '';
    } catch (err) {
      fail(err);
    }
  });
  $('clockSet').addEventListener('click', () => {
    if ($('clockInput').value) setClock($('clockInput').value);
  });
  $('clockClear').addEventListener('click', () => setClock(null));

  show();
})();
