const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/store');
const { createApp } = require('../src/app');
const { setClock } = require('../src/time');

const DAY = '2026-10-12';

async function start() {
  const { app } = createApp({ store: createStore(null), adminPassword: 'pw' });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, { token, body } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* csv */ }
    return { status: res.status, json, text };
  }
  return { server, call };
}

test.afterEach(() => setClock(null));

test('完整流程：匯入、上架、訂餐、委託、取餐、未取餐報表', async () => {
  const { server, call } = await start();
  try {
    // 管理員
    assert.equal((await call('POST', '/api/auth/admin', { body: { password: 'bad' } })).status, 401);
    const admin = (await call('POST', '/api/auth/admin', { body: { password: 'pw' } })).json.token;
    assert.equal((await call('GET', '/api/admin/employees')).status, 401, '未登入不可讀取名單');

    await call('PUT', '/api/admin/clock', { token: admin, body: { now: `${DAY}T08:00` } });

    // 取餐口：未登入不可呼叫；建立裝置並登入
    assert.equal((await call('POST', '/api/pickup/lookup', { body: { code: 'E001' } })).status, 401);
    const created = await call('POST', '/api/admin/kiosks', { token: admin, body: { id: 'kiosk-t1', name: '測試' } });
    assert.equal(created.status, 201);
    const kioskLogin = await call('POST', '/api/kiosk/login', { body: { deviceId: 'KIOSK-T1', key: created.json.key } });
    const kiosk = kioskLogin.json.token;
    const imp = await call('POST', '/api/admin/employees/import', {
      token: admin,
      body: { csv: '員工編號,姓名,部門\nE001,甲,行政\nE002,乙,研發\nE003,丙,業務' },
    });
    assert.equal(imp.json.created, 3);
    const menu = await call('PUT', '/api/admin/menu', {
      token: admin,
      body: {
        date: DAY,
        items: [
          { meal: 'lunch', name: '雞腿飯', price: 60 },
          { meal: 'lunch', name: '排骨飯', price: 70 },
        ],
      },
    });
    assert.equal(menu.status, 200);

    // 非員工無法登入
    assert.equal((await call('POST', '/api/auth/employee', { body: { employeeId: 'X1' } })).status, 403);

    const e1 = (await call('POST', '/api/auth/employee', { body: { employeeId: 'E001' } })).json.token;
    const e2 = (await call('POST', '/api/auth/employee', { body: { employeeId: 'E003' } })).json.token;

    const today = await call('GET', '/api/menu/today', { token: e1 });
    assert.equal(today.json.ordering.open, true);
    assert.equal(today.json.items.length, 2);

    const order = await call('POST', '/api/orders', { token: e1, body: { itemId: today.json.items[0].id } });
    assert.equal(order.status, 201);

    // 未指定代領人不可委託
    assert.equal((await call('POST', `/api/orders/${order.json.id}/delegate`, { token: e1, body: {} })).status, 400);
    const delegated = await call('POST', `/api/orders/${order.json.id}/delegate`, { token: e1, body: { delegateId: 'E002' } });
    assert.equal(delegated.json.delegateId, 'E002');
    const code = delegated.json.delegateCode;

    // 別人的訂單不可被其他員工修改
    assert.equal((await call('DELETE', `/api/orders/${order.json.id}`, { token: e2 })).status, 403);

    // 取餐口：委託碼 → 要求輸入員編；錯誤員編被拒絕；正確員編放行
    setClock(`${DAY}T12:00`);
    const lookup = await call('POST', '/api/pickup/lookup', { token: kiosk, body: { code: `DLG:${code}` } });
    assert.equal(lookup.json.status, 'need_employee_id');
    const wrong = await call('POST', '/api/pickup/confirm', { token: kiosk, body: { code, employeeId: 'E003' } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.error, '此委託取餐僅開放給指定同事，員工編號不符，拒絕放行');
    const ok = await call('POST', '/api/pickup/confirm', { token: kiosk, body: { code, employeeId: 'E002' } });
    assert.equal(ok.json.status, 'picked');
    assert.equal(ok.json.pickedVia, 'delegate');
    assert.equal(ok.json.pickedKiosk, 'KIOSK-T1');

    // 另一位訂了沒領 → 13:01 之後出現在扣款清單與 CSV
    setClock(`${DAY}T08:30`);
    const o2 = await call('POST', '/api/orders', { token: e2, body: { itemId: today.json.items[1].id } });
    assert.equal(o2.status, 201);
    setClock(`${DAY}T13:30`);
    const report = await call('GET', `/api/admin/report?date=${DAY}`, { token: admin });
    assert.equal(report.json.totalOrders, 2);
    assert.equal(report.json.picked, 1);
    assert.equal(report.json.unclaimedCount, 1);
    assert.equal(report.json.byPrice['60'], 1);
    assert.equal(report.json.byPrice['70'], 1);
    assert.equal(report.json.deductionList[0].amount, 37);

    const csv = await call('GET', `/api/admin/deductions.csv?date=${DAY}`, { token: admin });
    assert.match(csv.text, /E003/);

    const upd = await call('PUT', `/api/admin/deductions/${o2.json.id}`, { token: admin, body: { status: 'sent_to_hr' } });
    assert.equal(upd.json.deductionStatus, 'sent_to_hr');
  } finally {
    server.close();
  }
});

test('健康檢查端點不需登入且不洩漏資料', async () => {
  const { server, call } = await start();
  try {
    const r = await call('GET', '/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  } finally {
    server.close();
  }
});
