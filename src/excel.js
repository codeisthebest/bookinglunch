// Excel 匯出與匯入的「業務層」：決定每份報表有哪些欄位、怎麼對應資料。
// 檔案格式本身（.xlsx 的讀寫）在 xlsx.js。

const { readXlsx, buildXlsx } = require('./xlsx');
const { toTaipeiText, taipeiNow } = require('./time');

// ---------- 匯入：讀成「第一列是標題」的表格列 ----------

const EMPLOYEE_SHEETS = ['員工名單', '員工', 'Employees'];
const MENU_SHEETS = ['菜單', 'Menu'];

function employeeRowsFromXlsx(buffer) {
  return readXlsx(buffer, { prefer: EMPLOYEE_SHEETS }).rows;
}

function menuRowsFromXlsx(buffer) {
  return readXlsx(buffer, { prefer: MENU_SHEETS }).rows;
}

// ---------- 匯出 ----------

const money = { int: true };

function ordersWorkbook(service, from, to) {
  const config = service.getConfig();
  const views = service.ordersInRange(from, to).filter((o) => o.status !== 'cancelled');

  const detailRows = views.map((o) => [
    o.date,
    o.employeeId,
    o.employeeName,
    o.employeeDept,
    o.mealLabel,
    o.itemName,
    o.special ? '★' : '',
    o.price,
    o.price - o.amount,
    o.amount,
    service.STATUS_LABEL[o.status] || o.status,
    o.pickedViaLabel || '',
    o.pickedBy || '',
    o.pickedKiosk || '',
    toTaipeiText(o.pickedAt),
    o.deductionStatus ? service.DEDUCTION_LABEL[o.deductionStatus] : '',
  ]);

  const byDate = new Map();
  views.forEach((o) => {
    const d = byDate.get(o.date) || { total: 0, lunch: 0, dinner: 0, spend: 0, subsidy: 0, pay: 0, picked: 0, unclaimed: 0, manual: 0 };
    d.total += 1;
    d[o.meal] += 1;
    d.spend += o.price;
    d.subsidy += o.price - o.amount;
    d.pay += o.amount;
    if (o.status === 'picked') d.picked += 1;
    if (o.status === 'unclaimed') d.unclaimed += 1;
    if (o.pickedVia === 'manual') d.manual += 1;
    byDate.set(o.date, d);
  });
  const daily = [...byDate.keys()].sort().map((date) => {
    const d = byDate.get(date);
    return [date, d.total, d.lunch, d.dinner, d.spend, d.subsidy, d.pay, d.picked, d.unclaimed, d.manual];
  });
  const sum = (i) => daily.reduce((n, r) => n + r[i], 0);
  if (daily.length > 0) {
    daily.push({ bold: true, cells: ['合計', sum(1), sum(2), sum(3), sum(4), sum(5), sum(6), sum(7), sum(8), sum(9)] });
  }

  return buildXlsx([
    {
      name: '訂單明細',
      columns: [
        { header: '日期', width: 12 }, { header: '員編', width: 10, text: true }, { header: '姓名', width: 10 },
        { header: '部門', width: 18 }, { header: '餐別', width: 8 }, { header: '品項', width: 18 }, { header: '特殊', width: 6 },
        { header: '定價', width: 8, ...money }, { header: `公司補貼`, width: 10, ...money }, { header: '員工自付', width: 10, ...money },
        { header: '狀態', width: 10 }, { header: '取餐方式', width: 18 }, { header: '取餐人', width: 10, text: true },
        { header: '取餐口', width: 12 }, { header: '取餐時間', width: 17 }, { header: '扣款狀態', width: 10 },
      ],
      rows: detailRows,
    },
    {
      name: '每日統計',
      columns: [
        { header: '日期', width: 12 }, { header: '總訂餐數', width: 10, ...money }, { header: '午餐', width: 8, ...money },
        { header: '晚餐', width: 8, ...money }, { header: '總花費', width: 10, ...money }, { header: '公司補貼', width: 10, ...money },
        { header: '員工自付', width: 10, ...money }, { header: '已取餐', width: 8, ...money }, { header: '未取餐', width: 8, ...money },
        { header: '手動輸入取餐', width: 14, ...money },
      ],
      rows: daily,
    },
    {
      name: '說明',
      columns: [{ header: '說明', width: 90 }],
      rows: [
        [`匯出區間：${from} 至 ${to}（台北時間），不含已取消的訂單。`],
        [`公司補貼：每份 ${config.subsidy} 元；員工自付 = 定價 − 公司補貼。`],
        ['取餐方式「手動輸入（未驗證）」表示該筆取餐未經動態取餐碼驗證，建議抽查。'],
        ['員編欄為文字格式，保留前導零。'],
      ],
    },
  ]);
}

// 未取餐扣款清單（給人事）：單日，含合計
function deductionsWorkbook(service, date) {
  const report = service.dayReport(date);
  const rows = report.deductionList.map((o) => [
    o.date, o.employeeId, o.employeeName, o.employeeDept, o.mealLabel, o.itemName, o.amount, service.DEDUCTION_LABEL[o.deductionStatus] || '',
  ]);
  if (rows.length > 0) rows.push({ bold: true, cells: ['合計', '', '', '', '', '', report.deductionTotal, ''] });
  return buildXlsx([
    {
      name: '未取餐扣款清單',
      columns: [
        { header: '日期', width: 12 }, { header: '員編', width: 10, text: true }, { header: '姓名', width: 10 },
        { header: '部門', width: 18 }, { header: '餐別', width: 8 }, { header: '品項', width: 18 },
        { header: '應扣金額', width: 10, ...money }, { header: '扣款狀態', width: 10 },
      ],
      rows,
    },
    {
      name: '說明',
      columns: [{ header: '說明' , width: 90 }],
      rows: [
        [`${date} 未取餐名單。應扣金額 = 員工自付額（定價 − 公司補貼）。`],
        ['例外名單（出差、請假等）已排除。實際扣款需經人事確認後執行，本系統不會直接扣款。'],
      ],
    },
  ]);
}

function employeesWorkbook(service) {
  const rows = service.listEmployees().map((e) => [e.id, e.name, e.dept, e.bound ? '已綁定' : '未綁定', e.hasVerify ? '有' : '']);
  return buildXlsx([
    {
      name: '員工名單',
      columns: [
        { header: '員工編號', width: 12, text: true }, { header: '姓名', width: 12 }, { header: '部門', width: 20 },
        { header: 'LINE 綁定', width: 12 }, { header: '已設驗證碼', width: 12 },
      ],
      rows,
    },
    {
      name: '說明',
      columns: [{ header: '說明', width: 90 }],
      rows: [['驗證碼不會匯出。要更新名單請使用「下載範本」的格式（員工編號、姓名、部門、驗證碼）。']],
    },
  ]);
}

function employeesTemplate() {
  return buildXlsx([
    {
      name: '員工名單',
      columns: [
        { header: '員工編號', width: 12, text: true }, { header: '姓名', width: 12 },
        { header: '部門', width: 20 }, { header: '驗證碼', width: 12, text: true },
      ],
      rows: [
        ['999001', '範例員工（請刪除此列）', '9000 範例部門', ''],
        ['999002', '範例員工二（請刪除此列）', '9000 範例部門', '0615'],
      ],
    },
    {
      name: '說明',
      columns: [{ header: '說明', width: 100 }],
      rows: [
        ['必要欄位：員工編號、姓名。選填：部門（也可改用「部門代號」「部門名稱」兩欄）、驗證碼。'],
        ['員工編號欄請保持「文字」格式。若員編被 Excel 轉成數字（例如 012003 變成 12003），系統會依「員編位數」設定自動補零。'],
        ['相同員編再次匯入會更新姓名與部門。匯入時有問題的列會略過並回報列號，其餘照常匯入。'],
        ['驗證碼：員工首次綁定 LINE 時需多輸入的資料（例如生日月日），可防止他人只憑員編與姓名冒綁；留空則只比對員編與姓名。'],
        ['匯入前請刪除範例列。'],
      ],
    },
  ]);
}

const MENU_COLUMNS = [
  { header: '日期', width: 12, text: true }, { header: '餐別', width: 8 }, { header: '品名', width: 16 },
  { header: '定價', width: 8, ...money }, { header: '主菜', width: 16 }, { header: '配菜', width: 26 },
  { header: '蔬菜／湯品', width: 18 }, { header: '特殊商品', width: 10 },
];

function menuRowsFor(items, service) {
  return items.map((i) => [i.date, service.MEAL_LABEL[i.meal], i.name, i.price, i.main, (i.sides || []).join('、'), i.veg, i.special ? '★' : '']);
}

function menuNotes(leadDays) {
  return [
    ['每列一個品項。必要欄位：日期（YYYY-MM-DD 或 Excel 日期）、餐別（午餐／晚餐）、品名、定價。'],
    ['選填：主菜、配菜（用頓號「、」分隔多個）、蔬菜／湯品、特殊商品（填 ★ 或「是」）。'],
    [`★ 特殊商品須於用餐日前 ${leadDays} 天訂購，不足時系統自動鎖定，不可人工放行。`],
    ['匯入規則：檔案裡出現的每一天，當天菜單會被「整天取代」；沒出現的日期不受影響。有任何一列錯誤時整份都不會匯入，並回報列號。'],
  ];
}

// 匯出某月菜單；同一份檔案就是匯入用的格式，改完可直接再匯入
function menuWorkbook(service, month) {
  const items = service.menuForMonth(month);
  return buildXlsx([
    { name: '菜單', columns: MENU_COLUMNS, rows: menuRowsFor(items, service) },
    { name: '說明', columns: [{ header: '說明', width: 100 }], rows: menuNotes(service.getConfig().specialLeadDays) },
  ]);
}

// 範本：該月已有菜單就帶出來，沒有就放三列範例
function menuTemplate(service, month) {
  const items = service.menuForMonth(month);
  let rows = menuRowsFor(items, service);
  if (rows.length === 0) {
    const day = `${month}-01`;
    rows = [
      [day, '午餐', 'A餐', 70, '照燒雞排', '蔥爆香腸、蘿蔔滷黑輪', '時蔬兩道', ''],
      [day, '午餐', 'B餐', 80, '炒泡麵＋主菜', '', '', '★'],
      [day, '晚餐', '滷肉飯套餐', 60, '滷肉飯', '滷蛋', '燙青菜', ''],
    ];
  }
  return buildXlsx([
    { name: '菜單', columns: MENU_COLUMNS, rows },
    { name: '說明', columns: [{ header: '說明', width: 100 }], rows: menuNotes(service.getConfig().specialLeadDays) },
  ]);
}

function defaultMonth() {
  return taipeiNow().date.slice(0, 7);
}

module.exports = {
  employeeRowsFromXlsx,
  menuRowsFromXlsx,
  ordersWorkbook,
  deductionsWorkbook,
  employeesWorkbook,
  employeesTemplate,
  menuWorkbook,
  menuTemplate,
  defaultMonth,
};
