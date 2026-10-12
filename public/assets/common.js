// 共用工具：API 呼叫、HTML 跳脫、提示訊息。
window.bl = (function () {
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function request(method, url, { token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `請求失敗（${res.status}）`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(message, ms = 2600) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function money(n) {
    return `$${Number(n || 0).toLocaleString('zh-TW')}`;
  }

  const STATUS_LABEL = {
    booked: ['待取餐', 'warn'],
    picked: ['已取餐', 'ok'],
    unclaimed: ['未取餐', 'danger'],
    cancelled: ['已取消', ''],
    exempt: ['例外免扣', ''],
  };

  function statusPill(status) {
    const [label, tone] = STATUS_LABEL[status] || [status, ''];
    return `<span class="pill ${tone}">${esc(label)}</span>`;
  }

  return { esc, request, toast, money, statusPill };
})();
