// 業務邏輯層：訂餐、委託、轉讓、取餐驗證、未取餐與報表。
// 路由層（app.js）只負責 HTTP 參數與權限，規則都在這裡。

const crypto = require('node:crypto');
const { MEAL_DEADLINES, taipeiNow, isValidDate, isValidTime } = require('./time');
const { parseCsv } = require('./csv');

const MEAL_LABEL = { lunch: '午餐', dinner: '晚餐' };
const DELEGATE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的 0/O/1/I/L

const MSG = {
  DELEGATE_MISMATCH: '此委託取餐僅開放給指定同事，員工編號不符，拒絕放行',
  NOT_OWNER: '此訂單不屬於該員工編號，拒絕放行',
};

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createService(store) {
  function log(action, detail) {
    store.db.history.push({ at: new Date().toISOString(), action, detail });
    if (store.db.history.length > 2000) store.db.history.splice(0, 500);
  }

  // 後台操作紀錄：只記誰、對哪個路徑做了什麼方法，不記請求內容（避免寫入密碼）
  function audit(actor, method, requestPath) {
    log('admin.request', { actor, method, path: requestPath });
    store.save();
  }

  function listAudit(limit = 200) {
    return store.db.history
      .filter((h) => h.action === 'admin.request')
      .slice(-limit)
      .reverse()
      .map((h) => ({ at: h.at, ...h.detail }));
  }

  // ---------- 時間與截止判斷 ----------

  function orderingStatus(date) {
    const today = taipeiNow();
    const cutoff = store.db.config.orderCutoff;
    if (date < today.date) return { open: false, reason: '已過日期' };
    // 開放當月訂餐：只接受與今天同月份的日期；每天的截止時間在當天 cutoff
    if (date.slice(0, 7) !== today.date.slice(0, 7)) return { open: false, reason: '僅開放當月訂餐' };
    if (date === today.date && today.time > cutoff) return { open: false, reason: `已過截止時間 ${cutoff}` };
    return { open: true, reason: null };
  }

  function isPastMealDeadline(order) {
    const today = taipeiNow();
    if (order.date < today.date) return true;
    if (order.date > today.date) return false;
    return today.time > MEAL_DEADLINES[order.meal];
  }

  function isExempt(date, employeeId) {
    return Boolean(store.db.exemptions[date] && store.db.exemptions[date][employeeId]);
  }

  // ---------- 設定 ----------

  function getConfig() {
    return { ...store.db.config };
  }

  function updateConfig(patch) {
    if (patch.orderCutoff !== undefined) {
      if (!isValidTime(patch.orderCutoff)) throw new AppError(400, '截止時間格式需為 HH:mm');
      store.db.config.orderCutoff = patch.orderCutoff;
    }
    if (patch.subsidy !== undefined) {
      const n = Number(patch.subsidy);
      if (!Number.isInteger(n) || n < 0) throw new AppError(400, '補貼金額需為非負整數');
      store.db.config.subsidy = n;
    }
    store.save();
    log('config.update', patch);
    return getConfig();
  }

  // ---------- 員工名單 ----------

  const HEADER_MAP = {
    id: ['員工編號', '員編', 'employee_id', 'employeeid', 'id'],
    name: ['姓名', 'name'],
    dept: ['部門', 'dept', 'department'],
    verify: ['驗證碼', 'verify', 'verification', 'verify_code'],
  };

  function findColumn(headers, key) {
    const lower = headers.map((h) => h.toLowerCase());
    return HEADER_MAP[key].map((alias) => lower.indexOf(alias.toLowerCase())).find((i) => i >= 0);
  }

  function importEmployees(csvText) {
    const rows = parseCsv(String(csvText || ''));
    if (rows.length < 2) throw new AppError(400, 'CSV 至少需要標題列與一筆資料');

    const headers = rows[0];
    const cols = {
      id: findColumn(headers, 'id'),
      name: findColumn(headers, 'name'),
      dept: findColumn(headers, 'dept'),
      verify: findColumn(headers, 'verify'),
    };
    if (cols.id === undefined || cols.name === undefined) {
      throw new AppError(400, '標題列需包含「員工編號」與「姓名」欄位');
    }

    let created = 0;
    let updated = 0;
    const errors = [];
    rows.slice(1).forEach((row, index) => {
      const line = index + 2;
      const id = (row[cols.id] || '').trim();
      const name = (row[cols.name] || '').trim();
      const dept = cols.dept === undefined ? '' : (row[cols.dept] || '').trim();
      const verify = cols.verify === undefined ? '' : (row[cols.verify] || '').trim();
      if (!id || !name) {
        errors.push({ line, message: '員工編號或姓名為空' });
        return;
      }
      if (store.db.employees[id]) {
        updated += 1;
      } else {
        created += 1;
      }
      const record = { id, name, dept };
      if (verify) record.verify = verify;
      store.db.employees[id] = record;
    });

    store.save();
    log('employees.import', { created, updated, errors: errors.length });
    return { created, updated, errors, total: Object.keys(store.db.employees).length };
  }

  function boundEmployeeIds() {
    return new Set(Object.values(store.db.bindings).map((b) => b.employeeId));
  }

  // 管理端列表不回傳驗證碼本身，只標示有無，以及是否已綁定 LINE
  function listEmployees() {
    const bound = boundEmployeeIds();
    return Object.values(store.db.employees)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ verify, ...rest }) => ({ ...rest, hasVerify: Boolean(verify), bound: bound.has(rest.id) }));
  }

  // 對外（員工頁、取餐口）只提供安全欄位，避免驗證碼外流
  function publicEmployee(employee) {
    if (!employee) return null;
    return { id: employee.id, name: employee.name, dept: employee.dept };
  }

  function getEmployee(id) {
    return publicEmployee(store.db.employees[id]);
  }

  // ---------- LINE 帳號綁定 ----------

  const MAX_BIND_FAILURES = 5;
  const BIND_LOCK_MS = 15 * 60 * 1000;
  const bindFailures = new Map(); // lineUserId -> { count, until }

  function findBinding(lineUserId) {
    const binding = store.db.bindings[lineUserId];
    return binding ? getEmployee(binding.employeeId) : null;
  }

  function bindEmployee({ lineUserId, displayName, employeeId, name, verification }) {
    if (!lineUserId) throw new AppError(400, '缺少 LINE 身分');
    const failure = bindFailures.get(lineUserId);
    if (failure && failure.until > Date.now()) {
      throw new AppError(429, '嘗試次數過多，請 15 分鐘後再試，或洽行政人員協助');
    }

    const id = String(employeeId || '').trim();
    const record = store.db.employees[id];
    const nameOk = record && String(name || '').trim() === record.name;
    const verifyOk = record && (!record.verify || String(verification || '').trim() === record.verify);
    if (!record || !nameOk || !verifyOk) {
      // 上一輪鎖定已過期就重新計數；尚未鎖定（until 為 0）則累計
      const lockExpired = failure && failure.until > 0 && failure.until <= Date.now();
      const count = (failure && !lockExpired ? failure.count : 0) + 1;
      bindFailures.set(lineUserId, { count, until: count >= MAX_BIND_FAILURES ? Date.now() + BIND_LOCK_MS : 0 });
      // 不透露是哪個欄位不符，避免被用來猜測員編
      throw new AppError(403, record && record.verify
        ? '員工編號、姓名或驗證碼不符，請再確認'
        : '員工編號或姓名不符，請再確認');
    }

    const existing = Object.entries(store.db.bindings).find(([, b]) => b.employeeId === id);
    if (existing && existing[0] !== lineUserId) {
      throw new AppError(409, '此員工編號已綁定其他 LINE 帳號，如需更換請洽行政人員解除綁定');
    }
    // 同一個 LINE 帳號換綁別的員編也不允許，避免一個帳號冒用多人
    const current = store.db.bindings[lineUserId];
    if (current && current.employeeId !== id) {
      throw new AppError(409, '此 LINE 帳號已綁定其他員工，如需更換請洽行政人員解除綁定');
    }

    store.db.bindings[lineUserId] = {
      employeeId: id,
      displayName: displayName || '',
      boundAt: new Date().toISOString(),
    };
    bindFailures.delete(lineUserId);
    store.save();
    log('binding.create', { employeeId: id, lineUserId });
    return getEmployee(id);
  }

  function listBindings() {
    return Object.entries(store.db.bindings).map(([lineUserId, b]) => {
      const employee = getEmployee(b.employeeId);
      return {
        lineUserId,
        displayName: b.displayName,
        employeeId: b.employeeId,
        employeeName: employee ? employee.name : '',
        boundAt: b.boundAt,
      };
    });
  }

  function unbind(lineUserId) {
    const binding = store.db.bindings[lineUserId];
    if (!binding) throw new AppError(404, '找不到此綁定');
    delete store.db.bindings[lineUserId];
    bindFailures.delete(lineUserId);
    store.save();
    log('binding.remove', { employeeId: binding.employeeId, lineUserId });
    return { removed: true };
  }

  function requireEmployee(id) {
    const employee = getEmployee(id);
    if (!employee) throw new AppError(404, '查無此員工編號，僅限內部員工使用');
    return employee;
  }

  // ---------- 菜單 ----------

  function getMenu(date) {
    return (store.db.menus[date] || []).map((item) => ({ ...item }));
  }

  function setMenu(date, items) {
    if (!isValidDate(date)) throw new AppError(400, '日期格式需為 YYYY-MM-DD');
    if (!Array.isArray(items)) throw new AppError(400, 'items 需為陣列');

    const normalized = items.map((raw, index) => {
      const meal = raw.meal;
      const name = String(raw.name || '').trim();
      const price = Number(raw.price);
      if (!MEAL_LABEL[meal]) throw new AppError(400, `第 ${index + 1} 項：餐別需為 lunch 或 dinner`);
      if (!name) throw new AppError(400, `第 ${index + 1} 項：品名不可為空`);
      if (!Number.isInteger(price) || price <= 0) throw new AppError(400, `第 ${index + 1} 項：價格需為正整數`);
      return { id: raw.id || store.nextId('M'), meal, name, price };
    });

    store.db.menus[date] = normalized;
    store.save();
    log('menu.set', { date, count: normalized.length });
    return getMenu(date);
  }

  // ---------- 訂單視圖 ----------

  function amountFor(order) {
    return Math.max(0, order.price - store.db.config.subsidy);
  }

  function statusOf(order) {
    if (order.status === 'cancelled') return 'cancelled';
    if (order.status === 'picked') return 'picked';
    if (isExempt(order.date, order.employeeId)) return 'exempt';
    return isPastMealDeadline(order) ? 'unclaimed' : 'booked';
  }

  function orderView(order) {
    const owner = getEmployee(order.employeeId);
    const delegate = order.delegateId ? getEmployee(order.delegateId) : null;
    return {
      id: order.id,
      date: order.date,
      meal: order.meal,
      mealLabel: MEAL_LABEL[order.meal],
      itemName: order.itemName,
      price: order.price,
      amount: amountFor(order),
      employeeId: order.employeeId,
      employeeName: owner ? owner.name : '',
      status: statusOf(order),
      changeable: order.status === 'booked' && orderingStatus(order.date).open,
      delegateId: order.delegateId,
      delegateName: delegate ? delegate.name : null,
      delegateCode: order.delegateId ? order.delegateCode : null,
      pickedBy: order.pickedBy,
      pickedAt: order.pickedAt,
      deductionStatus: order.deductionStatus,
      createdAt: order.createdAt,
    };
  }

  function activeOrders(filter) {
    return store.db.orders.filter((o) => o.status !== 'cancelled' && filter(o));
  }

  function findOrder(orderId) {
    const order = store.db.orders.find((o) => o.id === orderId);
    if (!order) throw new AppError(404, '找不到訂單');
    return order;
  }

  function generateDelegateCode() {
    const used = new Set(store.db.orders.filter((o) => o.delegateCode).map((o) => o.delegateCode));
    for (;;) {
      const bytes = crypto.randomBytes(6);
      let code = '';
      for (let i = 0; i < 6; i += 1) code += DELEGATE_ALPHABET[bytes[i] % DELEGATE_ALPHABET.length];
      if (!used.has(code)) return code;
    }
  }

  function clearDelegation(order) {
    order.delegateId = null;
    order.delegateCode = null;
  }

  // ---------- 員工端 ----------

  // 指定日期的菜單與我的訂單；date 省略時為今天。availableDates 為當月今天起有菜單的日期。
  function menuForDate(employeeId, date) {
    const today = taipeiNow();
    const day = date || today.date;
    if (!isValidDate(day)) throw new AppError(400, '日期格式需為 YYYY-MM-DD');

    const month = today.date.slice(0, 7);
    const availableDates = Object.keys(store.db.menus)
      .filter((d) => d >= today.date && d.slice(0, 7) === month && store.db.menus[d].length > 0)
      .sort();
    const myOrders = activeOrders((o) => o.date === day && o.employeeId === employeeId).map(orderView);
    const delegatedToMe = activeOrders(
      (o) => o.date === day && o.delegateId === employeeId && o.status === 'booked',
    ).map(orderView);
    const upcoming = activeOrders(
      (o) => o.employeeId === employeeId && o.date >= today.date && o.date.slice(0, 7) === month,
    )
      .sort((a, b) => a.date.localeCompare(b.date) || a.meal.localeCompare(b.meal))
      .map(orderView);

    return {
      today: today.date,
      date: day,
      time: today.time,
      cutoff: store.db.config.orderCutoff,
      subsidy: store.db.config.subsidy,
      ordering: orderingStatus(day),
      items: getMenu(day),
      availableDates,
      myOrders,
      delegatedToMe,
      upcoming,
    };
  }

  function placeOrder(employeeId, itemId, date) {
    requireEmployee(employeeId);
    const day = date || taipeiNow().date;
    if (!isValidDate(day)) throw new AppError(400, '日期格式需為 YYYY-MM-DD');
    const ordering = orderingStatus(day);
    if (!ordering.open) throw new AppError(409, `目前無法訂餐：${ordering.reason}`);

    const item = getMenu(day).find((i) => i.id === itemId);
    if (!item) throw new AppError(404, '該日菜單沒有此品項');

    const duplicate = activeOrders(
      (o) => o.date === day && o.employeeId === employeeId && o.meal === item.meal,
    );
    if (duplicate.length > 0) throw new AppError(409, `${day} 的${MEAL_LABEL[item.meal]}已訂購，請先取消再重新訂購`);

    const order = {
      id: store.nextId('O'),
      date: day,
      employeeId,
      meal: item.meal,
      itemId: item.id,
      itemName: item.name,
      price: item.price,
      status: 'booked',
      delegateId: null,
      delegateCode: null,
      pickedBy: null,
      pickedAt: null,
      deductionStatus: null,
      createdAt: new Date().toISOString(),
    };
    store.db.orders.push(order);
    store.save();
    log('order.create', { id: order.id, employeeId, item: item.name });
    return orderView(order);
  }

  function assertOwnedOpenOrder(employeeId, orderId) {
    const order = findOrder(orderId);
    if (order.employeeId !== employeeId) throw new AppError(403, MSG.NOT_OWNER);
    if (order.status !== 'booked') throw new AppError(409, '此訂單已取消或已取餐');
    const ordering = orderingStatus(order.date);
    if (!ordering.open) throw new AppError(409, `此訂單無法變更：${ordering.reason}`);
    return order;
  }

  // 委託代領不受訂餐截止時間限制（中午才指定同事去領也合理），只要該餐尚未過取餐期限即可。
  function assertOwnedPendingOrder(employeeId, orderId) {
    const order = findOrder(orderId);
    if (order.employeeId !== employeeId) throw new AppError(403, MSG.NOT_OWNER);
    if (order.status !== 'booked') throw new AppError(409, '此訂單已取消或已取餐');
    if (isPastMealDeadline(order)) throw new AppError(409, '此餐已超過取餐時間，無法變更委託');
    return order;
  }

  function cancelOrder(employeeId, orderId) {
    const order = assertOwnedOpenOrder(employeeId, orderId);
    order.status = 'cancelled';
    clearDelegation(order);
    store.save();
    log('order.cancel', { id: order.id, employeeId });
    return orderView(order);
  }

  function transferOrder(employeeId, orderId, toEmployeeId) {
    const order = assertOwnedOpenOrder(employeeId, orderId);
    if (!toEmployeeId) throw new AppError(400, '請輸入受讓人員編');
    if (toEmployeeId === employeeId) throw new AppError(400, '不可轉讓給自己');
    requireEmployee(toEmployeeId);

    const conflict = activeOrders(
      (o) => o.date === order.date && o.meal === order.meal && o.employeeId === toEmployeeId,
    );
    if (conflict.length > 0) throw new AppError(409, '受讓人當天此餐別已有訂單');

    order.employeeId = toEmployeeId;
    clearDelegation(order); // 轉讓後舊的代領授權一併清除
    store.save();
    log('order.transfer', { id: order.id, from: employeeId, to: toEmployeeId });
    return orderView(order);
  }

  function delegateOrder(employeeId, orderId, delegateId) {
    const order = assertOwnedPendingOrder(employeeId, orderId);
    if (!delegateId) throw new AppError(400, '請先指定代領人員編');
    if (delegateId === employeeId) throw new AppError(400, '不可指定自己為代領人');
    requireEmployee(delegateId);

    order.delegateId = delegateId;
    order.delegateCode = generateDelegateCode();
    store.save();
    log('order.delegate', { id: order.id, employeeId, delegateId });
    return orderView(order);
  }

  function undelegateOrder(employeeId, orderId) {
    const order = assertOwnedPendingOrder(employeeId, orderId);
    clearDelegation(order);
    store.save();
    log('order.undelegate', { id: order.id, employeeId });
    return orderView(order);
  }

  // ---------- 取餐口 ----------

  function normalizeCode(raw) {
    return String(raw || '').trim().toUpperCase();
  }

  // 取餐口掃碼：委託碼（DLG:XXXXXX 或純代碼）優先比對；否則視為員工編號（EMP:xxx 或純員編）。
  function pickupLookup(raw) {
    const today = taipeiNow();
    const value = String(raw || '').trim();
    if (!value) throw new AppError(400, '請掃描或輸入取餐碼');

    const delegateCode = normalizeCode(value.replace(/^DLG:/i, ''));
    const delegated = activeOrders(
      (o) => o.date === today.date && o.delegateCode && o.delegateCode === delegateCode,
    )[0];
    if (delegated) {
      const view = orderView(delegated);
      if (view.status === 'picked') return { mode: 'delegate', status: 'picked', order: view, message: '此餐已取餐' };
      if (view.status !== 'booked') return { mode: 'delegate', status: view.status, order: view, message: '此訂單目前不可取餐' };
      return {
        mode: 'delegate',
        status: 'need_employee_id',
        order: view,
        message: `委託取餐：${view.employeeName} 委託 ${view.delegateName} 代領，請代領人輸入自己的員工編號`,
      };
    }

    const employeeId = value.replace(/^EMP:/i, '').trim();
    const employee = getEmployee(employeeId);
    if (!employee) return { mode: 'self', status: 'not_found', message: '查無此員工編號，無法取餐' };

    const orders = activeOrders((o) => o.date === today.date && o.employeeId === employeeId).map(orderView);
    if (orders.length === 0) {
      return { mode: 'self', status: 'no_order', employee, orders, message: '今日未訂餐' };
    }
    return { mode: 'self', status: 'ok', employee, orders, message: `${employee.name} 今日已訂餐` };
  }

  function pickupConfirm({ orderId, code, employeeId }) {
    const today = taipeiNow();
    let order;
    if (code) {
      const delegateCode = normalizeCode(String(code).replace(/^DLG:/i, ''));
      order = activeOrders((o) => o.date === today.date && o.delegateCode === delegateCode)[0];
      if (!order) throw new AppError(404, '委託取餐碼無效或已失效');
    } else {
      order = findOrder(orderId);
    }

    if (order.status === 'cancelled') throw new AppError(409, '訂單已取消');
    if (order.status === 'picked') throw new AppError(409, '此餐已取餐');
    if (isPastMealDeadline(order)) throw new AppError(409, '已逾期未取餐，請洽行政人員');
    if (!employeeId) throw new AppError(400, '請輸入員工編號');

    if (order.delegateId) {
      // 有委託：只認指定的代領人，訂餐人本人也不放行
      if (employeeId !== order.delegateId) throw new AppError(403, MSG.DELEGATE_MISMATCH);
    } else if (employeeId !== order.employeeId) {
      throw new AppError(403, MSG.NOT_OWNER);
    }

    order.status = 'picked';
    order.pickedBy = employeeId;
    order.pickedAt = new Date().toISOString();
    store.save();
    log('pickup.confirm', { id: order.id, by: employeeId, delegated: Boolean(order.delegateId) });
    return orderView(order);
  }

  // ---------- 管理端：未取餐、扣款、報表 ----------

  function unclaimedOrders(date) {
    return store.db.orders
      .filter((o) => o.date === date && o.status === 'booked')
      .filter((o) => !isExempt(date, o.employeeId) && isPastMealDeadline(o));
  }

  function setExemption(date, employeeId, reason) {
    if (!isValidDate(date)) throw new AppError(400, '日期格式需為 YYYY-MM-DD');
    requireEmployee(employeeId);
    store.db.exemptions[date] = store.db.exemptions[date] || {};
    store.db.exemptions[date][employeeId] = reason || '例外';
    store.save();
    log('exemption.set', { date, employeeId, reason });
    return store.db.exemptions[date];
  }

  function removeExemption(date, employeeId) {
    if (store.db.exemptions[date]) delete store.db.exemptions[date][employeeId];
    store.save();
    log('exemption.remove', { date, employeeId });
    return store.db.exemptions[date] || {};
  }

  function setDeductionStatus(orderId, status) {
    if (!['pending', 'sent_to_hr', 'waived'].includes(status)) {
      throw new AppError(400, '扣款狀態需為 pending、sent_to_hr 或 waived');
    }
    const order = findOrder(orderId);
    order.deductionStatus = status;
    store.save();
    log('deduction.update', { id: order.id, status });
    return orderView(order);
  }

  function dayReport(date) {
    if (!isValidDate(date)) throw new AppError(400, '日期格式需為 YYYY-MM-DD');

    const dayOrders = activeOrders((o) => o.date === date);
    const byPrice = {};
    const byMeal = { lunch: 0, dinner: 0 };
    dayOrders.forEach((o) => {
      byPrice[o.price] = (byPrice[o.price] || 0) + 1;
      byMeal[o.meal] += 1;
    });

    const unclaimed = unclaimedOrders(date);
    unclaimed.forEach((o) => {
      if (!o.deductionStatus) o.deductionStatus = 'pending';
    });
    store.save();

    const deductionList = unclaimed.map(orderView);
    return {
      date,
      totalOrders: dayOrders.length,
      picked: dayOrders.filter((o) => o.status === 'picked').length,
      waiting: dayOrders.filter((o) => o.status === 'booked' && !isPastMealDeadline(o)).length,
      byPrice,
      byMeal,
      unclaimedCount: deductionList.length,
      deductionTotal: deductionList.reduce((sum, o) => sum + o.amount, 0),
      deductionList,
    };
  }

  function dayOrders(date) {
    if (!isValidDate(date)) throw new AppError(400, '日期格式需為 YYYY-MM-DD');
    return store.db.orders.filter((o) => o.date === date).map(orderView);
  }

  return {
    MSG,
    MEAL_LABEL,
    AppError,
    getConfig,
    updateConfig,
    importEmployees,
    listEmployees,
    getEmployee,
    findBinding,
    bindEmployee,
    listBindings,
    unbind,
    getMenu,
    setMenu,
    menuForDate,
    placeOrder,
    cancelOrder,
    transferOrder,
    delegateOrder,
    undelegateOrder,
    pickupLookup,
    pickupConfirm,
    setExemption,
    removeExemption,
    setDeductionStatus,
    dayReport,
    dayOrders,
    orderingStatus,
    audit,
    listAudit,
  };
}

module.exports = { createService, AppError, MSG };
