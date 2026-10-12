const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/store');
const { createService } = require('../src/service');
const { createAdminService, hashPassword } = require('../src/admins');
const { createKioskService } = require('../src/kiosks');
const { importLegacyJson } = require('../src/migrate');
const { setClock } = require('../src/time');

const DAY = '2026-10-12';

function tmpFile(name = 'test.db') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-test-'));
  return { dir, file: path.join(dir, name) };
}

test.afterEach(() => setClock(null));

test('檔案資料庫：關閉後重新開啟，所有資料都還在', () => {
  const { dir, file } = tmpFile();
  try {
    let store = createStore(file);
    let service = createService(store);
    const admins = createAdminService(store);
    admins.ensureBootstrap('Start-Pass-1');
    admins.create({ username: 'helper', role: 'operator', password: 'password123' });
    createKioskService(store).create({ id: 'k-1', name: '一樓', key: 'kiosk-key-xyz' });
    service.importEmployees('員工編號,姓名,部門\n12003,吳宗文,2000 總經理室\nE002,乙,研發');
    service.updateConfig({ orderCutoff: '10:30', subsidy: 40 });
    setClock(`${DAY}T08:00`);
    service.setMenu(DAY, [{ meal: 'lunch', name: 'A餐', price: 70, main: '雞排', sides: '香腸、黑輪', special: false }]);
    const itemId = service.getMenu(DAY)[0].id;
    const order = service.placeOrder('012003', itemId);
    service.delegateOrder('012003', order.id, 'E002');
    service.bindEmployee({ lineUserId: 'U1', displayName: '小吳', employeeId: '12003', name: '吳宗文' });
    service.setExemption(DAY, 'E002', '出差');
    store.close();

    store = createStore(file);
    service = createService(store);
    assert.equal(store.config.orderCutoff, '10:30');
    assert.equal(store.config.subsidy, 40);
    assert.equal(service.getEmployee('12003').dept, '2000 總經理室');
    assert.deepEqual(service.getMenu(DAY)[0].sides, ['香腸', '黑輪']);
    const reloaded = service.dayOrders(DAY)[0];
    assert.equal(reloaded.employeeId, '012003');
    assert.equal(reloaded.delegateId, 'E002');
    assert.equal(reloaded.amount, 30); // 70 − 補貼 40
    assert.equal(service.findBinding('U1').id, '012003');
    assert.deepEqual(store.exemptions.forDate(DAY), { E002: '出差' });
    assert.ok(createAdminService(store).authenticate('admin', 'Start-Pass-1'));
    assert.ok(createAdminService(store).authenticate('helper', 'password123'));
    assert.equal(createKioskService(store).authenticate('K-1', 'kiosk-key-xyz').id, 'K-1');
    // 序號延續，不會與既有訂單 id 重複
    const next = store.nextId('O');
    assert.notEqual(next, order.id);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('交易：丟出例外會整筆回復；巢狀交易併入外層', () => {
  const store = createStore(null);
  assert.throws(() => store.tx(() => {
    store.employees.upsert({ id: 'E001', name: '甲' });
    store.tx(() => store.employees.upsert({ id: 'E002', name: '乙' }));
    throw new Error('boom');
  }), /boom/);
  assert.equal(store.employees.count(), 0, '兩筆都回復');

  store.tx(() => {
    store.employees.upsert({ id: 'E001', name: '甲' });
    store.tx(() => store.employees.upsert({ id: 'E002', name: '乙' }));
  });
  assert.equal(store.employees.count(), 2);
  // 例外之後仍可正常開新交易
  store.tx(() => store.employees.upsert({ id: 'E003', name: '丙' }));
  assert.equal(store.employees.count(), 3);
});

test('資料庫層防線：重複的有效訂單、同員編綁兩個 LINE 帳號都會被拒絕', () => {
  const store = createStore(null);
  store.employees.upsert({ id: 'E001', name: '甲' });
  const base = {
    date: DAY, employeeId: 'E001', meal: 'lunch', itemId: 'M1', itemName: 'A', price: 70, special: false,
    status: 'booked', createdAt: new Date().toISOString(),
  };
  store.orders.insert({ ...base, id: 'O1' });
  assert.throws(() => store.orders.insert({ ...base, id: 'O2' }), /UNIQUE/);
  store.orders.insert({ ...base, id: 'O3', status: 'cancelled' }); // 已取消的不算
  store.orders.insert({ ...base, id: 'O4', meal: 'dinner' });

  store.bindings.upsert({ lineUserId: 'U1', employeeId: 'E001', boundAt: 'x' });
  assert.throws(() => store.bindings.upsert({ lineUserId: 'U2', employeeId: 'E001', boundAt: 'x' }), /UNIQUE/);
  // 訂單不能指向不存在的員工
  assert.throws(() => store.orders.insert({ ...base, id: 'O5', employeeId: 'NOPE', meal: 'dinner', date: '2026-10-13' }), /FOREIGN KEY/);
});

test('服務層失敗不留下半套資料：訂購不存在的品項不會新增訂單', () => {
  const store = createStore(null);
  const service = createService(store);
  service.importEmployees('員工編號,姓名\nE001,甲');
  setClock(`${DAY}T08:00`);
  service.setMenu(DAY, [{ meal: 'lunch', name: 'A', price: 70 }]);
  assert.throws(() => service.placeOrder('E001', 'M-nope'), /沒有此品項/);
  assert.equal(store.orders.count(), 0);
});

test('備份：取得完整快照，可獨立開啟；目的檔已存在會拒絕', () => {
  const { dir, file } = tmpFile();
  try {
    const store = createStore(file);
    const service = createService(store);
    service.importEmployees('員工編號,姓名\nE001,甲\nE002,乙');
    const dest = path.join(dir, 'backups', 'snap.db');
    store.backup(dest);
    assert.ok(fs.existsSync(dest));
    assert.throws(() => store.backup(dest), /已存在/);

    // 備份後主庫繼續寫入，不影響快照
    service.importEmployees('員工編號,姓名\nE003,丙');
    const snap = createStore(dest);
    assert.equal(snap.employees.count(), 2);
    assert.equal(store.employees.count(), 3);
    snap.close();
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reset 會清空資料並恢復預設設定', () => {
  const store = createStore(null);
  const service = createService(store);
  service.importEmployees('員工編號,姓名\nE001,甲');
  service.updateConfig({ subsidy: 99 });
  store.reset();
  assert.equal(store.employees.count(), 0);
  assert.equal(store.config.subsidy, 33);
  assert.ok(store.isEmpty());
});

// ---------- 舊版 JSON 搬遷 ----------

function legacyFixture() {
  const admin = hashPassword('Legacy-Pass-1');
  return {
    config: { orderCutoff: '09:45', subsidy: 33, employeeIdLength: 6, allowManualPickup: false, specialLeadDays: 3, unknownKey: 1 },
    employees: {
      '012003': { id: '012003', name: '吳宗文', dept: '2000 總經理室' },
      E002: { id: 'E002', name: '乙', dept: '研發', verify: '0615' },
    },
    bindings: { U9: { employeeId: '012003', displayName: '小吳', boundAt: '2026-10-01T00:00:00.000Z' } },
    admins: { admin: { username: 'admin', displayName: '初始管理員', role: 'owner', active: true, ...admin, createdAt: '2026-10-01T00:00:00.000Z' } },
    kiosks: { 'KIOSK-01': { id: 'KIOSK-01', name: '一樓', active: true, ...hashPassword('k-key'), createdAt: '2026-10-01T00:00:00.000Z', lastSeen: null } },
    menus: { [DAY]: [{ id: 'M5', meal: 'lunch', name: 'A餐', price: 70 }, { id: 'M6', meal: 'lunch', name: 'B餐', price: 80, special: true, main: '炒泡麵', sides: [], veg: '' }] },
    orders: [
      { id: 'O7', date: DAY, employeeId: '012003', meal: 'lunch', itemId: 'M5', itemName: 'A餐', price: 70, status: 'picked', delegateId: null, delegateCode: null, pickedBy: '012003', pickedAt: '2026-10-12T04:00:00.000Z', pickedVia: 'token', pickedKiosk: 'KIOSK-01', deductionStatus: null, createdAt: '2026-10-11T00:00:00.000Z' },
      { id: 'O8', date: DAY, employeeId: 'E002', meal: 'lunch', itemId: 'M5', itemName: 'A餐', price: 70, special: false, status: 'booked', delegateId: null, delegateCode: null, pickedBy: null, pickedAt: null, deductionStatus: null, createdAt: '2026-10-11T00:00:00.000Z' },
    ],
    exemptions: { [DAY]: { E002: '出差' } },
    history: [{ at: '2026-10-11T00:00:00.000Z', action: 'admin.request', detail: { actor: 'admin', method: 'PUT', path: '/api/admin/menu' } }],
    seq: 8,
  };
}

test('舊 JSON 搬遷：各類資料完整進入 SQLite，舊帳號與裝置金鑰仍可使用，序號延續', () => {
  const store = createStore(null);
  const counts = importLegacyJson(store, legacyFixture());
  assert.deepEqual(counts, { employees: 2, bindings: 1, admins: 1, kiosks: 1, menuDays: 1, orders: 2, exemptions: 1, history: 1 });

  const service = createService(store);
  assert.equal(store.config.orderCutoff, '09:45');
  assert.equal(store.config.allowManualPickup, false);
  assert.equal(service.findBinding('U9').id, '012003');
  assert.equal(service.getMenu(DAY).find((i) => i.name === 'B餐').special, true);
  assert.equal(service.getMenu(DAY).find((i) => i.name === 'A餐').special, false, '舊資料缺欄位時補預設值');
  assert.ok(createAdminService(store).authenticate('admin', 'Legacy-Pass-1'));
  assert.equal(createKioskService(store).authenticate('KIOSK-01', 'k-key').id, 'KIOSK-01');
  assert.equal(store.history.audit(5)[0].actor, 'admin');

  setClock(`${DAY}T14:00`);
  const report = service.dayReport(DAY);
  assert.equal(report.totalOrders, 2);
  assert.equal(report.picked, 1);
  assert.equal(report.unclaimedCount, 0, 'E002 在例外名單，不算未取餐');
  assert.equal(report.byVia.token, 1);
  assert.equal(store.nextId('O'), 'O9', '序號從舊資料的 seq 繼續');
});

test('舊 JSON 搬遷失敗會整筆回復，資料庫維持空的', () => {
  const store = createStore(null);
  const broken = legacyFixture();
  broken.orders.push({ ...broken.orders[1], id: 'O9', employeeId: 'GHOST', meal: 'dinner' }); // 指向不存在的員工
  assert.throws(() => importLegacyJson(store, broken), /FOREIGN KEY/);
  assert.ok(store.isEmpty(), '員工、管理員等都沒有留下');
  assert.equal(store.config.orderCutoff, '10:00', '設定也回復成預設');
});
