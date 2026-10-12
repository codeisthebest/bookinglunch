(function () {
  const { esc, request, toast, money, statusPill } = window.bl;
  const $ = (id) => document.getElementById(id);
  const KEY = 'bl_admin';

  let token = null;
  let menuItems = [];
  let me = null; // { username, displayName, role, roleLabel, permissions }
  let roleInfo = null;

  const can = (permission) => Boolean(me && me.permissions.includes(permission));

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

  function applyPermissions() {
    document.querySelectorAll('[data-perm]').forEach((el) => {
      el.hidden = !can(el.dataset.perm);
    });
    $('adminWho').textContent = `${me.displayName}（${me.roleLabel}）`;
    $('menuReadonly').hidden = can('menu.edit');
    // 預設選到第一個看得到的分頁
    const first = document.querySelector('.tabs button:not([hidden])');
    if (first) first.click();
  }

  async function show() {
    $('login').classList.toggle('hidden', Boolean(token));
    $('app').classList.toggle('hidden', !token);
    $('adminBar').hidden = !token;
    if (!token) {
      me = null;
      return;
    }
    try {
      me = await api('GET', '/api/admin/me');
    } catch (err) {
      return; // 401 已在 api() 內登出
    }
    applyPermissions();
    ['reportDate', 'menuDate', 'exDate', 'rangeTo'].forEach((id) => {
      if (!$(id).value) $(id).value = today();
    });
    if (can('report.view')) {
      loadReport();
      loadMenu();
    }
    if (can('employees.manage')) {
      loadEmployees();
      loadBindings();
    }
    if (can('config.edit')) loadConfig();
    if (can('kiosks.manage')) loadKiosks();
    if (can('admins.manage')) loadAdmins();
  }

  // ---------- 報表 ----------

  async function loadReport() {
    try {
      const r = await api('GET', `/api/admin/report?date=${$('reportDate').value}`);
      const tiers = Object.keys(r.byPrice).sort((a, b) => a - b)
        .map((p) => `<div class="stat"><div class="n">${r.byPrice[p]}</div><div class="l">${money(p)} 方案</div></div>`).join('');
      const manualTile = r.byVia.manual > 0
        ? `<div class="stat" style="border-color:var(--warn)"><div class="n">${r.byVia.manual}</div><div class="l">手動輸入取餐（未驗證）</div></div>` : '';
      let html = `<div class="stats">
        <div class="stat"><div class="n">${money(r.totalSpend)}</div><div class="l">總訂餐花費</div></div>
        <div class="stat"><div class="n">${money(r.subsidyTotal)}</div><div class="l">公司補貼小計</div></div>
        <div class="stat"><div class="n">${money(r.employeePayTotal)}</div><div class="l">員工自付小計</div></div>
        ${manualTile}
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
        html += '<table><tr><th>員編</th><th>姓名</th><th>部門</th><th>餐別／品項</th><th class="num">金額</th><th>扣款狀態</th><th></th></tr>';
        r.deductionList.forEach((o) => {
          html += `<tr><td>${esc(o.employeeId)}</td><td>${esc(o.employeeName)}</td><td>${esc(o.employeeDept)}</td>
            <td>${esc(o.mealLabel)}　${esc(o.itemName)}</td><td class="num">${money(o.amount)}</td>
            <td>${deductionLabel(o.deductionStatus)}</td>
            <td><select data-deduction="${esc(o.id)}" aria-label="變更扣款狀態" ${can('deduction.manage') ? '' : 'disabled'}>
              ${['pending', 'sent_to_hr', 'waived'].map((s) => `<option value="${s}" ${s === o.deductionStatus ? 'selected' : ''}>${deductionText(s)}</option>`).join('')}
            </select></td></tr>`;
        });
        html += '</table>';
      }
      html += '</div>';

      // 當日訂單明細：含取餐方式，方便稽核「手動輸入」這種未經動態碼驗證的取餐
      const orders = await api('GET', `/api/admin/orders?date=${$('reportDate').value}`);
      const live = orders.filter((o) => o.status !== 'cancelled');
      html += `<div class="card"><h2>當日訂單明細</h2>`;
      if (live.length === 0) {
        html += '<p class="muted">這天沒有訂單</p>';
      } else {
        html += `<table><tr><th>員編</th><th>姓名</th><th>部門</th><th>餐別／品項</th><th>狀態</th><th>取餐方式</th><th>取餐人</th><th>取餐口</th></tr>${
          live.map((o) => `<tr><td>${esc(o.employeeId)}</td><td>${esc(o.employeeName)}</td><td>${esc(o.employeeDept)}</td>
            <td>${esc(o.mealLabel)}　${esc(o.itemName)}${o.special ? ' ★' : ''}</td><td>${statusPill(o.status)}</td>
            <td>${o.pickedVia === 'manual' ? `<span class="pill warn">${esc(o.pickedViaLabel)}</span>` : esc(o.pickedViaLabel || '—')}</td>
            <td>${esc(o.pickedBy || '—')}</td><td>${esc(o.pickedKiosk || '—')}</td></tr>`).join('')
        }</table>`;
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

  // 下載檔案：帶登入憑證取得內容，再交給瀏覽器存檔。檔名優先採用伺服器給的 UTF-8 檔名。
  async function download(url, fallbackName) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        let message = '匯出失敗';
        try {
          message = (await res.json()).error || message;
        } catch (_) {
          /* 非 JSON 回應 */
        }
        throw new Error(message);
      }
      const match = /filename\*=UTF-8''([^;]+)/i.exec(res.headers.get('content-disposition') || '');
      saveBlob(await res.blob(), match ? decodeURIComponent(match[1]) : fallbackName);
    } catch (err) {
      fail(err);
    }
  }

  // 觸發瀏覽器存檔。連結要先掛到頁面上，網址延後釋放：太早釋放時，部分瀏覽器（Safari、Firefox）會下載失敗
  function saveBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // 上傳檔案（原始位元組）。失敗時錯誤物件帶有 details（逐列問題）。
  async function upload(url, file) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `上傳失敗（${res.status}）`);
      err.status = res.status;
      err.details = data && data.details;
      if (res.status === 401) logout();
      throw err;
    }
    return data;
  }

  const isXlsx = (file) => /\.xlsx$/i.test(file.name);

  function problemList(details) {
    if (!details || details.length === 0) return '';
    const shown = details.slice(0, 15).map((d) => `第 ${d.line} 列：${d.message}`);
    return `\n${shown.join('\n')}${details.length > 15 ? `\n…還有 ${details.length - 15} 列` : ''}`;
  }

  async function exportCsv() {
    try {
      const res = await fetch(`/api/admin/deductions.csv?date=${$('reportDate').value}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('匯出失敗');
      saveBlob(await res.blob(), `deductions-${$('reportDate').value}.csv`);
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
    const ro = can('menu.edit') ? '' : 'disabled';
    $('menuRows').innerHTML = menuItems.map((item, i) => {
      const sides = Array.isArray(item.sides) ? item.sides.join('、') : (item.sides || '');
      return `<div class="card" style="padding:12px;margin-bottom:8px">
        <div class="row" style="flex-wrap:nowrap;margin-bottom:8px">
          <select data-i="${i}" data-f="meal" style="width:90px" ${ro}>
            <option value="lunch" ${item.meal === 'lunch' ? 'selected' : ''}>午餐</option>
            <option value="dinner" ${item.meal === 'dinner' ? 'selected' : ''}>晚餐</option></select>
          <input data-i="${i}" data-f="name" value="${esc(item.name)}" placeholder="品名（例如 A餐）" ${ro}>
          <input data-i="${i}" data-f="price" value="${esc(item.price)}" inputmode="numeric" style="width:90px" placeholder="定價" ${ro}>
          ${ro ? '' : `<button data-remove="${i}" aria-label="刪除品項">✕</button>`}</div>
        <div class="row" style="margin-bottom:8px">
          <input data-i="${i}" data-f="main" value="${esc(item.main || '')}" placeholder="主菜" style="flex:1;min-width:140px" ${ro}>
          <input data-i="${i}" data-f="sides" value="${esc(sides)}" placeholder="配菜（用頓號分隔）" style="flex:2;min-width:180px" ${ro}>
          <input data-i="${i}" data-f="veg" value="${esc(item.veg || '')}" placeholder="蔬菜／湯品" style="flex:1;min-width:140px" ${ro}></div>
        <label style="display:flex;gap:8px;align-items:center;margin:0;color:var(--text)">
          <input type="checkbox" data-i="${i}" data-f="special" style="width:auto;min-height:auto" ${item.special ? 'checked' : ''} ${ro}>
          ★ 特殊商品（須於用餐日前 N 天訂購，當日自動鎖定；N 在「系統設定」）</label></div>`;
    }).join('');
  }

  async function saveMenu() {
    try {
      const items = menuItems.map((i) => ({
        id: i.id, meal: i.meal, name: i.name, price: Number(i.price),
        main: i.main, sides: i.sides, veg: i.veg, special: Boolean(i.special),
      }));
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
        : `<p class="muted">共 ${list.length} 人</p><table><tr><th>員編</th><th>姓名</th><th>部門</th><th>LINE</th></tr>${
          list.slice(0, 200).map((e) => `<tr><td>${esc(e.id)}</td><td>${esc(e.name)}</td><td>${esc(e.dept)}</td><td>${e.bound ? '<span class="pill ok">已綁定</span>' : '<span class="pill">未綁定</span>'}</td></tr>`).join('')
        }</table>${list.length > 200 ? '<p class="muted">僅顯示前 200 筆</p>' : ''}`;
    } catch (err) {
      fail(err);
    }
  }

  async function loadBindings() {
    try {
      const list = await api('GET', '/api/admin/bindings');
      $('bindingList').innerHTML = list.length === 0
        ? '<p class="muted">目前沒有已綁定的 LINE 帳號</p>'
        : `<table><tr><th>員編</th><th>姓名</th><th>LINE 名稱</th><th>綁定時間</th><th></th></tr>${
          list.map((b) => `<tr><td>${esc(b.employeeId)}</td><td>${esc(b.employeeName)}</td><td>${esc(b.displayName)}</td>
            <td>${esc(new Date(b.boundAt).toLocaleString('zh-TW'))}</td>
            <td><button class="danger" data-unbind="${esc(b.lineUserId)}">解除綁定</button></td></tr>`).join('')
        }</table>`;
    } catch (err) {
      fail(err);
    }
  }

  let pendingEmployeeFile = null; // 已選的 .xlsx 檔（CSV 會直接讀進文字框）

  async function importCsv() {
    const msg = $('importMsg');
    try {
      const r = pendingEmployeeFile
        ? await upload('/api/admin/employees/import-xlsx', pendingEmployeeFile)
        : await api('POST', '/api/admin/employees/import', { csv: $('csvText').value });
      msg.className = 'notice ok';
      msg.textContent = `匯入完成：新增 ${r.created}、更新 ${r.updated}、略過 ${r.errors.length}，目前共 ${r.total} 人`
        + (r.padded ? `；有 ${r.padded} 筆員編不足位數，已自動補零（請確認 Excel 員編欄位是否為文字格式）` : '')
        + problemList(r.errors);
      msg.style.whiteSpace = 'pre-line';
      loadEmployees();
    } catch (err) {
      msg.className = 'notice danger';
      msg.textContent = err.message + problemList(err.details);
      msg.style.whiteSpace = 'pre-line';
    }
  }

  // ---------- 菜單 Excel／CSV 匯入 ----------

  async function importMenuFile() {
    const msg = $('menuImportMsg');
    const file = $('menuFile').files[0];
    msg.classList.remove('hidden');
    msg.style.whiteSpace = 'pre-line';
    if (!file) {
      msg.className = 'notice warn';
      msg.textContent = '請先選擇檔案';
      return;
    }
    try {
      const r = isXlsx(file)
        ? await upload('/api/admin/menu/import-xlsx', file)
        : await api('POST', '/api/admin/menu/import', { csv: await file.text() });
      msg.className = 'notice ok';
      msg.textContent = `匯入完成：${r.dates} 天、共 ${r.items} 個品項（${r.perDate.map((d) => `${d.date.slice(5)}：${d.count}`).join('、')}）`;
      $('menuFile').value = '';
      loadMenu();
    } catch (err) {
      msg.className = 'notice danger';
      msg.textContent = err.message + problemList(err.details);
    }
  }

  // ---------- 設定 ----------

  async function loadConfig() {
    try {
      const c = await api('GET', '/api/admin/config');
      $('cutoff').value = c.orderCutoff;
      $('subsidy').value = c.subsidy;
      $('specialLeadDays').value = c.specialLeadDays;
      $('employeeIdLength').value = c.employeeIdLength;
      $('allowManualPickup').checked = Boolean(c.allowManualPickup);
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

  // ---------- 取餐口裝置 ----------

  function showKey(deviceId, key) {
    const box = $('kioskKeyNotice');
    box.innerHTML = `裝置 <b>${esc(deviceId)}</b> 的金鑰（只顯示這一次，請立即輸入到平板）：<div class="big-code" style="font-size:18px;word-break:break-all;letter-spacing:0">${esc(key)}</div>`;
    box.classList.remove('hidden');
  }

  async function loadKiosks() {
    try {
      const list = await api('GET', '/api/admin/kiosks');
      $('kioskList').innerHTML = list.length === 0
        ? '<p class="muted">尚未建立取餐口裝置，取餐平板無法登入。</p>'
        : `<table><tr><th>裝置編號</th><th>名稱</th><th>狀態</th><th>最後上線</th><th></th></tr>${
          list.map((k) => `<tr><td>${esc(k.id)}</td><td>${esc(k.name)}</td>
            <td>${k.active ? '<span class="pill ok">啟用</span>' : '<span class="pill danger">已停用</span>'}</td>
            <td>${k.lastSeen ? esc(new Date(k.lastSeen).toLocaleString('zh-TW')) : '—'}</td>
            <td style="white-space:nowrap"><button data-kiosk-reset="${esc(k.id)}">重設金鑰</button>
              <button class="${k.active ? 'danger' : ''}" data-kiosk-toggle="${esc(k.id)}" data-active="${k.active}">${k.active ? '停用' : '啟用'}</button></td></tr>`).join('')
        }</table>`;
    } catch (err) {
      fail(err);
    }
  }

  async function updateKiosk(id, patch, okMessage) {
    try {
      const r = await api('PUT', `/api/admin/kiosks/${encodeURIComponent(id)}`, patch);
      toast(okMessage);
      if (r.key) showKey(id, r.key);
    } catch (err) {
      fail(err);
    }
    loadKiosks();
  }

  // ---------- 管理員帳號 ----------

  async function loadAdmins() {
    try {
      const [roles, admins, audit] = await Promise.all([
        api('GET', '/api/admin/roles'),
        api('GET', '/api/admin/admins'),
        api('GET', '/api/admin/audit'),
      ]);
      roleInfo = roles;
      $('newRole').innerHTML = roles.roles.map((r) => `<option value="${esc(r.key)}">${esc(r.label)}</option>`).join('');
      $('roleHelp').innerHTML = roles.roles.map((r) => `<div><b>${esc(r.label)}</b>：${esc(r.description)}</div>`).join('');

      $('adminList').innerHTML = `<table><tr><th>帳號</th><th>名稱</th><th>角色</th><th>狀態</th><th></th></tr>${
        admins.map((a) => {
          const self = a.username === me.username;
          return `<tr><td>${esc(a.username)}${self ? '（你）' : ''}</td><td>${esc(a.displayName)}</td>
            <td><select data-admin-role="${esc(a.username)}" aria-label="角色" ${self ? 'disabled' : ''}>${
              roles.roles.map((r) => `<option value="${esc(r.key)}" ${r.key === a.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')
            }</select></td>
            <td>${a.active ? '<span class="pill ok">啟用</span>' : '<span class="pill danger">已停用</span>'}</td>
            <td style="white-space:nowrap"><button data-admin-pw="${esc(a.username)}">重設密碼</button>
              ${self ? '' : `<button class="${a.active ? 'danger' : ''}" data-admin-toggle="${esc(a.username)}" data-active="${a.active}">${a.active ? '停用' : '啟用'}</button>`}</td></tr>`;
        }).join('')
      }</table>`;

      $('auditList').innerHTML = audit.length === 0
        ? '<p class="muted">尚無紀錄</p>'
        : `<table><tr><th>時間</th><th>操作者</th><th>動作</th></tr>${
          audit.map((a) => `<tr><td>${esc(new Date(a.at).toLocaleString('zh-TW'))}</td><td>${esc(a.actor)}</td><td>${esc(a.method)} ${esc(a.path)}</td></tr>`).join('')
        }</table>`;
    } catch (err) {
      fail(err);
    }
  }

  async function updateAdmin(username, patch, okMessage) {
    try {
      await api('PUT', `/api/admin/admins/${encodeURIComponent(username)}`, patch);
      toast(okMessage);
    } catch (err) {
      fail(err);
    }
    loadAdmins();
  }

  // ---------- 事件 ----------

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.tab) {
      ['report', 'menu', 'employees', 'settings', 'admins'].forEach((n) => $(`tab-${n}`).classList.toggle('hidden', n !== t.dataset.tab));
      document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === t)));
    } else if (t.dataset.unbind) {
      if (confirm('確定解除這個 LINE 帳號的綁定？對方需要重新綁定才能使用。')) {
        api('DELETE', `/api/admin/bindings/${encodeURIComponent(t.dataset.unbind)}`)
          .then(() => { toast('已解除綁定'); loadBindings(); loadEmployees(); })
          .catch(fail);
      }
    } else if (t.dataset.kioskReset) {
      if (confirm(`重設「${t.dataset.kioskReset}」的金鑰？平板需要用新金鑰重新登入。`)) {
        updateKiosk(t.dataset.kioskReset, { resetKey: true }, '已重設金鑰');
      }
    } else if (t.dataset.kioskToggle) {
      const activate = t.dataset.active !== 'true';
      if (activate || confirm(`確定停用「${t.dataset.kioskToggle}」？這台平板會立即無法取餐。`)) {
        updateKiosk(t.dataset.kioskToggle, { active: activate }, activate ? '已啟用' : '已停用');
      }
    } else if (t.dataset.adminPw) {
      const password = prompt(`請輸入「${t.dataset.adminPw}」的新密碼（至少 8 個字元）。對方目前的登入會立即失效。`);
      if (password) updateAdmin(t.dataset.adminPw, { password }, '密碼已重設');
    } else if (t.dataset.adminToggle) {
      const activate = t.dataset.active !== 'true';
      if (activate || confirm(`確定停用「${t.dataset.adminToggle}」？對方會立即被登出。`)) {
        updateAdmin(t.dataset.adminToggle, { active: activate }, activate ? '已啟用' : '已停用');
      }
    } else if (t.dataset.remove !== undefined) {
      menuItems.splice(Number(t.dataset.remove), 1);
      renderMenuRows();
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.f && t.dataset.i !== undefined) {
      menuItems[Number(t.dataset.i)][t.dataset.f] = t.type === 'checkbox' ? t.checked : t.value;
    }
  });

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.adminRole) {
      updateAdmin(t.dataset.adminRole, { role: t.value }, '角色已更新');
      return;
    }
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
      const r = await request('POST', '/api/auth/admin', { body: { username: $('username').value.trim(), password: $('password').value } });
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
  $('pwBtn').addEventListener('click', async () => {
    const oldPassword = prompt('請輸入目前的密碼：');
    if (!oldPassword) return;
    const newPassword = prompt('請輸入新密碼（至少 8 個字元）：');
    if (!newPassword) return;
    try {
      await api('POST', '/api/admin/me/password', { oldPassword, newPassword });
      toast('密碼已更新');
    } catch (err) {
      fail(err);
    }
  });
  $('kioskAdd').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/admin/kiosks', { id: $('kioskNewId').value.trim(), name: $('kioskNewName').value.trim() });
      toast('已建立裝置');
      showKey(r.kiosk.id, r.key);
      $('kioskNewId').value = '';
      $('kioskNewName').value = '';
      loadKiosks();
    } catch (err) {
      fail(err);
    }
  });
  $('adminAdd').addEventListener('click', async () => {
    try {
      await api('POST', '/api/admin/admins', {
        username: $('newUsername').value.trim(),
        displayName: $('newDisplayName').value.trim(),
        role: $('newRole').value,
        password: $('newPassword').value,
      });
      toast('已建立帳號');
      ['newUsername', 'newDisplayName', 'newPassword'].forEach((id) => { $(id).value = ''; });
      loadAdmins();
    } catch (err) {
      fail(err);
    }
  });
  $('reportBtn').addEventListener('click', loadReport);
  $('exportBtn').addEventListener('click', exportCsv);
  $('menuLoad').addEventListener('click', loadMenu);
  $('menuAdd').addEventListener('click', () => {
    menuItems.push({ meal: 'lunch', name: '', price: 60, main: '', sides: '', veg: '', special: false });
    renderMenuRows();
  });
  $('menuSave').addEventListener('click', saveMenu);
  $('importBtn').addEventListener('click', importCsv);
  $('exportOrdersXlsx').addEventListener('click', () => {
    const from = $('rangeFrom').value || `${$('reportDate').value.slice(0, 7)}-01`;
    const to = $('rangeTo').value || $('reportDate').value;
    download(`/api/admin/export/orders.xlsx?from=${from}&to=${to}`, `orders_${from}_${to}.xlsx`);
  });
  $('exportDeductionsXlsx').addEventListener('click', () => {
    download(`/api/admin/export/deductions.xlsx?date=${$('reportDate').value}`, `deductions_${$('reportDate').value}.xlsx`);
  });
  $('menuExportXlsx').addEventListener('click', () => {
    const month = $('menuDate').value.slice(0, 7);
    download(`/api/admin/export/menu.xlsx?month=${month}`, `menu_${month}.xlsx`);
  });
  $('menuTemplateXlsx').addEventListener('click', () => {
    const month = $('menuDate').value.slice(0, 7);
    download(`/api/admin/templates/menu.xlsx?month=${month}`, `menu_template_${month}.xlsx`);
  });
  $('menuImport').addEventListener('click', importMenuFile);
  $('employeesTemplateXlsx').addEventListener('click', () => download('/api/admin/templates/employees.xlsx', 'employees_template.xlsx'));
  $('employeesExportXlsx').addEventListener('click', () => download('/api/admin/export/employees.xlsx', 'employees.xlsx'));
  $('csvFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (isXlsx(file)) {
      // Excel 檔不經文字框，按「匯入」時直接上傳
      pendingEmployeeFile = file;
      $('csvText').value = '';
      $('csvText').placeholder = `已選擇 Excel 檔：${file.name}（按「匯入」上傳）`;
    } else {
      pendingEmployeeFile = null;
      $('csvText').value = await file.text();
    }
  });
  $('csvText').addEventListener('input', () => {
    if ($('csvText').value) pendingEmployeeFile = null; // 手動貼上內容時，以貼上的內容為準
  });
  $('configSave').addEventListener('click', async () => {
    try {
      await api('PUT', '/api/admin/config', {
        orderCutoff: $('cutoff').value.trim(),
        subsidy: $('subsidy').value,
        specialLeadDays: $('specialLeadDays').value,
        employeeIdLength: $('employeeIdLength').value,
        allowManualPickup: $('allowManualPickup').checked,
      });
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
