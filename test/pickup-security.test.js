const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/store');
const { createService, AppError } = require('../src/service');
const { createTokenService } = require('../src/pickup-token');
const { createApp } = require('../src/app');
const { setClock } = require('../src/time');

const DAY = '2026-10-12';

function expectError(fn, status, message) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof AppError, `應為 AppError，實際：${err}`);
    assert.equal(err.status, status);
    if (message) assert.match(err.message, message);
    return true;
  });
}

test.afterEach(() => setClock(null));

// ---------- 動態取餐碼 ----------

test('動態碼：簽章正確且在效期內可驗證，竄改員編或簽章會被拒絕', () => {
  let now = 1_700_000_000_000;
  const tokens = createTokenService({ secret: 's3cret', nowMs: () => now });
  const { token } = tokens.issue('012003');
  assert.match(token, /^P\.012003\.\d+\.[0-9a-f]{16}$/);
  assert.deepEqual(tokens.verify(token), { ok: true, employeeId: '012003' });

  const forged = token.replace('P.012003.', 'P.012004.');
  assert.equal(tokens.verify(forged).reason, 'signature');
  assert.equal(tokens.verify(token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')).reason, 'signature');
  assert.equal(tokens.verify('012003').reason, 'format');

  // 另一把金鑰簽的碼無效
  const other = createTokenService({ secret: 'different', nowMs: () => now });
  assert.equal(other.verify(token).reason, 'signature');
});

test('動態碼：30–60 秒內有效，超過即逾時，截圖轉傳失效', () => {
  let now = 1_700_000_010_000; // 剛好落在某個窗格內
  const tokens = createTokenService({ secret: 'k', nowMs: () => now });
  const { token } = tokens.issue('E001');

  now += 25_000;
  assert.equal(tokens.verify(token).ok, true, '同一窗格或下一窗格仍有效');
  now += 40_000; // 距離簽發 65 秒
  assert.equal(tokens.verify(token).reason, 'expired');
});

test('取餐憑證綁定取餐口裝置，且 2 分鐘後失效', () => {
  let now = 1_700_000_000_000;
  const tokens = createTokenService({ secret: 'k', nowMs: () => now });
  const ticket = tokens.issueTicket('E001', 'KIOSK-01');
  assert.deepEqual(tokens.verifyTicket(ticket, 'KIOSK-01'), { ok: true, employeeId: 'E001' });
  assert.equal(tokens.verifyTicket(ticket, 'KIOSK-02').reason, 'kiosk', '不能拿到別台取餐口用');

  const tampered = `${Buffer.from(JSON.stringify({ e: 'E002', k: 'KIOSK-01', x: now + 60000 })).toString('base64url')}.${ticket.split('.')[1]}`;
  assert.equal(tokens.verifyTicket(tampered, 'KIOSK-01').reason, 'signature');

  now += 121_000;
  assert.equal(tokens.verifyTicket(ticket, 'KIOSK-01').reason, 'expired');
});

// ---------- 取餐流程（服務層） ----------

function setup(options = {}) {
  let now = 1_700_000_000_000;
  const tokens = createTokenService({ secret: 'k', nowMs: () => now });
  const store = createStore(null);
  const service = createService(store, { tokens });
  service.importEmployees('員工編號,姓名,部門\nE001,甲,行政\nE002,乙,研發\nE003,丙,業務');
  service.setMenu(DAY, [
    { meal: 'lunch', name: 'A餐', price: 70, main: '照燒雞排', sides: '蔥爆香腸、蘿蔔滷黑輪', veg: '時蔬兩道' },
    { meal: 'lunch', name: 'B餐', price: 80, main: '炒泡麵', special: true },
  ]);
  if (options.manual === false) service.updateConfig({ allowManualPickup: false });
  setClock(`${DAY}T08:00`);
  const itemId = (name) => service.getMenu(DAY).find((i) => i.name === name).id;
  return { service, tokens, store, itemId, advance: (ms) => { now += ms; } };
}

test('動態碼取餐：驗證通過發憑證，用憑證確認後記錄為「動態碼」與取餐口', () => {
  const { service, tokens, itemId } = setup();
  const order = service.placeOrder('E001', itemId('A餐'));
  setClock(`${DAY}T12:00`);

  const lookup = service.pickupLookup(tokens.issue('E001').token, { kioskId: 'KIOSK-01' });
  assert.equal(lookup.status, 'ok');
  assert.equal(lookup.verified, true);
  assert.ok(lookup.ticket);

  // 憑證不能被別台取餐口使用
  expectError(() => service.pickupConfirm({ orderId: order.id, ticket: lookup.ticket }, { kioskId: 'KIOSK-02' }), 403);

  const picked = service.pickupConfirm({ orderId: order.id, ticket: lookup.ticket }, { kioskId: 'KIOSK-01' });
  assert.equal(picked.status, 'picked');
  assert.equal(picked.pickedVia, 'token');
  assert.equal(picked.pickedKiosk, 'KIOSK-01');
});

test('憑證只能領該員工自己的餐，領不了別人的', () => {
  const { service, tokens, itemId } = setup();
  service.placeOrder('E001', itemId('A餐'));
  const other = service.placeOrder('E002', itemId('A餐'));
  setClock(`${DAY}T12:00`);
  const lookup = service.pickupLookup(tokens.issue('E001').token, { kioskId: 'K' });
  expectError(() => service.pickupConfirm({ orderId: other.id, ticket: lookup.ticket }, { kioskId: 'K' }), 403, /不屬於/);
});

test('逾時或被竄改的動態碼：拒絕且不發憑證', () => {
  const { service, tokens, advance, itemId } = setup();
  service.placeOrder('E001', itemId('A餐'));
  setClock(`${DAY}T12:00`);

  const forged = tokens.issue('E001').token.replace('E001', 'E002');
  const bad = service.pickupLookup(forged, { kioskId: 'K' });
  assert.equal(bad.status, 'invalid_token');
  assert.equal(bad.ticket, undefined);

  const { token } = tokens.issue('E001');
  advance(90_000);
  const stale = service.pickupLookup(token, { kioskId: 'K' });
  assert.equal(stale.status, 'invalid_token');
  assert.match(stale.message, /逾時/);
});

test('手動輸入員編為後備方式：可取餐但記錄為「未驗證」；關閉後拒絕', () => {
  const { service, itemId } = setup();
  const order = service.placeOrder('E001', itemId('A餐'));
  setClock(`${DAY}T12:00`);
  const lookup = service.pickupLookup('E001', { kioskId: 'K' });
  assert.equal(lookup.verified, false);
  assert.equal(lookup.ticket, undefined);
  const picked = service.pickupConfirm({ orderId: order.id, employeeId: 'E001' }, { kioskId: 'K' });
  assert.equal(picked.pickedVia, 'manual');
  assert.equal(picked.pickedViaLabel, '手動輸入（未驗證）');

  const off = setup({ manual: false });
  const o2 = off.service.placeOrder('E001', off.itemId('A餐'));
  setClock(`${DAY}T12:00`);
  assert.equal(off.service.pickupLookup('E001', { kioskId: 'K' }).status, 'manual_disabled');
  expectError(() => off.service.pickupConfirm({ orderId: o2.id, employeeId: 'E001' }, { kioskId: 'K' }), 403, /動態取餐碼/);
  // 動態碼仍然可用
  const ok = off.service.pickupLookup(off.tokens.issue('E001').token, { kioskId: 'K' });
  assert.equal(off.service.pickupConfirm({ orderId: o2.id, ticket: ok.ticket }, { kioskId: 'K' }).pickedVia, 'token');
});

test('委託取餐仍須代領人員編相符；停用手動輸入不影響委託流程', () => {
  const { service, itemId } = setup({ manual: false });
  const order = service.placeOrder('E001', itemId('A餐'));
  const { delegateCode } = service.delegateOrder('E001', order.id, 'E002');
  setClock(`${DAY}T12:00`);
  assert.equal(service.pickupLookup(`DLG:${delegateCode}`, { kioskId: 'K' }).status, 'need_employee_id');
  expectError(() => service.pickupConfirm({ code: delegateCode, employeeId: 'E003' }, { kioskId: 'K' }), 403, /指定同事/);
  expectError(() => service.pickupConfirm({ code: delegateCode, employeeId: 'E001' }, { kioskId: 'K' }), 403, /指定同事/);
  assert.equal(service.pickupConfirm({ code: delegateCode, employeeId: 'E002' }, { kioskId: 'K' }).pickedVia, 'delegate');
});

// ---------- 員編補零 ----------

test('員編補零：匯入與各處輸入都把純數字員編補到 6 碼', () => {
  const { service, itemId } = setup();
  const result = service.importEmployees('員工編號,姓名\n12003,吳宗文\n010683,楊欣怡\n8456,蕭茂全\nE777,字母員編');
  assert.equal(result.created, 4);
  assert.equal(result.padded, 2, '12003 與 8456 被補零');
  assert.ok(service.listEmployees().some((e) => e.id === '012003'));
  assert.ok(service.listEmployees().some((e) => e.id === '008456'));
  assert.ok(service.listEmployees().some((e) => e.id === 'E777'), '含字母的員編不動');

  assert.equal(service.getEmployee('12003').name, '吳宗文');
  assert.equal(service.getEmployee(' e777 ').name, '字母員編', '去空白並轉大寫');

  // 轉讓與委託時輸入沒補零也找得到人
  const order = service.placeOrder('012003', itemId('A餐'));
  assert.equal(service.delegateOrder('012003', order.id, '8456').delegateId, '008456');
  setClock(`${DAY}T12:00`);
  assert.equal(service.pickupLookup('12003', { kioskId: 'K' }).employee.id, '012003');
});

test('員編位數可設定為 0 關閉補零', () => {
  const { service } = setup();
  service.updateConfig({ employeeIdLength: 0 });
  service.importEmployees('員工編號,姓名\n12003,不補零');
  assert.ok(service.listEmployees().some((e) => e.id === '12003'));
  expectError(() => service.updateConfig({ employeeIdLength: 99 }), 400);
});

// ---------- ★ 特殊商品與菜單欄位 ----------

test('★ 特殊商品須提前 3 天訂購，當日與近日鎖定；一般品項不受影響', () => {
  const { service, itemId } = setup();
  const later = '2026-10-20';
  service.setMenu(later, [
    { meal: 'lunch', name: 'A餐', price: 70 },
    { meal: 'lunch', name: 'B餐', price: 80, special: true },
  ]);
  const pick = (d, name) => service.getMenu(d).find((i) => i.name === name).id;

  // 今天（10/12）訂當日 B 餐：鎖定
  expectError(() => service.placeOrder('E001', itemId('B餐')), 409, /特殊商品.*3 天/);
  // 10/14（只差 2 天）鎖定，10/15（差 3 天）可訂
  service.setMenu('2026-10-14', [{ meal: 'lunch', name: 'B餐', price: 80, special: true }]);
  service.setMenu('2026-10-15', [{ meal: 'lunch', name: 'B餐', price: 80, special: true }]);
  expectError(() => service.placeOrder('E001', pick('2026-10-14', 'B餐'), '2026-10-14'), 409);
  const ok = service.placeOrder('E001', pick('2026-10-15', 'B餐'), '2026-10-15');
  assert.equal(ok.special, true);

  // 一般品項當日照常可訂；menuForDate 標示各品項是否可訂
  assert.equal(service.placeOrder('E001', itemId('A餐')).special, false);
  const view = service.menuForDate('E002', DAY);
  const b = view.items.find((i) => i.name === 'B餐');
  assert.equal(b.orderable, false);
  assert.match(b.lockReason, /3 天/);
  assert.equal(view.items.find((i) => i.name === 'A餐').orderable, true);
  assert.equal(service.menuForDate('E002', later).items.find((i) => i.name === 'B餐').orderable, true);
});

test('提前天數可調整為 0，特殊商品即回到一般規則', () => {
  const { service, itemId } = setup();
  service.updateConfig({ specialLeadDays: 0 });
  assert.equal(service.placeOrder('E001', itemId('B餐')).special, true);
});

test('菜單可記錄主菜、配菜與蔬菜；配菜接受頓號或逗號分隔', () => {
  const { service } = setup();
  const a = service.getMenu(DAY).find((i) => i.name === 'A餐');
  assert.equal(a.main, '照燒雞排');
  assert.deepEqual(a.sides, ['蔥爆香腸', '蘿蔔滷黑輪']);
  assert.equal(a.veg, '時蔬兩道');
  service.setMenu(DAY, [{ meal: 'lunch', name: 'X', price: 60, sides: ['甲', '乙'] }]);
  assert.deepEqual(service.getMenu(DAY)[0].sides, ['甲', '乙']);
});

// ---------- 部門與統計 ----------

test('部門可用「部門」單欄，或「部門代號」＋「部門名稱」兩欄', () => {
  const { service } = setup();
  service.importEmployees('部門代號,員工編號,姓名\n2100,010412,黃文杰');
  service.importEmployees('員工編號,姓名,部門代號,部門名稱\n011591,許傑源,2100,資訊中心');
  service.importEmployees('員工編號,姓名,部門\n009513,游巽傑,2200 安衛室');
  const byId = Object.fromEntries(service.listEmployees().map((e) => [e.id, e.dept]));
  assert.equal(byId['010412'], '2100');
  assert.equal(byId['011591'], '2100 資訊中心');
  assert.equal(byId['009513'], '2200 安衛室');
});

test('日報表統計：總花費、公司補貼、員工自付與取餐方式', () => {
  const { service, tokens, itemId } = setup();
  const o1 = service.placeOrder('E001', itemId('A餐')); // 70
  const o2 = service.placeOrder('E002', itemId('A餐')); // 70
  service.placeOrder('E003', itemId('A餐'));
  setClock(`${DAY}T12:00`);
  const t = service.pickupLookup(tokens.issue('E001').token, { kioskId: 'K' });
  service.pickupConfirm({ orderId: o1.id, ticket: t.ticket }, { kioskId: 'K' });
  service.pickupConfirm({ orderId: o2.id, employeeId: 'E002' }, { kioskId: 'K' });

  const report = service.dayReport(DAY);
  assert.equal(report.totalOrders, 3);
  assert.equal(report.totalSpend, 210);
  assert.equal(report.subsidyTotal, 99); // 33 × 3
  assert.equal(report.employeePayTotal, 111); // 37 × 3
  assert.deepEqual(report.byVia, { token: 1, manual: 1, delegate: 0 });

  const orders = service.dayOrders(DAY);
  assert.ok(orders.every((o) => typeof o.employeeDept === 'string'));
  assert.equal(orders.find((o) => o.id === o1.id).employeeDept, '行政');
});

// ---------- 取餐口裝置（HTTP） ----------

async function startApp() {
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
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  const admin = (await call('POST', '/api/auth/admin', { body: { password: 'pw' } })).json.token;
  return { server, call, admin };
}

test('取餐口裝置：未登入拒絕、金鑰錯誤拒絕、停用與重設金鑰立即生效', async () => {
  const { server, call, admin } = await startApp();
  try {
    for (const [method, url] of [['POST', '/api/pickup/lookup'], ['POST', '/api/pickup/confirm'], ['GET', '/api/pickup/status']]) {
      assert.equal((await call(method, url, { body: method === 'POST' ? {} : undefined })).status, 401, `${url} 應需登入`);
    }
    // 管理員與員工身分都不能代替取餐口
    assert.equal((await call('POST', '/api/pickup/lookup', { token: admin, body: { code: 'x' } })).status, 401);

    const created = await call('POST', '/api/admin/kiosks', { token: admin, body: { id: 'k-01', name: '一樓' } });
    assert.equal(created.status, 201);
    assert.equal(created.json.kiosk.id, 'K-01');
    assert.match(created.json.key, /^kiosk-/);
    assert.equal((await call('POST', '/api/admin/kiosks', { token: admin, body: { id: 'K-01' } })).status, 409);

    // 列表不洩漏金鑰或雜湊
    const list = await call('GET', '/api/admin/kiosks', { token: admin });
    assert.ok(!JSON.stringify(list.json).match(/hash|salt|kiosk-/i));

    assert.equal((await call('POST', '/api/kiosk/login', { body: { deviceId: 'K-01', key: 'wrong' } })).status, 401);
    const login = await call('POST', '/api/kiosk/login', { body: { deviceId: 'k-01', key: created.json.key } });
    assert.equal(login.status, 200);
    const token = login.json.token;
    assert.equal((await call('GET', '/api/pickup/status', { token })).json.kioskId, 'K-01');

    // 重設金鑰：舊登入作廢、舊金鑰失效
    const reset = await call('PUT', '/api/admin/kiosks/K-01', { token: admin, body: { resetKey: true } });
    assert.match(reset.json.key, /^kiosk-/);
    assert.notEqual(reset.json.key, created.json.key);
    assert.equal((await call('GET', '/api/pickup/status', { token })).status, 401);
    assert.equal((await call('POST', '/api/kiosk/login', { body: { deviceId: 'K-01', key: created.json.key } })).status, 401);

    const again = (await call('POST', '/api/kiosk/login', { body: { deviceId: 'K-01', key: reset.json.key } })).json.token;
    assert.equal((await call('GET', '/api/pickup/status', { token: again })).status, 200);

    // 停用：立即失效
    await call('PUT', '/api/admin/kiosks/K-01', { token: admin, body: { active: false } });
    assert.equal((await call('GET', '/api/pickup/status', { token: again })).status, 401);
    assert.equal((await call('POST', '/api/kiosk/login', { body: { deviceId: 'K-01', key: reset.json.key } })).status, 401);
  } finally {
    server.close();
  }
});

test('取餐口裝置：連續金鑰錯誤 5 次鎖定', async () => {
  const { server, call, admin } = await startApp();
  try {
    const created = await call('POST', '/api/admin/kiosks', { token: admin, body: { id: 'K-02' } });
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await call('POST', '/api/kiosk/login', { body: { deviceId: 'K-02', key: 'bad' } })).status, 401);
    }
    assert.equal((await call('POST', '/api/kiosk/login', { body: { deviceId: 'K-02', key: created.json.key } })).status, 429);
  } finally {
    server.close();
  }
});

test('員工可取得動態碼；沒登入不行；取餐口無法用員工身分', async () => {
  const { server, call, admin } = await startApp();
  try {
    await call('POST', '/api/admin/employees/import', { token: admin, body: { csv: '員工編號,姓名\n012003,吳宗文' } });
    assert.equal((await call('GET', '/api/me/pickup-token')).status, 401);
    const emp = (await call('POST', '/api/auth/employee', { body: { employeeId: '12003' } })).json; // 沒補零也能登入
    assert.equal(emp.employee.id, '012003');
    const t = await call('GET', '/api/me/pickup-token', { token: emp.token });
    assert.match(t.json.token, /^P\.012003\.\d+\.[0-9a-f]{16}$/);
    assert.ok(t.json.refreshInSeconds >= 1 && t.json.refreshInSeconds <= 30);
    assert.equal((await call('POST', '/api/pickup/lookup', { token: emp.token, body: { code: t.json.token } })).status, 401);

    // 管理員可用的設定：沒有權限的角色不能管裝置
    await call('POST', '/api/admin/admins', { token: admin, body: { username: 'helper', role: 'operator', password: 'password123' } });
    const helper = (await call('POST', '/api/auth/admin', { body: { username: 'helper', password: 'password123' } })).json.token;
    assert.equal((await call('GET', '/api/admin/kiosks', { token: helper })).status, 403);
    assert.equal((await call('POST', '/api/admin/kiosks', { token: helper, body: { id: 'X-1' } })).status, 403);
  } finally {
    server.close();
  }
});
