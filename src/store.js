// SQLite 儲存層（Node 內建的 node:sqlite，不需另外安裝或編譯）。
//
// 為什麼不再用 JSON 檔：每次寫入都整檔重寫，當機或斷電可能留下損毀的檔案；
// SQLite 有交易與預寫式日誌（WAL），寫到一半當機也只會回到上一個完整狀態，
// 並且可以用索引快速查詢、用 SQL 工具直接檢視。
//
// 這一層只負責資料的存取與型別轉換，不含業務規則（規則在 service.js）。
// createStore(null) 或 createStore(':memory:') 會建立純記憶體資料庫，測試使用。

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'bookinglunch.db');
const SCHEMA_VERSION = 1;

const DEFAULT_CONFIG = {
  orderCutoff: '10:00', // 每日統一截止時間（暫定，後台可改）
  subsidy: 33, // 公司補貼金額（元）
  employeeIdLength: 6, // 純數字員編補零到幾碼（0 = 不補）；避免 Excel 吃掉前導零
  allowManualPickup: true, // 取餐口是否允許手動輸入員編（未經動態碼驗證的後備方式）
  specialLeadDays: 3, // ★ 特殊商品須提前幾天訂購
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- JSON
);

CREATE TABLE IF NOT EXISTS employees (
  id     TEXT PRIMARY KEY,       -- 員編（已正規化）
  name   TEXT NOT NULL,
  dept   TEXT NOT NULL DEFAULT '',
  verify TEXT                    -- 綁定 LINE 時的額外驗證碼（可為空）
);

CREATE TABLE IF NOT EXISTS bindings (
  line_user_id TEXT PRIMARY KEY,
  employee_id  TEXT NOT NULL UNIQUE REFERENCES employees(id),   -- 一個員編只能綁一個 LINE 帳號
  display_name TEXT NOT NULL DEFAULT '',
  bound_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  username     TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  salt         TEXT NOT NULL,
  hash         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kiosks (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  salt       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen  TEXT
);

CREATE TABLE IF NOT EXISTS menu_items (
  id       TEXT PRIMARY KEY,
  date     TEXT NOT NULL,
  position INTEGER NOT NULL,
  meal     TEXT NOT NULL CHECK (meal IN ('lunch', 'dinner')),
  name     TEXT NOT NULL,
  price    INTEGER NOT NULL CHECK (price > 0),
  main     TEXT NOT NULL DEFAULT '',
  sides    TEXT NOT NULL DEFAULT '[]',   -- JSON 陣列
  veg      TEXT NOT NULL DEFAULT '',
  special  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS menu_items_date ON menu_items(date, position);

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  date             TEXT NOT NULL,
  employee_id      TEXT NOT NULL REFERENCES employees(id),
  meal             TEXT NOT NULL CHECK (meal IN ('lunch', 'dinner')),
  item_id          TEXT NOT NULL,
  item_name        TEXT NOT NULL,       -- 下單當時的品名與價格，之後改菜單不影響
  price            INTEGER NOT NULL,
  special          INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL CHECK (status IN ('booked', 'picked', 'cancelled')),
  delegate_id      TEXT,
  delegate_code    TEXT,
  picked_by        TEXT,
  picked_at        TEXT,
  picked_via       TEXT,
  picked_kiosk     TEXT,
  deduction_status TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_date ON orders(date);
CREATE INDEX IF NOT EXISTS orders_employee ON orders(employee_id, date);
CREATE INDEX IF NOT EXISTS orders_delegate ON orders(delegate_id, date) WHERE delegate_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_delegate_code ON orders(delegate_code) WHERE delegate_code IS NOT NULL;
-- 資料庫層的最後一道防線：同一人同一天同一餐別只能有一筆有效訂單
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_per_meal ON orders(employee_id, date, meal) WHERE status <> 'cancelled';

CREATE TABLE IF NOT EXISTS exemptions (
  date        TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  reason      TEXT NOT NULL,
  PRIMARY KEY (date, employee_id)
);

CREATE TABLE IF NOT EXISTS history (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL            -- JSON
);
CREATE INDEX IF NOT EXISTS history_action ON history(action, id);
`;

const HISTORY_KEEP = 50000;

const bool = (v) => Boolean(v);

function createStore(file = process.env.DB_FILE || DEFAULT_FILE) {
  const filename = file ? String(file) : ':memory:';
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });

  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  // ---------- 小工具 ----------

  const cache = new Map();
  const q = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const one = (sql, ...params) => {
    const row = q(sql).get(...params);
    return row === undefined ? null : { ...row };
  };
  const many = (sql, ...params) => q(sql).all(...params).map((row) => ({ ...row }));
  const run = (sql, ...params) => q(sql).run(...params);

  // 交易：巢狀呼叫會併入外層交易；丟出例外會整筆回復
  let depth = 0;
  function tx(fn) {
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth = 1;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {
        /* 交易已被 SQLite 自行結束 */
      }
      loadConfig(); // 設定有記憶體快取，回復後要重新載入，避免與資料庫不一致
      throw err;
    } finally {
      depth = 0;
    }
  }

  // ---------- meta / 設定 ----------

  run("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)", String(SCHEMA_VERSION));
  run("INSERT OR IGNORE INTO meta(key, value) VALUES ('seq', '0')");

  const config = {};
  function loadConfig() {
    Object.keys(config).forEach((k) => delete config[k]);
    many('SELECT key, value FROM config').forEach((r) => {
      config[r.key] = JSON.parse(r.value);
    });
    Object.entries(DEFAULT_CONFIG).forEach(([k, v]) => {
      if (!(k in config)) {
        config[k] = v;
        run('INSERT OR IGNORE INTO config(key, value) VALUES (?, ?)', k, JSON.stringify(v));
      }
    });
  }
  loadConfig();

  function setConfig(key, value) {
    run('INSERT INTO config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    config[key] = value;
  }

  function nextId(prefix) {
    const row = q("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'seq' RETURNING value").get();
    return `${prefix}${row.value}`;
  }

  // ---------- 員工與綁定 ----------

  const employees = {
    get(id) {
      const r = one('SELECT * FROM employees WHERE id = ?', id);
      return r && { id: r.id, name: r.name, dept: r.dept, verify: r.verify || undefined };
    },
    all() {
      return many('SELECT * FROM employees ORDER BY id').map((r) => ({ id: r.id, name: r.name, dept: r.dept, verify: r.verify || undefined }));
    },
    count: () => q('SELECT COUNT(*) AS n FROM employees').get().n,
    // 回傳 'created' 或 'updated'
    upsert({ id, name, dept = '', verify }) {
      const existed = Boolean(one('SELECT 1 AS x FROM employees WHERE id = ?', id));
      run(
        'INSERT INTO employees(id, name, dept, verify) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, dept = excluded.dept, verify = excluded.verify',
        id, name, dept, verify || null,
      );
      return existed ? 'updated' : 'created';
    },
  };

  const bindingRow = (r) => r && { lineUserId: r.line_user_id, employeeId: r.employee_id, displayName: r.display_name, boundAt: r.bound_at };
  const bindings = {
    get: (lineUserId) => bindingRow(one('SELECT * FROM bindings WHERE line_user_id = ?', lineUserId)),
    byEmployee: (employeeId) => bindingRow(one('SELECT * FROM bindings WHERE employee_id = ?', employeeId)),
    all: () => many('SELECT * FROM bindings ORDER BY bound_at').map(bindingRow),
    employeeIds: () => new Set(many('SELECT employee_id FROM bindings').map((r) => r.employee_id)),
    upsert({ lineUserId, employeeId, displayName = '', boundAt }) {
      run(
        'INSERT INTO bindings(line_user_id, employee_id, display_name, bound_at) VALUES (?, ?, ?, ?) ON CONFLICT(line_user_id) DO UPDATE SET employee_id = excluded.employee_id, display_name = excluded.display_name, bound_at = excluded.bound_at',
        lineUserId, employeeId, displayName, boundAt,
      );
    },
    delete: (lineUserId) => run('DELETE FROM bindings WHERE line_user_id = ?', lineUserId),
  };

  // ---------- 管理員與取餐口裝置 ----------

  const adminRow = (r) => r && {
    username: r.username, displayName: r.display_name, role: r.role, active: bool(r.active),
    salt: r.salt, hash: r.hash, createdAt: r.created_at,
  };
  const admins = {
    get: (username) => adminRow(one('SELECT * FROM admins WHERE username = ?', username)),
    all: () => many('SELECT * FROM admins ORDER BY username').map(adminRow),
    count: () => q('SELECT COUNT(*) AS n FROM admins').get().n,
    save(a) {
      run(
        `INSERT INTO admins(username, display_name, role, active, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, role = excluded.role, active = excluded.active, salt = excluded.salt, hash = excluded.hash`,
        a.username, a.displayName, a.role, a.active ? 1 : 0, a.salt, a.hash, a.createdAt,
      );
    },
  };

  const kioskRow = (r) => r && {
    id: r.id, name: r.name, active: bool(r.active), salt: r.salt, hash: r.hash, createdAt: r.created_at, lastSeen: r.last_seen,
  };
  const kiosks = {
    get: (id) => kioskRow(one('SELECT * FROM kiosks WHERE id = ?', id)),
    all: () => many('SELECT * FROM kiosks ORDER BY id').map(kioskRow),
    save(k) {
      run(
        `INSERT INTO kiosks(id, name, active, salt, hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = excluded.active, salt = excluded.salt, hash = excluded.hash, last_seen = excluded.last_seen`,
        k.id, k.name, k.active ? 1 : 0, k.salt, k.hash, k.createdAt, k.lastSeen || null,
      );
    },
  };

  // ---------- 菜單 ----------

  const menuRow = (r) => ({
    id: r.id, meal: r.meal, name: r.name, price: r.price, main: r.main,
    sides: JSON.parse(r.sides), veg: r.veg, special: bool(r.special),
  });
  const menus = {
    get: (date) => many('SELECT * FROM menu_items WHERE date = ? ORDER BY position', date).map(menuRow),
    // 取代整天的菜單
    set(date, items) {
      tx(() => {
        run('DELETE FROM menu_items WHERE date = ?', date);
        items.forEach((item, position) => {
          run(
            'INSERT INTO menu_items(id, date, position, meal, name, price, main, sides, veg, special) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            item.id, date, position, item.meal, item.name, item.price, item.main || '', JSON.stringify(item.sides || []), item.veg || '', item.special ? 1 : 0,
          );
        });
      });
    },
    // 今天起、指定月份（YYYY-MM）內有菜單的日期
    datesFrom: (fromDate, month) => many(
      'SELECT DISTINCT date FROM menu_items WHERE date >= ? AND substr(date, 1, 7) = ? ORDER BY date', fromDate, month,
    ).map((r) => r.date),
    // 指定月份所有品項，含日期
    byMonth: (month) => many('SELECT * FROM menu_items WHERE substr(date, 1, 7) = ? ORDER BY date, position', month)
      .map((r) => ({ date: r.date, ...menuRow(r) })),
  };

  // ---------- 訂單 ----------

  const orderRow = (r) => r && {
    id: r.id, date: r.date, employeeId: r.employee_id, meal: r.meal, itemId: r.item_id, itemName: r.item_name,
    price: r.price, special: bool(r.special), status: r.status, delegateId: r.delegate_id, delegateCode: r.delegate_code,
    pickedBy: r.picked_by, pickedAt: r.picked_at, pickedVia: r.picked_via, pickedKiosk: r.picked_kiosk,
    deductionStatus: r.deduction_status, createdAt: r.created_at,
  };
  const orderParams = (o) => [
    o.id, o.date, o.employeeId, o.meal, o.itemId, o.itemName, o.price, o.special ? 1 : 0, o.status,
    o.delegateId || null, o.delegateCode || null, o.pickedBy || null, o.pickedAt || null,
    o.pickedVia || null, o.pickedKiosk || null, o.deductionStatus || null, o.createdAt,
  ];
  const orders = {
    get: (id) => orderRow(one('SELECT * FROM orders WHERE id = ?', id)),
    count: () => q('SELECT COUNT(*) AS n FROM orders').get().n,
    insert(o) {
      run(
        `INSERT INTO orders(id, date, employee_id, meal, item_id, item_name, price, special, status, delegate_id, delegate_code,
           picked_by, picked_at, picked_via, picked_kiosk, deduction_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...orderParams(o),
      );
    },
    update(o) {
      run(
        `UPDATE orders SET date = ?2, employee_id = ?3, meal = ?4, item_id = ?5, item_name = ?6, price = ?7, special = ?8, status = ?9,
           delegate_id = ?10, delegate_code = ?11, picked_by = ?12, picked_at = ?13, picked_via = ?14, picked_kiosk = ?15,
           deduction_status = ?16, created_at = ?17 WHERE id = ?1`,
        ...orderParams(o),
      );
    },
    // 某天所有訂單（含已取消）
    byDateAll: (date) => many('SELECT * FROM orders WHERE date = ? ORDER BY meal, employee_id', date).map(orderRow),
    // 某天有效訂單（不含已取消）
    byDate: (date) => many("SELECT * FROM orders WHERE date = ? AND status <> 'cancelled' ORDER BY meal, employee_id", date).map(orderRow),
    byDateEmployee: (date, employeeId) => many(
      "SELECT * FROM orders WHERE date = ? AND employee_id = ? AND status <> 'cancelled' ORDER BY meal", date, employeeId,
    ).map(orderRow),
    // 今天起、指定月份內的有效訂單
    upcoming: (employeeId, fromDate, month) => many(
      "SELECT * FROM orders WHERE employee_id = ? AND date >= ? AND substr(date, 1, 7) = ? AND status <> 'cancelled' ORDER BY date, meal",
      employeeId, fromDate, month,
    ).map(orderRow),
    // 委託給某人代領、尚待取餐的訂單
    byDelegate: (date, delegateId) => many(
      "SELECT * FROM orders WHERE date = ? AND delegate_id = ? AND status = 'booked' ORDER BY meal", date, delegateId,
    ).map(orderRow),
    byDelegateCode: (date, code) => orderRow(one(
      "SELECT * FROM orders WHERE date = ? AND delegate_code = ? AND status <> 'cancelled'", date, code,
    )),
    delegateCodeExists: (code) => Boolean(one('SELECT 1 AS x FROM orders WHERE delegate_code = ?', code)),
    activeFor: (date, employeeId, meal) => orderRow(one(
      "SELECT * FROM orders WHERE date = ? AND employee_id = ? AND meal = ? AND status <> 'cancelled'", date, employeeId, meal,
    )),
    // 日期區間（含頭尾）所有訂單，匯出報表用
    inRange: (from, to) => many('SELECT * FROM orders WHERE date >= ? AND date <= ? ORDER BY date, meal, employee_id', from, to).map(orderRow),
  };

  // ---------- 例外名單 ----------

  const exemptions = {
    has: (date, employeeId) => Boolean(one('SELECT 1 AS x FROM exemptions WHERE date = ? AND employee_id = ?', date, employeeId)),
    set: (date, employeeId, reason) => run(
      'INSERT INTO exemptions(date, employee_id, reason) VALUES (?, ?, ?) ON CONFLICT(date, employee_id) DO UPDATE SET reason = excluded.reason',
      date, employeeId, reason,
    ),
    delete: (date, employeeId) => run('DELETE FROM exemptions WHERE date = ? AND employee_id = ?', date, employeeId),
    forDate: (date) => Object.fromEntries(many('SELECT employee_id, reason FROM exemptions WHERE date = ?', date).map((r) => [r.employee_id, r.reason])),
    all: () => many('SELECT date, employee_id, reason FROM exemptions ORDER BY date, employee_id'),
  };

  // ---------- 操作紀錄 ----------

  const history = {
    add(action, detail, at = new Date().toISOString()) {
      run('INSERT INTO history(at, action, detail) VALUES (?, ?, ?)', at, action, JSON.stringify(detail === undefined ? {} : detail));
      run('DELETE FROM history WHERE id <= (SELECT MAX(id) FROM history) - ?', HISTORY_KEEP);
    },
    audit: (limit = 200) => many(
      "SELECT at, detail FROM history WHERE action = 'admin.request' ORDER BY id DESC LIMIT ?", limit,
    ).map((r) => ({ at: r.at, ...JSON.parse(r.detail) })),
    all: () => many('SELECT at, action, detail FROM history ORDER BY id').map((r) => ({ at: r.at, action: r.action, detail: JSON.parse(r.detail) })),
  };

  // ---------- 維運 ----------

  // 資料庫是否還沒有任何資料（用來判斷是否要從舊的 JSON 檔搬遷）
  function isEmpty() {
    return employees.count() === 0 && admins.count() === 0 && orders.count() === 0;
  }

  // 清空所有資料並回到初始狀態（展示資料用）
  function reset() {
    tx(() => {
      ['bindings', 'orders', 'exemptions', 'menu_items', 'history', 'kiosks', 'admins', 'employees', 'config'].forEach((t) => run(`DELETE FROM ${t}`));
      run("UPDATE meta SET value = '0' WHERE key = 'seq'");
    });
    loadConfig();
  }

  function setSeq(n) {
    run("UPDATE meta SET value = ? WHERE key = 'seq'", String(n));
  }

  // 一致性備份：VACUUM INTO 在伺服器運作中也能取得完整快照（直接複製 .db 檔可能漏掉 WAL 裡的新資料）
  function backup(dest) {
    if (fs.existsSync(dest)) throw new Error(`備份檔已存在：${dest}`);
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    db.exec(`VACUUM INTO '${String(dest).replace(/'/g, "''")}'`);
  }

  function close() {
    cache.clear();
    db.close();
  }

  return {
    filename,
    tx,
    nextId,
    config,
    setConfig,
    employees,
    bindings,
    admins,
    kiosks,
    menus,
    orders,
    exemptions,
    history,
    isEmpty,
    reset,
    setSeq,
    backup,
    close,
    DEFAULT_CONFIG,
  };
}

module.exports = { createStore, DEFAULT_CONFIG };
