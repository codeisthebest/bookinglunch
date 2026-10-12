const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/store');
const { createService, AppError, MSG } = require('../src/service');
const { setClock } = require('../src/time');

const DAY = '2026-10-12';

function setup() {
  const store = createStore(null); // 不落地，純記憶體
  const service = createService(store);
  service.importEmployees('員工編號,姓名,部門\nE001,甲,行政\nE002,乙,研發\nE003,丙,業務\nE004,丁,財務');
  service.setMenu(DAY, [
    { meal: 'lunch', name: '雞腿飯', price: 60 },
    { meal: 'lunch', name: '排骨飯', price: 70 },
    { meal: 'dinner', name: '滷肉飯', price: 60 },
  ]);
  return { store, service };
}

function at(time) {
  setClock(`${DAY}T${time}`);
}

function itemId(service, meal, name) {
  return service.getMenu(DAY).find((i) => i.meal === meal && i.name === name).id;
}

function expectError(fn, status, message) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof AppError, `應為 AppError，實際：${err}`);
    assert.equal(err.status, status);
    if (message) assert.equal(err.message, message);
    return true;
  });
}

test.afterEach(() => setClock(null));

test('CSV 匯入：缺少必要欄位會拒絕', () => {
  const { service } = setup();
  expectError(() => service.importEmployees('name,dept\nA,B'), 400);
});

test('CSV 匯入：空白列會回報錯誤並略過', () => {
  const { service } = setup();
  const result = service.importEmployees('員工編號,姓名\nE010,新人\n,無編號');
  assert.equal(result.created, 1);
  assert.equal(result.errors.length, 1);
});

test('截止時間前可訂餐，截止後不可', () => {
  const { service } = setup();
  at('08:00');
  const order = service.placeOrder('E001', itemId(service, 'lunch', '雞腿飯'));
  assert.equal(order.status, 'booked');
  assert.equal(order.amount, 27); // 60 - 33 補貼

  at('10:00');
  service.placeOrder('E002', itemId(service, 'lunch', '雞腿飯')); // 截止時間整點仍可訂

  at('10:30');
  expectError(() => service.placeOrder('E003', itemId(service, 'lunch', '雞腿飯')), 409);
});

test('開放當月訂餐：當月未來日期可訂，過去與下個月不可', () => {
  const { service } = setup();
  at('08:00');
  const later = '2026-10-20';
  const nextMonth = '2026-11-02';
  service.setMenu(later, [{ meal: 'lunch', name: '未來便當', price: 80 }]);
  service.setMenu(nextMonth, [{ meal: 'lunch', name: '下月便當', price: 80 }]);
  service.setMenu('2026-10-05', [{ meal: 'lunch', name: '過去便當', price: 80 }]);
  const pick = (d) => service.getMenu(d)[0].id;

  const order = service.placeOrder('E001', pick(later), later);
  assert.equal(order.date, later);
  assert.equal(order.changeable, true);
  expectError(() => service.placeOrder('E001', pick(nextMonth), nextMonth), 409);
  expectError(() => service.placeOrder('E001', pick('2026-10-05'), '2026-10-05'), 409);

  // 未來日期當天的截止時間才生效：今天過了 10:00，未來的單仍可取消
  at('15:00');
  assert.equal(service.cancelOrder('E001', order.id).status, 'cancelled');

  const view = service.menuForDate('E001', later);
  assert.ok(view.availableDates.includes(later));
  assert.ok(!view.availableDates.includes(nextMonth));
  assert.ok(!view.availableDates.includes('2026-10-05'));
});

test('委託代領不受訂餐截止時間限制，但取餐期限過後不可再設', () => {
  const { service } = setup();
  at('08:00');
  const order = service.placeOrder('E001', itemId(service, 'lunch', '雞腿飯'));

  at('12:00'); // 已過 10:00 截止，仍可委託
  const delegated = service.delegateOrder('E001', order.id, 'E002');
  assert.ok(delegated.delegateCode);
  expectError(() => service.cancelOrder('E001', order.id), 409); // 取消仍受截止限制

  at('13:30');
  expectError(() => service.undelegateOrder('E001', order.id), 409);
});

test('同一餐別不可重複訂購', () => {
  const { service } = setup();
  at('08:00');
  service.placeOrder('E001', itemId(service, 'lunch', '雞腿飯'));
  expectError(() => service.placeOrder('E001', itemId(service, 'lunch', '排骨飯')), 409);
  // 晚餐是另一餐，可以訂
  service.placeOrder('E001', itemId(service, 'dinner', '滷肉飯'));
});

test('非內部員工無法訂餐', () => {
  const { service } = setup();
  at('08:00');
  expectError(() => service.placeOrder('X999', itemId(service, 'lunch', '雞腿飯')), 404);
});

test('未取餐判定：午餐 13:00 之後、晚餐 18:20 之後才算未取', () => {
  const { service } = setup();
  at('08:00');
  service.placeOrder('E001', itemId(service, 'lunch', '雞腿飯'));
  service.placeOrder('E002', itemId(service, 'dinner', '滷肉飯'));

  at('13:00');
  assert.equal(service.dayReport(DAY).unclaimedCount, 0, '13:00 整仍在期限內');

  at('13:01');
  const report = service.dayReport(DAY);
  assert.equal(report.unclaimedCount, 1);
  assert.equal(report.deductionList[0].employeeId, 'E001');
  assert.equal(report.deductionList[0].deductionStatus, 'pending');

  at('18:21');
  assert.equal(service.dayReport(DAY).unclaimedCount, 2);
});

test('例外名單的未取餐不列入扣款', () => {
  const { service } = setup();
  at('08:00');
  service.placeOrder('E001', itemId(service, 'lunch', '雞腿飯'));
  service.setExemption(DAY, 'E001', '出差');
  at('14:00');
  assert.equal(service.dayReport(DAY).unclaimedCount, 0);
});

test('委託取餐：只有指定代領人可以領，訂餐人本人不放行', () => {
  const { service } = setup();
  at('08:00');
  const order = service.placeOrder('E001', itemId(service, 'lunch', '雞腿飯'));
  const delegated = service.delegateOrder('E001', order.id, 'E002');
  assert.ok(delegated.delegateCode);

  at('12:00');
  const lookup = service.pickupLookup(delegated.delegateCode);
  assert.equal(lookup.mode, 'delegate');
  assert.equal(lookup.status, 'need_employee_id');

  expectError(
    () => service.pickupConfirm({ code: delegated.delegateCode, employeeId: 'E001' }),
    403,
    MSG.DELEGATE_MISMATCH,
  );
  expectError(
    () => service.pickupConfirm({ code: delegated.delegateCode, employeeId: 'E003' }),
    403,
    MSG.DELEGATE_MISMATCH,
  );

  const picked = service.pickupConfirm({ code: delegated.delegateCode, employeeId: 'E002' });
  assert.equal(picked.status, 'picked');
  assert.equal(picked.pickedBy, 'E002');
});

test('轉讓或取消訂單會清除委託授權', () => {
  const { service } = setup();
  at('08:00');
  const a = service.placeOrder('E001', itemId(service, 'lunch', '雞腿飯'));
  service.delegateOrder('E001', a.id, 'E002');
  const transferred = service.transferOrder('E001', a.id, 'E003');
  assert.equal(transferred.employeeId, 'E003');
  assert.equal(transferred.delegateId, null);
  assert.equal(transferred.delegateCode, null);

  const b = service.placeOrder('E004', itemId(service, 'dinner', '滷肉飯'));
  const delegated = service.delegateOrder('E004', b.id, 'E002');
  const cancelled = service.cancelOrder('E004', b.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.delegateCode, null);
  assert.equal(service.pickupLookup(delegated.delegateCode).status, 'not_found');
});

test('一般取餐：員工編號比對本人訂單，取餐後不可重複領', () => {
  const { service } = setup();
  at('08:00');
  const order = service.placeOrder('E003', itemId(service, 'lunch', '排骨飯'));

  at('12:00');
  const lookup = service.pickupLookup('EMP:E003');
  assert.equal(lookup.status, 'ok');
  assert.equal(lookup.orders[0].amount, 37); // 70 - 33

  expectError(() => service.pickupConfirm({ orderId: order.id, employeeId: 'E001' }), 403, MSG.NOT_OWNER);

  service.pickupConfirm({ orderId: order.id, employeeId: 'E003' });
  expectError(() => service.pickupConfirm({ orderId: order.id, employeeId: 'E003' }), 409);
});

test('今日未訂餐的員工掃碼會顯示 no_order', () => {
  const { service } = setup();
  at('12:00');
  const lookup = service.pickupLookup('E004');
  assert.equal(lookup.status, 'no_order');
  assert.equal(lookup.message, '今日未訂餐');
});

test('逾期未取的訂單無法再取餐', () => {
  const { service } = setup();
  at('08:00');
  const order = service.placeOrder('E001', itemId(service, 'lunch', '雞腿飯'));
  at('13:30');
  expectError(() => service.pickupConfirm({ orderId: order.id, employeeId: 'E001' }), 409);
});

test('菜單格式驗證', () => {
  const { service } = setup();
  expectError(() => service.setMenu(DAY, [{ meal: 'breakfast', name: 'x', price: 60 }]), 400);
  expectError(() => service.setMenu(DAY, [{ meal: 'lunch', name: '', price: 60 }]), 400);
  expectError(() => service.setMenu(DAY, [{ meal: 'lunch', name: 'x', price: -1 }]), 400);
});
