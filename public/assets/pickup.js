(function () {
  const { esc, request, toast, money, statusPill } = window.bl;
  const $ = (id) => document.getElementById(id);
  const DEVICE_KEY = 'bl_kiosk_device';

  let token = null;
  let currentTicket = null; // 動態碼驗證通過後由伺服器發的取餐憑證
  let resetTimer = null;
  let stream = null;
  let scanning = false;

  // ---------- 裝置登入 ----------

  function savedDevice() {
    try {
      return JSON.parse(localStorage.getItem(DEVICE_KEY));
    } catch (_) {
      return null;
    }
  }

  function setView(loggedIn) {
    $('kioskLogin').classList.toggle('hidden', loggedIn);
    $('kioskApp').classList.toggle('hidden', !loggedIn);
    $('kioskLogout').classList.toggle('hidden', !loggedIn);
    if (loggedIn) $('scanInput').focus();
  }

  async function login(deviceId, key, remember) {
    const data = await request('POST', '/api/kiosk/login', { body: { deviceId, key } });
    token = data.token;
    if (remember) {
      try {
        localStorage.setItem(DEVICE_KEY, JSON.stringify({ deviceId, key }));
      } catch (_) {
        /* 無法儲存時，重新整理後需再登入 */
      }
    }
    setView(true);
    tick();
  }

  async function autoLogin() {
    const saved = savedDevice();
    if (!saved) return false;
    try {
      await login(saved.deviceId, saved.key, false);
      return true;
    } catch (_) {
      return false;
    }
  }

  function logout() {
    token = null;
    try {
      localStorage.removeItem(DEVICE_KEY);
    } catch (_) {
      /* ignore */
    }
    setView(false);
  }

  // 登入失效（伺服器重啟、裝置被停用）時先嘗試用記住的裝置金鑰重新上線，失敗才回登入畫面
  async function api(method, url, body) {
    try {
      return await request(method, url, { token, body });
    } catch (err) {
      if (err.status !== 401) throw err;
      if (await autoLogin()) return request(method, url, { token, body });
      token = null;
      setView(false);
      throw new Error('取餐口裝置未登入或已停用，請重新登入');
    }
  }

  // ---------- 畫面 ----------

  function resetSoon(ms = 12000) {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(reset, ms);
  }

  function reset() {
    clearTimeout(resetTimer);
    currentTicket = null;
    $('result').classList.add('hidden');
    $('result').innerHTML = '';
    $('scanInput').value = '';
    $('scanInput').focus();
  }

  function showResult(html) {
    const el = $('result');
    el.innerHTML = html;
    el.classList.remove('hidden');
  }

  function orderRow(order, withButton) {
    const delegated = order.delegateId
      ? `<div class="muted">已委託 ${esc(order.delegateName)}（${esc(order.delegateId)}）代領，需由代領人憑委託碼領取</div>`
      : '';
    const star = order.special ? ' <span class="pill warn">★ 特殊</span>' : '';
    const canPick = withButton && order.status === 'booked' && !order.delegateId;
    return `<div class="menu-item">
      <div><div><b>${esc(order.mealLabel)}</b>　${esc(order.itemName)}${star}</div>
        <div class="muted">${esc(order.employeeName)}　自付 ${money(order.amount)}</div>${delegated}</div>
      <div style="text-align:right">${statusPill(order.status)}
        ${canPick ? `<div style="margin-top:6px"><button class="primary" data-pick="${esc(order.id)}" data-emp="${esc(order.employeeId)}">確認取餐</button></div>` : ''}
      </div></div>`;
  }

  function verifyBanner(data) {
    if (data.verified) return '<div class="notice ok">✅ 已驗證動態取餐碼（簽章與時效通過）</div>';
    return '<div class="notice warn">⚠ 手動輸入員編，<b>未經動態碼驗證</b>。取餐紀錄會標記為「手動輸入」。</div>';
  }

  function renderLookup(data) {
    if (data.mode === 'self') {
      currentTicket = data.ticket || null;
      const bad = ['not_found', 'invalid_token', 'manual_disabled'].includes(data.status);
      const tone = data.status === 'ok' ? 'ok' : data.status === 'no_order' ? 'warn' : 'danger';
      let html = `<div class="card"><div class="notice ${tone}"><div class="result-title">${esc(data.message)}</div></div>`;
      if (!bad) html += verifyBanner(data);
      if (data.employee) html += `<div class="muted">${esc(data.employee.name)}（${esc(data.employee.id)}）${esc(data.employee.dept || '')}</div>`;
      (data.orders || []).forEach((o) => {
        html += orderRow(o, true);
      });
      html += '<button id="doneBtn" style="margin-top:12px;width:100%">完成</button></div>';
      showResult(html);
      resetSoon();
      return;
    }

    // 委託取餐
    const o = data.order;
    let html = `<div class="card"><div class="notice ${data.status === 'need_employee_id' ? 'warn' : 'danger'}">
      <div class="result-title">🤝 ${esc(data.message)}</div></div>`;
    html += orderRow(o, false);
    if (data.status === 'need_employee_id') {
      html += `<div class="field" style="margin-top:12px"><label for="delegateEmp">代領人員工編號</label>
        <input id="delegateEmp" autocomplete="off" placeholder="請輸入自己的員工編號" style="font-size:20px"></div>
        <button id="delegateConfirm" class="primary" style="width:100%" data-code="${esc(o.delegateCode)}">確認取餐</button>`;
    }
    html += '<button id="doneBtn" style="margin-top:12px;width:100%">返回</button></div>';
    showResult(html);
    if ($('delegateEmp')) $('delegateEmp').focus();
    resetSoon(30000);
  }

  function renderOutcome(order) {
    const via = order.pickedVia === 'token' ? '已驗證動態碼' : order.pickedVia === 'delegate' ? '委託代領' : '手動輸入（未驗證）';
    showResult(`<div class="card"><div class="notice ok"><div class="result-title">✅ 取餐完成</div>
      <div>${esc(order.employeeName)}　${esc(order.mealLabel)}　${esc(order.itemName)}</div>
      <div class="muted">${esc(via)}</div></div>
      <button id="doneBtn" class="primary" style="width:100%">完成</button></div>`);
    resetSoon(5000);
  }

  function renderError(message) {
    showResult(`<div class="card"><div class="notice danger"><div class="result-title">❌ ${esc(message)}</div></div>
      <button id="doneBtn" style="width:100%">返回</button></div>`);
    resetSoon(8000);
  }

  async function lookup(code) {
    const value = (code || '').trim();
    if (!value) return;
    try {
      renderLookup(await api('POST', '/api/pickup/lookup', { code: value }));
    } catch (err) {
      renderError(err.message);
    }
  }

  async function confirmPickup(payload) {
    try {
      renderOutcome(await api('POST', '/api/pickup/confirm', payload));
    } catch (err) {
      renderError(err.message);
    }
  }

  document.addEventListener('click', (event) => {
    const t = event.target.closest('button');
    if (!t) return;
    if (t.id === 'doneBtn') reset();
    else if (t.dataset.pick) {
      // 動態碼驗證過就用憑證；否則走手動後備（伺服器會記錄為未驗證）
      confirmPickup(currentTicket
        ? { orderId: t.dataset.pick, ticket: currentTicket }
        : { orderId: t.dataset.pick, employeeId: t.dataset.emp });
    } else if (t.id === 'delegateConfirm') {
      confirmPickup({ code: t.dataset.code, employeeId: $('delegateEmp').value.trim() });
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.target.id === 'delegateEmp') $('delegateConfirm').click();
  });

  $('lookupBtn').addEventListener('click', () => lookup($('scanInput').value));
  // USB 條碼槍會以鍵盤輸入方式送出內容並按 Enter
  $('scanInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') lookup($('scanInput').value);
  });

  $('kioskLoginBtn').addEventListener('click', async () => {
    const msg = $('kioskLoginMsg');
    msg.classList.add('hidden');
    try {
      await login($('deviceId').value.trim(), $('deviceKey').value.trim(), true);
      $('deviceKey').value = '';
    } catch (err) {
      msg.textContent = err.message;
      msg.classList.remove('hidden');
    }
  });
  $('deviceKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('kioskLoginBtn').click();
  });
  $('kioskLogout').addEventListener('click', logout);

  // ---------- 相機掃碼（瀏覽器支援 BarcodeDetector 時才顯示按鈕） ----------

  async function toggleCamera() {
    const video = $('video');
    if (scanning) {
      scanning = false;
      if (stream) stream.getTracks().forEach((track) => track.stop());
      video.classList.add('hidden');
      return;
    }
    try {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
      video.classList.remove('hidden');
      await video.play();
      scanning = true;
      const loop = async () => {
        if (!scanning) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length > 0) {
            toggleCamera();
            $('scanInput').value = codes[0].rawValue;
            lookup(codes[0].rawValue);
            return;
          }
        } catch (_) {
          /* 偵測失敗就下一輪再試 */
        }
        setTimeout(loop, 250);
      };
      loop();
    } catch (err) {
      toast(`無法開啟相機：${err.message}`);
    }
  }

  if ('BarcodeDetector' in window && navigator.mediaDevices) {
    $('cameraBtn').classList.remove('hidden');
    $('cameraBtn').addEventListener('click', toggleCamera);
  }

  async function tick() {
    if (!token) return;
    try {
      const s = await api('GET', '/api/pickup/status');
      $('clock').textContent = `${s.kioskId}　${s.date} ${s.time}`;
      $('state').textContent = s.open ? '訂餐進行中（尚未截止）' : '今日訂餐已截止，可進行取餐驗證';
    } catch (_) {
      $('state').textContent = '無法連線到伺服器';
    }
  }

  (async function init() {
    setView(false);
    await autoLogin();
  })();
  setInterval(tick, 30000);
})();
