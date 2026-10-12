// 業務邏輯層：訂餐、委託、轉讓、取餐驗證、未取餐與報表。
// 路由層（app.js）只負責 HTTP 參數與權限，規則都在這裡。

const crypto = require('node:crypto');
const { MEAL_DEADLINES, taipeiNow, isValidDate, isValidTime } = require('./time');
const { parseCsv } = require('./csv');
const { createTokenService } = require('./pickup-token');

const MEAL_LABEL = { lunch: '午餐', dinner: '晚餐' };
const DELEGATE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的 0/O/1/I/L

const MSG = {
  DELEGATE_MISMATCH: '此委託取餐僅開放給指定同事，員工編號不符，拒絕放行',
  NOT_OWNER: '此訂單不屬於該員工編號，拒絕放行',
  MANUAL_DISABLED: '已停用手動輸入員編，請出示動態取餐碼',
};

const PICK_VIA_LABEL = { token: '動態碼', manual: '手動輸入（未驗證）', delegate: '委託代領' };

// 兩個 YYYY-MM-DD 之間相差幾天（b − a）
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

class AppError extends Error {
  // details：選填，給前端顯示逐列錯誤等細節（例如匯入檔的第幾列有問題）
  constructor(status, message, details) {
    super(message);
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function createService(store, { tokens } = {}) {
  const tokenService = tokens || createTokenService();

  // 員編正規化：去空白、轉大寫；純數字且位數不足時補零（Excel 轉 CSV 常把 012003 吃成 12003）
  function normalizeEmployeeId(raw) {
    let id = String(raw === undefined || raw === null ? '' : raw).trim().toUpperCase();
    const length = store.config.employeeIdLength;
    if (length > 0 && /^\d+$/.test(id) && id.length < length) id = id.padStart(length, '0');
    return id;
  }

  function log(action, detail) {
    store.history.add(action, detail);
  }

  // 後台操作紀錄：只記誰、對哪個路徑做了什麼方法，不記請求內容（避免寫入密碼）
  function audit(actor, method, requestPath) {
    log('admin.request', { actor, method, path: requestPath });
  }

  function listAudit(limit = 200) {
    return store.history.audit(limit);
  }

  // ---------- 時間與截止判斷 ----------

  function orderingStatus(date) {
    const today = taipeiNow();
    const cutoff = store.config.orderCutoff;
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
    return store.exemptions.has(date, employeeId);
  }

  // ---------- 設定 ----------

  function getConfig() {
    return { ...store.config };
  }

  function updateConfig(patch) {
    return store.tx(() => {
      if (patch.orderCutoff !== undefined) {
        if (!isValidTime(patch.orderCutoff)) throw new AppError(400, '截止時間格式需為 HH:mm');
        store.setConfig('orderCutoff', patch.orderCutoff);
      }
      if (patch.subsidy !== undefined) {
        const n = Number(patch.subsidy);
        if (!Number.isInteger(n) || n < 0) throw new AppError(400, '補貼金額需為非負整數');
        store.setConfig('subsidy', n);
      }
      if (patch.employeeIdLength !== undefined) {
        const n = Number(patch.employeeIdLength);
        if (!Number.isInteger(n) || n < 0 || n > 12) throw new AppError(400, '員編位數需為 0–12 的整數（0 表示不補零）');
        store.setConfig('employeeIdLength', n);
      }
      if (patch.allowManualPickup !== undefined) {
        store.setConfig('allowManualPickup', Boolean(patch.allowManualPickup));
      }
      if (patch.specialLeadDays !== undefined) {
        const n = Number(patch.specialLeadDays);
        if (!Number.isInteger(n) || n < 0 || n > 30) throw new AppError(400, '特殊商品提前天數需為 0–30 的整數');
        store.setConfig('specialLeadDays', n);
      }
      log('config.update', patch);
      return getConfig();
    });
  }

  // ---------- 員工名單 ----------

  const HEADER_MAP = {
    id: ['員工編號', '員編', 'employee_id', 'employeeid', 'id'],
    name: ['姓名', 'name'],
    dept: ['部門', 'dept', 'department'],
    deptCode: ['部門代號', '部門代碼', 'dept_code', 'deptcode'],
    deptName: ['部門名稱', 'dept_name', 'deptname'],
    verify: ['驗證碼', 'verify', 'verification', 'verify_code'],
  };

  function findColumn(headers, key) {
    const lower = headers.map((h) => h.toLowerCase());
    return HEADER_MAP[key].map((alias) => lower.indexOf(alias.toLowerCase())).find((i) => i >= 0);
  }

  // rows：第一列為標題的二維陣列（CSV 或 Excel 解析後的結果）。
  // 有問題的列會略過並回報，其餘照常匯入。
  function importEmployeeRows(rows) {
    if (!Array.isArray(rows) || rows.length < 2) throw new AppError(400, '至少需要標題列與一筆資料');

    const headers = rows[0].map((h) => String(h === null || h === undefined ? '' : h).trim());
    const cols = {
      id: findColumn(headers, 'id'),
      name: findColumn(headers, 'name'),
      dept: findColumn(headers, 'dept'),
      deptCode: findColumn(headers, 'deptCode'),
      deptName: findColumn(headers, 'deptName'),
      verify: findColumn(headers, 'verify'),
    };
    if (cols.id === undefined || cols.name === undefined) {
      throw new AppError(400, '標題列需包含「員工編號」與「姓名」欄位');
    }

    return store.tx(() => {
      let created = 0;
      let updated = 0;
      let padded = 0;
      const errors = [];
      rows.slice(1).forEach((row, index) => {
        const line = index + 2;
        const cell = (i) => (i === undefined || row[i] === null || row[i] === undefined ? '' : String(row[i]).trim());
        const rawId = cell(cols.id);
        const id = normalizeEmployeeId(rawId);
        const name = cell(cols.name);
        // 部門可以是單一「部門」欄，或公司匯出的「部門代號」＋「部門名稱」兩欄
        const dept = cell(cols.dept) || `${cell(cols.deptCode)} ${cell(cols.deptName)}`.trim();
        const verify = cell(cols.verify);
        if (!rawId && !name) return; // 完全空白的列直接略過
        if (!id || !name) {
          errors.push({ line, message: '員工編號或姓名為空' });
          return;
        }
        if (id !== rawId.toUpperCase()) padded += 1;
        if (store.employees.upsert({ id, name, dept, verify }) === 'updated') updated += 1;
        else created += 1;
      });
      log('employees.import', { created, updated, padded, errors: errors.length });
      return { created, updated, padded, errors, total: store.employees.count() };
    });
  }

  function importEmployees(csvText) {
    return importEmployeeRows(parseCsv(String(csvText || '')));
  }

  function boundEmployeeIds() {
    return store.bindings.employeeIds();
  }

  // 管理端列表不回傳驗證碼本身，只標示有無，以及是否已綁定 LINE
  function listEmployees() {
    const bound = boundEmployeeIds();
    return store.employees.all()
      .map(({ verify, ...rest }) => ({ ...rest, hasVerify: Boolean(verify), bound: bound.has(rest.id) }));
  }

  // 對外（員工頁、取餐口）只提供安全欄位，避免驗證碼外流
  function publicEmployee(employee) {
    if (!employee) return null;
    return { id: employee.id, name: employee.name, dept: employee.dept };
  }

  function getEmployee(id) {
    return publicEmployee(store.employees.get(normalizeEmployeeId(id)));
  }

  // ---------- LINE 帳號綁定 ----------

  const MAX_BIND_FAILURES = 5;
  const BIND_LOCK_MS = 15 * 60 * 1000;
  const bindFailures = new Map(); // lineUserId -> { count, until }

  function findBinding(lineUserId) {
    const binding = store.bindings.get(lineUserId);
    return binding ? getEmployee(binding.employeeId) : null;
  }

  function bindEmployee({ lineUserId, displayName, employeeId, name, verification }) {
    if (!lineUserId) throw new AppError(400, '缺少 LINE 身分');
    const failure = bindFailures.get(lineUserId);
    if (failure && failure.until > Date.now()) {
      throw new AppError(429, '嘗試次數過多，請 15 分鐘後再試，或洽行政人員協助');
    }

    const id = normalizeEmployeeId(employeeId);
    const record = store.employees.get(id);
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

    return store.tx(() => {
      const existing = store.bindings.byEmployee(id);
      if (existing && existing.lineUserId !== lineUserId) {
        throw new AppError(409, '此員工編號已綁定其他 LINE 帳號，如需更換請洽行政人員解除綁定');
      }
      // 同一個 LINE 帳號換綁別的員編也不允許，避免一個帳號冒用多人
      const current = store.bindings.get(lineUserId);
      if (current && current.employeeId !== id) {
        throw new AppError(409, '此 LINE 帳號已綁定其他員工，如需更換請洽行政人員解除綁定');
      }

      store.bindings.upsert({ lineUserId, employeeId: id, displayName: displayName || '', boundAt: new Date().toISOString() });
      bindFailures.delete(lineUserId);
      log('binding.create', { employeeId: id, lineUserId });
      return getEmployee(id);
    });
  }

  function listBindings() {
    return store.bindings.all().map((b) => {
      const employee = getEmployee(b.employeeId);
      return {
        lineUserId: b.lineUserId,
        displayName: b.displayName,
        employeeId: b.employeeId,
        employeeName: employee ? employee.name : '',
        boundAt: b.boundAt,
      };
    });
  }

  function unbind(lineUserId) {
    return store.tx(() => {
      const binding = store.bindings.get(lineUserId);
      if (!binding) throw new AppError(404, '找不到此綁定');
      store.bindings.delete(lineUserId);
      bindFailures.delete(lineUserId);
      log('binding.remove', { employeeId: binding.employeeId, lineUserId });
      return { removed: true };
    });
  }

  function requireEmployee(id) {
    const employee = getEmployee(id);
    if (!employee) throw new AppError(404, '查無此員工編號，僅限內部員工使用');
    return employee;
  }

  // ---------- 菜單 ----------

  function getMenu(date) {
    return store.menus.get(date);
  }

  function setMenu(date, items) {
    if (!isValidDate(date)) throw new AppError(400, '日期格式需為 YYYY-MM-DD');
    if (!Array.isArray(items)) throw new AppError(400, 'items 需為陣列');

    const normalized = items.map((raw, index) => {
      const meal = raw.meal;
      const name = String(raw.name || '').trim();
      const price = Number(raw.price);
      const sides = (Array.isArray(raw.sides) ? raw.sides : String(raw.sides || '').split(/[、,，]/))
        .map((x) => String(x).trim())
        .filter(Boolean);
      if (!MEAL_LABEL[meal]) throw new AppError(400, `第 ${index + 1} 項：餐別需為 lunch 或 dinner`);
      if (!name) throw new AppError(400, `第 ${index + 1} 項：品名不可為空`);
      if (!Number.isInteger(price) || price <= 0) throw new AppError(400, `第 ${index + 1} 項：價格需為正整數`);
      return {
        id: raw.id || store.nextId('M'),
        meal,
        name,
        price,
        main: String(raw.main || '').trim(),
        sides,
        veg: String(raw.veg || '').trim(),
        special: Boolean(raw.special), // ★ 特殊商品：須提前 specialLeadDays 天訂購
      };
    });

    return store.tx(() => {
      store.menus.set(date, normalized);
      log('menu.set', { date, count: normalized.length });
      return getMenu(date);
    });
  }

  // ---------- 訂單視圖 ----------

  function amountFor(order) {
    return Math.max(0, order.price - store.config.subsidy);
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
      employeeDept: owner ? owner.dept : '',
      special: Boolean(order.special),
      status: statusOf(order),
      changeable: order.status === 'booked' && orderingStatus(order.date).open,
      delegateId: order.delegateId,
      delegateName: delegate ? delegate.name : null,
      delegateCode: order.delegateId ? order.delegateCode : null,
      pickedBy: order.pickedBy,
      pickedAt: order.pickedAt,
      pickedVia: order.pickedVia || null,
      pickedViaLabel: order.pickedVia ? PICK_VIA_LABEL[order.pickedVia] : null,
      pickedKiosk: order.pickedKiosk || null,
      deductionStatus: order.deductionStatus,
      createdAt: order.createdAt,
    };
  }

  function findOrder(orderId) {
    const order = store.orders.get(orderId);
    if (!order) throw new AppError(404, '找不到訂單');
    return order;
  }

  function generateDelegateCode() {
    for (;;) {
      const bytes = crypto.randomBytes(6);
      let code = '';
      for (let i = 0; i < 6; i += 1) code += DELEGATE_ALPHABET[bytes[i] % DELEGATE_ALPHABET.length];
      if (!store.orders.delegateCodeExists(code)) return code;
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
    const availableDates = store.menus.datesFrom(today.date, month);
    const myOrders = store.orders.byDateEmployee(day, employeeId).map(orderView);
    const delegatedToMe = store.orders.byDelegate(day, employeeId).map(orderView);
    const upcoming = store.orders.upcoming(employeeId, today.date, month).map(orderView);

    return {
      today: today.date,
      date: day,
      time: today.time,
      cutoff: store.config.orderCutoff,
      subsidy: store.config.subsidy,
      ordering: orderingStatus(day),
      specialLeadDays: store.config.specialLeadDays,
      items: getMenu(day).map((item) => {
        const locked = item.special && daysBetween(today.date, day) < store.config.specialLeadDays;
        return {
          ...item,
          orderable: !locked,
          lockReason: locked ? `特殊商品須於用餐日前 ${store.config.specialLeadDays} 天訂購` : null,
        };
      }),
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

    return store.tx(() => {
      const item = getMenu(day).find((i) => i.id === itemId);
      if (!item) throw new AppError(404, '該日菜單沒有此品項');
      const leadDays = store.config.specialLeadDays;
      if (item.special && daysBetween(taipeiNow().date, day) < leadDays) {
        throw new AppError(409, `「${item.name}」為特殊商品，須於用餐日前 ${leadDays} 天完成訂購，已無法訂購`);
      }

      if (store.orders.activeFor(day, employeeId, item.meal)) {
        throw new AppError(409, `${day} 的${MEAL_LABEL[item.meal]}已訂購，請先取消再重新訂購`);
      }

      const order = {
        id: store.nextId('O'),
        date: day,
        employeeId,
        meal: item.meal,
        itemId: item.id,
        itemName: item.name,
        price: item.price,
        special: item.special,
        status: 'booked',
        delegateId: null,
        delegateCode: null,
        pickedBy: null,
        pickedAt: null,
        deductionStatus: null,
        createdAt: new Date().toISOString(),
      };
      store.orders.insert(order);
      log('order.create', { id: order.id, employeeId, item: item.name });
      return orderView(order);
    });
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
    return store.tx(() => {
      const order = assertOwnedOpenOrder(employeeId, orderId);
      order.status = 'cancelled';
      clearDelegation(order);
      store.orders.update(order);
      log('order.cancel', { id: order.id, employeeId });
      return orderView(order);
    });
  }

  function transferOrder(employeeId, orderId, rawToEmployeeId) {
    return store.tx(() => {
      const order = assertOwnedOpenOrder(employeeId, orderId);
      if (!rawToEmployeeId) throw new AppError(400, '請輸入受讓人員編');
      const toEmployeeId = normalizeEmployeeId(rawToEmployeeId);
      if (toEmployeeId === employeeId) throw new AppError(400, '不可轉讓給自己');
      requireEmployee(toEmployeeId);

      if (store.orders.activeFor(order.date, toEmployeeId, order.meal)) {
        throw new AppError(409, '受讓人當天此餐別已有訂單');
      }

      order.employeeId = toEmployeeId; // 費用隨訂單一起轉給受讓人
      clearDelegation(order); // 轉讓後舊的代領授權一併清除
      store.orders.update(order);
      log('order.transfer', { id: order.id, from: employeeId, to: toEmployeeId });
      return orderView(order);
    });
  }

  function delegateOrder(employeeId, orderId, rawDelegateId) {
    return store.tx(() => {
      const order = assertOwnedPendingOrder(employeeId, orderId);
      if (!rawDelegateId) throw new AppError(400, '請先指定代領人員編');
      const delegateId = normalizeEmployeeId(rawDelegateId);
      if (delegateId === employeeId) throw new AppError(400, '不可指定自己為代領人');
      requireEmployee(delegateId);

      order.delegateId = delegateId;
      order.delegateCode = generateDelegateCode();
      store.orders.update(order);
      log('order.delegate', { id: order.id, employeeId, delegateId });
      return orderView(order);
    });
  }

  function undelegateOrder(employeeId, orderId) {
    return store.tx(() => {
      const order = assertOwnedPendingOrder(employeeId, orderId);
      clearDelegation(order);
      store.orders.update(order);
      log('order.undelegate', { id: order.id, employeeId });
      return orderView(order);
    });
  }

  // ---------- 取餐口 ----------

  function normalizeCode(raw) {
    return String(raw || '').trim().toUpperCase();
  }

  function selfLookup(employeeId, { verified, kioskId }) {
    const today = taipeiNow();
    const employee = getEmployee(employeeId);
    if (!employee) return { mode: 'self', status: 'not_found', verified, message: '查無此員工編號，無法取餐' };

    const orders = store.orders.byDateEmployee(today.date, employee.id).map(orderView);
    const base = { mode: 'self', verified, employee, orders };
    // 只有通過動態碼驗證才發取餐憑證；手動輸入沒有憑證，確認時會記錄為「未驗證」
    if (verified) base.ticket = tokenService.issueTicket(employee.id, kioskId);
    if (orders.length === 0) return { ...base, status: 'no_order', message: '今日未訂餐' };
    return { ...base, status: 'ok', message: `${employee.name} 今日已訂餐` };
  }

  function delegateLookup(order) {
    const view = orderView(order);
    if (view.status === 'picked') return { mode: 'delegate', status: 'picked', order: view, message: '此餐已取餐' };
    if (view.status !== 'booked') return { mode: 'delegate', status: view.status, order: view, message: '此訂單目前不可取餐' };
    return {
      mode: 'delegate',
      status: 'need_employee_id',
      order: view,
      message: `委託取餐：${view.employeeName} 委託 ${view.delegateName} 代領，請代領人輸入自己的員工編號`,
    };
  }

  // 取餐口掃碼或輸入。依內容分三種：
  //   1. 動態取餐碼（P.員編.窗格.簽章）：驗證簽章與時效，通過才發取餐憑證
  //   2. 員編（手動輸入、刷識別證、舊式 EMP:員編）：後備方式，可由設定停用，取餐會記錄為「未驗證」
  //   3. 委託碼（DLG:代碼 或純代碼）：之後仍須代領人輸入自己的員編
  function pickupLookup(raw, { kioskId } = {}) {
    const today = taipeiNow();
    const value = String(raw || '').trim();
    if (!value) throw new AppError(400, '請掃描或輸入取餐碼');

    if (tokenService.looksLikeToken(value)) {
      const result = tokenService.verify(value);
      if (!result.ok) {
        return {
          mode: 'self',
          status: 'invalid_token',
          verified: false,
          message: result.reason === 'expired'
            ? 'QR Code 已逾時，請在手機畫面重新整理後再掃一次'
            : 'QR Code 簽章驗證失敗，拒絕放行',
        };
      }
      return selfLookup(result.employeeId, { verified: true, kioskId });
    }

    const hasDelegatePrefix = /^DLG:/i.test(value);
    const asEmployeeId = value.replace(/^EMP:/i, '');
    // 員編優先於委託碼，避免純數字員編撞到委託碼
    if (!hasDelegatePrefix && getEmployee(asEmployeeId)) {
      if (!store.config.allowManualPickup) {
        return { mode: 'self', status: 'manual_disabled', verified: false, message: MSG.MANUAL_DISABLED };
      }
      return selfLookup(asEmployeeId, { verified: false, kioskId });
    }

    const delegateCode = normalizeCode(value.replace(/^DLG:/i, ''));
    const delegated = store.orders.byDelegateCode(today.date, delegateCode);
    if (delegated) return delegateLookup(delegated);

    return { mode: 'self', status: 'not_found', verified: false, message: '查無此員工編號或委託碼，無法取餐' };
  }

  // 確認取餐有三條路：
  //   委託：{ code, employeeId }  代領人輸入自己的員編，必須等於指定代領人
  //   動態碼：{ orderId, ticket }  憑證由 lookup 簽發，綁定員工與取餐口
  //   手動：{ orderId, employeeId }  後備方式，記錄為未驗證
  function pickupConfirm({ orderId, code, employeeId, ticket }, { kioskId } = {}) {
    const today = taipeiNow();
    return store.tx(() => {
      let order;
      let via;
      let actor;

      if (code) {
        const delegateCode = normalizeCode(String(code).replace(/^DLG:/i, ''));
        order = store.orders.byDelegateCode(today.date, delegateCode);
        if (!order) throw new AppError(404, '委託取餐碼無效或已失效');
        if (!employeeId) throw new AppError(400, '請輸入員工編號');
        actor = normalizeEmployeeId(employeeId);
        via = 'delegate';
      } else {
        order = findOrder(orderId);
        if (ticket) {
          const result = tokenService.verifyTicket(ticket, kioskId);
          if (!result.ok) throw new AppError(403, '取餐憑證無效或已逾時，請重新掃描動態取餐碼');
          actor = result.employeeId;
          via = 'token';
        } else {
          if (!store.config.allowManualPickup) throw new AppError(403, MSG.MANUAL_DISABLED);
          if (!employeeId) throw new AppError(400, '請輸入員工編號');
          actor = normalizeEmployeeId(employeeId);
          via = 'manual';
        }
      }

      if (order.status === 'cancelled') throw new AppError(409, '訂單已取消');
      if (order.status === 'picked') throw new AppError(409, '此餐已取餐');
      if (isPastMealDeadline(order)) throw new AppError(409, '已逾期未取餐，請洽行政人員');

      if (order.delegateId) {
        // 有委託：只認指定的代領人，訂餐人本人也不放行
        if (actor !== order.delegateId) throw new AppError(403, MSG.DELEGATE_MISMATCH);
      } else if (actor !== order.employeeId) {
        throw new AppError(403, MSG.NOT_OWNER);
      }

      order.status = 'picked';
      order.pickedBy = actor;
      order.pickedAt = new Date().toISOString();
      order.pickedVia = via;
      order.pickedKiosk = kioskId || null;
      store.orders.update(order);
      log('pickup.confirm', { id: order.id, by: actor, via, kiosk: kioskId || null });
      return orderView(order);
    });
  }

  // ---------- 管理端：未取餐、扣款、報表 ----------

  function unclaimedOrders(date) {
    return store.orders.byDate(date)
      .filter((o) => o.status === 'booked' && !isExempt(date, o.employeeId) && isPastMealDeadline(o));
  }

  function setExemption(date, rawEmployeeId, reason) {
    if (!isValidDate(date)) throw new AppError(400, '日期格式需為 YYYY-MM-DD');
    const employeeId = normalizeEmployeeId(rawEmployeeId);
    requireEmployee(employeeId);
    return store.tx(() => {
      store.exemptions.set(date, employeeId, reason || '例外');
      log('exemption.set', { date, employeeId, reason });
      return store.exemptions.forDate(date);
    });
  }

  function removeExemption(date, rawEmployeeId) {
    const employeeId = normalizeEmployeeId(rawEmployeeId);
    return store.tx(() => {
      store.exemptions.delete(date, employeeId);
      log('exemption.remove', { date, employeeId });
      return store.exemptions.forDate(date);
    });
  }

  function setDeductionStatus(orderId, status) {
    if (!['pending', 'sent_to_hr', 'waived'].includes(status)) {
      throw new AppError(400, '扣款狀態需為 pending、sent_to_hr 或 waived');
    }
    return store.tx(() => {
      const order = findOrder(orderId);
      order.deductionStatus = status;
      store.orders.update(order);
      log('deduction.update', { id: order.id, status });
      return orderView(order);
    });
  }

  function dayReport(date) {
    if (!isValidDate(date)) throw new AppError(400, '日期格式需為 YYYY-MM-DD');

    return store.tx(() => {
      const orders = store.orders.byDate(date);
      const byPrice = {};
      const byMeal = { lunch: 0, dinner: 0 };
      const byVia = { token: 0, manual: 0, delegate: 0 };
      let totalSpend = 0;
      let employeePayTotal = 0;
      orders.forEach((o) => {
        byPrice[o.price] = (byPrice[o.price] || 0) + 1;
        byMeal[o.meal] += 1;
        totalSpend += o.price;
        employeePayTotal += amountFor(o);
        if (o.status === 'picked' && byVia[o.pickedVia] !== undefined) byVia[o.pickedVia] += 1;
      });

      // 未取餐的訂單第一次被看到時，標記為「待處理」扣款
      const unclaimed = unclaimedOrders(date);
      unclaimed.forEach((o) => {
        if (!o.deductionStatus) {
          o.deductionStatus = 'pending';
          store.orders.update(o);
        }
      });

      const deductionList = unclaimed.map(orderView);
      return {
        date,
        totalOrders: orders.length,
        picked: orders.filter((o) => o.status === 'picked').length,
        waiting: orders.filter((o) => o.status === 'booked' && !isPastMealDeadline(o)).length,
        byPrice,
        byMeal,
        byVia,
        totalSpend,
        subsidyTotal: totalSpend - employeePayTotal,
        employeePayTotal,
        unclaimedCount: deductionList.length,
        deductionTotal: deductionList.reduce((sum, o) => sum + o.amount, 0),
        deductionList,
      };
    });
  }

  function dayOrders(date) {
    if (!isValidDate(date)) throw new AppError(400, '日期格式需為 YYYY-MM-DD');
    return store.orders.byDateAll(date).map(orderView);
  }

  return {
    MSG,
    MEAL_LABEL,
    AppError,
    getConfig,
    updateConfig,
    importEmployees,
    importEmployeeRows,
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
    normalizeEmployeeId,
    tokenService,
    audit,
    listAudit,
  };
}

module.exports = { createService, AppError, MSG };
