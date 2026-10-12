// 原型用的 JSON 檔案儲存。每次寫入都整檔落地（先寫暫存檔再 rename），資料量約千人規模足夠。
// 之後若要正式上線，可以替換成 PostgreSQL 或 SQL Server，只需保留相同的介面。

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'db.json');

function emptyDb() {
  return {
    config: {
      orderCutoff: '10:00', // 每日統一截止時間（暫定，後台可改）
      subsidy: 33, // 公司補貼金額（元）
      employeeIdLength: 6, // 純數字員編補零到幾碼（0 = 不補）；避免 Excel 吃掉前導零
      allowManualPickup: true, // 取餐口是否允許手動輸入員編（未經動態碼驗證的後備方式）
      specialLeadDays: 3, // ★ 特殊商品須提前幾天訂購
    },
    employees: {}, // { [employeeId]: { id, name, dept, verify? } }
    bindings: {}, // { [lineUserId]: { employeeId, displayName, boundAt } }
    admins: {}, // { [username]: { username, displayName, role, active, salt, hash, createdAt } }
    kiosks: {}, // { [deviceId]: { id, name, active, salt, hash, createdAt, lastSeen } }
    menus: {}, // { [date]: [{ id, meal, name, price }] }
    orders: [], // 見 service.js createOrder
    exemptions: {}, // { [date]: { [employeeId]: reason } }
    history: [], // 操作紀錄
    seq: 0,
  };
}

function createStore(file = process.env.DATA_FILE || DEFAULT_FILE) {
  let db;
  if (file && fs.existsSync(file)) {
    db = JSON.parse(fs.readFileSync(file, 'utf8'));
    db.bindings = db.bindings || {}; // 舊版資料檔沒有這些欄位
    db.admins = db.admins || {};
    db.kiosks = db.kiosks || {};
    db.config = { ...emptyDb().config, ...db.config }; // 舊資料檔補上新增的設定預設值
  } else {
    db = emptyDb();
  }

  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  }

  function nextId(prefix) {
    db.seq += 1;
    return `${prefix}${db.seq}`;
  }

  return {
    get db() {
      return db;
    },
    save,
    nextId,
    reset() {
      db = emptyDb();
      save();
    },
  };
}

module.exports = { createStore, emptyDb };
