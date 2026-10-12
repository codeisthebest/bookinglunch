const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { zipSync, strToU8 } = require('fflate');
const { createStore } = require('../src/store');
const { createService, AppError } = require('../src/service');
const { createTokenService } = require('../src/pickup-token');
const { readXlsx, buildXlsx, serialToText, MAX_FILE_BYTES } = require('../src/xlsx');
const excel = require('../src/excel');
const { toCsv } = require('../src/csv');
const { setClock } = require('../src/time');

const DAY = '2026-10-12';
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
// 一列最後面的空白儲存格不會出現在讀回的陣列裡，比對前先補齊長度
const pad = (row, n) => Array.from({ length: n }, (_, i) => (row[i] === undefined ? null : row[i]));

function expectError(fn, message) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof AppError, `應為 AppError，實際：${err && err.stack}`);
    assert.equal(err.status, 400);
    if (message) assert.match(err.message, message);
    return true;
  });
}

test.afterEach(() => setClock(null));

// ---------- 寫出再讀回 ----------

test('寫出再讀回：文字、數字、前導零、中文、特殊字元都不變', () => {
  const buf = buildXlsx([{
    name: '資料',
    columns: [{ header: '員編', text: true }, { header: '姓名' }, { header: '金額', int: true }, { header: '備註' }],
    rows: [
      ['012003', '吳宗文', 1234567, '=1+1'],
      ['8456', '蕭 <茂全> & "引號" \'單\'', 37, '@SUM(A1)'],
      ['E001', '含換行\nline2', null, '+cmd|calc'],
      ['', '', '', ''],
      ['009513', '😀 emoji', 0, '前後空白  '],
      { bold: true, cells: ['合計', '', '', 1234604] },
    ],
  }]);
  const { rows, sheetName } = readXlsx(buf);
  assert.equal(sheetName, '資料');
  assert.deepEqual(rows[0], ['員編', '姓名', '金額', '備註']);
  assert.deepEqual(rows[1], ['012003', '吳宗文', 1234567, '=1+1']);
  assert.deepEqual(rows[2], ['8456', '蕭 <茂全> & "引號" \'單\'', 37, '@SUM(A1)']);
  assert.equal(rows[3][1], '含換行\nline2');
  assert.equal(rows[3][2], null);
  assert.equal(rows[5][1], '😀 emoji');
  assert.equal(rows[5][3], '前後空白  ', '字串前後空白保留');
  assert.deepEqual(rows[6], ['合計', null, null, 1234604]);
});

test('寫出：多個工作表、工作表名稱清理與去重、空工作表', () => {
  const buf = buildXlsx([
    { name: '訂單/明細:*?[1]', columns: [{ header: 'A' }], rows: [['x']] },
    { name: '訂單 明細 1', columns: [{ header: 'B' }], rows: [] },
    { name: '訂單 明細 1', columns: [{ header: 'C' }], rows: [['y']] },
    { name: 'x'.repeat(50), columns: [{ header: 'D' }], rows: [] },
  ]);
  const first = readXlsx(buf);
  assert.equal(first.sheetNames.length, 4);
  assert.ok(first.sheetNames.every((n) => n.length <= 31));
  assert.equal(new Set(first.sheetNames.map((n) => n.toLowerCase())).size, 4, '名稱不重複');
  assert.ok(!/[\[\]:*?/\\]/.test(first.sheetNames.join('')));
  const third = readXlsx(buf, { sheet: first.sheetNames[2] });
  assert.deepEqual(third.rows, [['C'], ['y']]);
  assert.deepEqual(readXlsx(buf, { sheet: first.sheetNames[1] }).rows, [['B']]);
  expectError(() => readXlsx(buf, { sheet: '不存在' }), /找不到工作表/);
});

test('寫出：大量資料可正常讀回', () => {
  const rows = Array.from({ length: 5000 }, (_, i) => [String(i).padStart(6, '0'), `員工${i}`, i]);
  const buf = buildXlsx([{ name: 's', columns: [{ header: 'id', text: true }, { header: 'n' }, { header: 'v', int: true }], rows }]);
  const back = readXlsx(buf).rows;
  assert.equal(back.length, 5001);
  assert.deepEqual(back[5000], ['004999', '員工4999', 4999]);
});

test('Excel 日期序號轉換（1900 與 1904 系統）', () => {
  assert.equal(serialToText(46307, false), '2026-10-12');
  assert.equal(serialToText(46307.395833, false), '2026-10-12 09:30');
  assert.equal(serialToText(0.5, false), '12:00');
  assert.equal(serialToText(46307 - 1462, true), '2026-10-12');
});

// ---------- 讀取真實工具產生的檔案（openpyxl） ----------

test('讀取 openpyxl 檔案：中文字元參照、隱藏工作表、日期、數字員編、格式化文字、列號對齊', () => {
  const { sheetName, sheetNames, rows } = readXlsx(fixture('roster-openpyxl.xlsx'), { prefer: ['員工名單'] });
  assert.equal(sheetName, '員工名單');
  assert.deepEqual(sheetNames, ['隱藏的草稿', '員工名單']);
  assert.deepEqual(rows[0], ['部門代號', '員工代號', '姓名', '驗證碼', '備註']);
  assert.deepEqual(rows[1].slice(0, 4), ['2000', '012003', '吳宗文', '0615']);
  assert.equal(rows[1][4], '2026-10-12', '日期格式的數字轉成日期文字');
  assert.equal(rows[2][1], 10412, '數字格式的員編維持數字');
  assert.equal(rows[2][4], '2026-10-12 09:30');
  assert.equal(rows[3][4], true);
  assert.deepEqual(rows[4], [], '空白列保留位置，列號才對得上 Excel');
  assert.equal(rows[6][2], '游巽傑', '格式化文字（多段）合併');
  // 沒指定時，預設跳過隱藏的工作表
  assert.equal(readXlsx(fixture('roster-openpyxl.xlsx')).sheetName, '員工名單');
});

test('匯入 openpyxl 員工名單：補零、略過空白列、錯誤列號與 Excel 一致', () => {
  const service = createService(createStore(null));
  const result = service.importEmployeeRows(excel.employeeRowsFromXlsx(fixture('roster-openpyxl.xlsx')));
  assert.equal(result.created, 5);
  assert.equal(result.padded, 2, '10412 與 11591 被補零');
  assert.deepEqual(result.errors, [{ line: 6, message: '員工編號或姓名為空' }], '第 6 列姓名空白');
  const byId = Object.fromEntries(service.listEmployees().map((e) => [e.id, e]));
  assert.equal(byId['010412'].name, '黃文杰');
  assert.equal(byId['011591'].dept, '2100', '只有部門代號時用代號');
  assert.equal(byId['010683'].name, '楊欣怡', '員編前後空白去除');
  assert.equal(byId['012003'].hasVerify, true);
  assert.equal(byId['009513'].name, '游巽傑');
});

test('交叉驗證：openpyxl 能讀我們寫出的檔案（員編為文字、公式字串不被執行）', (t) => {
  const check = spawnSync('python3', ['-c', 'import openpyxl'], { encoding: 'utf8' });
  if (check.status !== 0) return t.skip('沒有 python3 + openpyxl，略過交叉驗證');
  const buf = buildXlsx([{ name: '訂單', columns: [{ header: '員編', text: true }, { header: '備註' }, { header: '金額', int: true }], rows: [['012003', '=1+1', 1234], ['8456', '@SUM(A1)', 5]] }]);
  const file = path.join(require('node:os').tmpdir(), `bl-xcheck-${process.pid}.xlsx`);
  fs.writeFileSync(file, buf);
  try {
    const py = spawnSync('python3', ['-c', `
import openpyxl, json, sys
ws = openpyxl.load_workbook(sys.argv[1])['訂單']
print(json.dumps({'a2': [ws['A2'].value, ws['A2'].data_type, ws['A2'].number_format], 'b2': [ws['B2'].value, ws['B2'].data_type], 'b3': [ws['B3'].value, ws['B3'].data_type], 'c2': [ws['C2'].value, ws['C2'].number_format], 'freeze': ws.freeze_panes}))
`, file], { encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
    const out = JSON.parse(py.stdout);
    assert.deepEqual(out.a2, ['012003', 's', '@']);
    assert.deepEqual(out.b2, ['=1+1', 's'], '以 = 開頭的內容是字串，不是公式');
    assert.deepEqual(out.b3, ['@SUM(A1)', 's']);
    assert.deepEqual(out.c2, [1234, '#,##0']);
    assert.equal(out.freeze, 'A2');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// ---------- 惡意或損毀的檔案 ----------

function craft({ sheetXml, workbookXml, extra = {} } = {}) {
  return Buffer.from(zipSync({
    'xl/workbook.xml': strToU8(workbookXml || '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml || '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row></sheetData></worksheet>'),
    ...extra,
  }));
}

test('檔案防護：不是 zip、舊版 .xls、空檔、損毀、型別錯誤', () => {
  assert.deepEqual(readXlsx(craft()).rows, [['ok']], '手工組出的最小檔案可讀（基準）');
  expectError(() => readXlsx(Buffer.from('員編,姓名\nE001,甲\n')), /不是有效的 \.xlsx/);
  expectError(() => readXlsx(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), /舊版 \.xls/);
  expectError(() => readXlsx(Buffer.alloc(0)), /空的/);
  expectError(() => readXlsx(craft().subarray(0, 60)), /無法解開|損毀/);
  expectError(() => readXlsx('not a buffer'), /沒有收到檔案/);
  expectError(() => readXlsx(Buffer.from(zipSync({ 'hello.txt': strToU8('x') }))), /不是有效的 Excel/);
  expectError(() => readXlsx(Buffer.alloc(MAX_FILE_BYTES + 1, 0x50)), /過大/);
  expectError(() => readXlsx(craft({ sheetXml: '<worksheet><sheetData><row r="1"><c r="A1"' })), /損毀|無法解析|ok/);
});

test('檔案防護：含 DOCTYPE／ENTITY 的 XML 一律拒絕（防實體膨脹）', () => {
  const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&b;</t></is></c></row></sheetData></worksheet>';
  expectError(() => readXlsx(craft({ sheetXml: bomb })), /不安全/);
  const wbBomb = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><workbook/>';
  expectError(() => readXlsx(craft({ workbookXml: wbBomb })), /不安全/);
});

test('檔案防護：解壓縮後過大的內容被拒絕（防 zip 炸彈），列數過多也被拒絕', () => {
  const huge = craft({ extra: { 'xl/sharedStrings.xml': new Uint8Array(41 * 1024 * 1024) } });
  assert.ok(huge.length < MAX_FILE_BYTES, '壓縮後很小，必須靠解壓縮後大小檢查擋下');
  expectError(() => readXlsx(huge), /過大/);
  expectError(() => readXlsx(craft({ sheetXml: '<worksheet><sheetData><row r="999999"><c r="A999999"><v>1</v></c></row></sheetData></worksheet>' })), /列數過多/);
});

test('讀取：行內字串、共用字串索引超出範圍、錯誤值、缺少儲存格位置的寬鬆處理', () => {
  const sheetXml = '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>5</v></c><c r="C1" t="e"><v>#DIV/0!</v></c><c r="D1" t="b"><v>1</v></c></row>'
    + '<row><c t="inlineStr"><is><r><t>多</t></r><r><t>段</t></r></is></c><c><v>7</v></c></row>'
    + '<row r="4"><c r="B4" t="str"><v>公式結果</v></c></row></worksheet>';
  const { rows } = readXlsx(craft({ sheetXml }));
  assert.deepEqual(rows[0], ['', null, null, true]);
  assert.deepEqual(rows[1], ['多段', 7]);
  assert.deepEqual(rows[2], []);
  assert.deepEqual(rows[3], [null, '公式結果']);
});

// ---------- 菜單匯入 ----------

test('匯入 openpyxl 菜單：Excel 日期、斜線日期、$ 價格、英文餐別、頓號與逗號配菜、★／是／否', () => {
  const service = createService(createStore(null));
  const result = service.importMenuRows(excel.menuRowsFromXlsx(fixture('menu-openpyxl.xlsx')));
  assert.deepEqual(result, { dates: 2, items: 4, perDate: [{ date: '2026-10-14', count: 3 }, { date: '2026-10-15', count: 1 }] });
  const d14 = service.getMenu('2026-10-14');
  assert.deepEqual(d14.map((i) => [i.meal, i.name, i.price, i.special]), [
    ['lunch', '素食 A餐', 60, false], ['lunch', 'B餐', 80, true], ['dinner', '滷肉飯套餐', 60, false],
  ]);
  assert.deepEqual(d14[0].sides, ['炒三色豆', '焗汁洋芋']);
  assert.equal(d14[0].veg, '營養青菜、時蔬兩道');
  assert.deepEqual(d14[2].sides, ['滷蛋', '燙青菜'], '逗號也能分隔');
  assert.equal(service.getMenu('2026-10-15')[0].special, true, '「是」視為特殊商品');
});

test('菜單匯入：整天取代；沒出現的日期不受影響', () => {
  const service = createService(createStore(null));
  service.setMenu('2026-10-14', [{ meal: 'lunch', name: '舊品項', price: 50 }]);
  service.setMenu('2026-10-20', [{ meal: 'lunch', name: '不動', price: 50 }]);
  service.importMenuRows([['日期', '餐別', '品名', '定價'], ['2026-10-14', '午餐', '新品項', 70]]);
  assert.deepEqual(service.getMenu('2026-10-14').map((i) => i.name), ['新品項']);
  assert.deepEqual(service.getMenu('2026-10-20').map((i) => i.name), ['不動']);
});

test('菜單匯入：任何一列有錯就整份不匯入，並回報每一列的問題', () => {
  const service = createService(createStore(null));
  service.setMenu('2026-10-14', [{ meal: 'lunch', name: '原本的', price: 50 }]);
  let caught;
  try {
    service.importMenuRows([
      ['日期', '餐別', '品名', '定價', '特殊商品'],
      ['2026-10-14', '午餐', '好的一列', 70],
      ['2026-13-40', '午餐', 'X', 70],            // 第 3 列：日期錯
      ['2026-10-15', '早餐', 'Y', 70],             // 第 4 列：餐別錯
      ['2026-10-15', '午餐', '', 'abc'],           // 第 5 列：品名空、價格錯
      ['2026-10-16', '午餐', '重複', 60],
      ['2026-10-16', '午餐', '重複', 60],           // 第 7 列：同日重複
    ]);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof AppError);
  assert.equal(caught.status, 400);
  assert.deepEqual(caught.details.map((d) => d.line), [3, 4, 5, 7]);
  assert.match(caught.details[2].message, /品名不可為空.*定價需為正整數/);
  assert.deepEqual(service.getMenu('2026-10-14').map((i) => i.name), ['原本的'], '沒有任何變動');
  assert.equal(service.getMenu('2026-10-16').length, 0);
});

test('菜單匯入：缺少必要欄位、沒有資料、CSV 路徑', () => {
  const service = createService(createStore(null));
  expectError(() => service.importMenuRows([['日期', '品名'], ['2026-10-14', 'A']]), /缺少必要欄位.*餐別.*定價/);
  expectError(() => service.importMenuRows([['日期', '餐別', '品名', '定價']]), /至少需要/);
  expectError(() => service.importMenuRows([['日期', '餐別', '品名', '定價'], [null, null, null, null]]), /沒有可匯入/);
  const csv = '日期,餐別,品名,定價,配菜,特殊商品\n2026-10-14,午餐,A餐,70,"香腸、黑輪",\n2026-10-14,午餐,B餐,80,,★';
  assert.equal(service.importMenuCsv(csv).items, 2);
  assert.equal(service.getMenu('2026-10-14')[1].special, true);
});

// ---------- 匯出內容 ----------

function setup() {
  const store = createStore(null);
  const tokens = createTokenService({ secret: 'k' });
  const service = createService(store, { tokens });
  service.importEmployees('員工編號,姓名,部門\n12003,吳宗文,2000 總經理室\nE002,乙,研發\nE003,丙,業務\nE004,丁,財務');
  service.setMenu(DAY, [
    { meal: 'lunch', name: 'A餐', price: 70, main: '雞排', sides: '香腸、黑輪', veg: '時蔬' },
    { meal: 'lunch', name: 'B餐', price: 80, special: true },
    { meal: 'dinner', name: '滷肉飯', price: 60 },
  ]);
  setClock(`${DAY}T08:00`);
  const id = (name) => service.getMenu(DAY).find((i) => i.name === name).id;
  return { store, service, tokens, id };
}

test('匯出訂單明細：欄位、員編保留前導零、不含已取消、統計與合計正確、取餐方式與時間', () => {
  const { service, tokens, id } = setup();
  service.updateConfig({ specialLeadDays: 0 });
  const o1 = service.placeOrder('012003', id('A餐')); // 70 → 自付 37
  const o2 = service.placeOrder('E002', id('B餐')); // 80 → 47
  const o3 = service.placeOrder('E003', id('A餐'));
  service.placeOrder('E004', id('滷肉飯')); // 60 → 27，晚餐
  service.cancelOrder('E003', o3.id);
  setClock(`${DAY}T12:00`);
  const t = service.pickupLookup(tokens.issue('012003').token, { kioskId: 'KIOSK-01' });
  service.pickupConfirm({ orderId: o1.id, ticket: t.ticket }, { kioskId: 'KIOSK-01' });
  service.pickupConfirm({ orderId: o2.id, employeeId: 'E002' }, { kioskId: 'KIOSK-01' });
  setClock(`${DAY}T14:00`); // 午餐已過期，但 E004 的是晚餐

  const { rows } = readXlsx(excel.ordersWorkbook(service, DAY, DAY), { sheet: '訂單明細' });
  assert.equal(rows.length, 4, '標題 + 3 筆（已取消的不列）');
  const header = rows[0];
  const by = (row, name) => row[header.indexOf(name)];
  const r1 = rows.find((r) => by(r, '員編') === '012003');
  assert.ok(r1, '員編為文字，保留前導零');
  assert.equal(by(r1, '姓名'), '吳宗文');
  assert.equal(by(r1, '部門'), '2000 總經理室');
  assert.equal(by(r1, '定價'), 70);
  assert.equal(by(r1, '公司補貼'), 33);
  assert.equal(by(r1, '員工自付'), 37);
  assert.equal(by(r1, '狀態'), '已取餐');
  assert.equal(by(r1, '取餐方式'), '動態碼');
  assert.equal(by(r1, '取餐口'), 'KIOSK-01');
  assert.match(by(r1, '取餐時間'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const r2 = rows.find((r) => by(r, '員編') === 'E002');
  assert.equal(by(r2, '取餐方式'), '手動輸入（未驗證）');
  assert.equal(by(r2, '特殊'), '★');
  const r4 = rows.find((r) => by(r, '員編') === 'E004');
  assert.equal(by(r4, '狀態'), '待取餐');
  assert.ok(!rows.some((r) => by(r, '員編') === 'E003'));

  const daily = readXlsx(excel.ordersWorkbook(service, DAY, DAY), { sheet: '每日統計' }).rows;
  assert.deepEqual(daily[0], ['日期', '總訂餐數', '午餐', '晚餐', '總花費', '公司補貼', '員工自付', '已取餐', '未取餐', '手動輸入取餐']);
  assert.deepEqual(daily[1], [DAY, 3, 2, 1, 210, 99, 111, 2, 0, 1]);
  assert.deepEqual(daily[2], ['合計', 3, 2, 1, 210, 99, 111, 2, 0, 1]);
});

test('匯出訂單明細：區間檢查', () => {
  const { service } = setup();
  expectError(() => excel.ordersWorkbook(service, '2026-10-12', '2026-10-01'), /不可晚於/);
  expectError(() => excel.ordersWorkbook(service, '2025-01-01', '2026-10-01'), /最長一年/);
  expectError(() => excel.ordersWorkbook(service, 'abc', '2026-10-01'), /日期格式/);
  const empty = readXlsx(excel.ordersWorkbook(service, DAY, DAY), { sheet: '每日統計' }).rows;
  assert.equal(empty.length, 1, '沒有訂單時只有標題列');
});

test('匯出扣款清單：只含未取餐、排除例外名單、有合計', () => {
  const { service, id } = setup();
  service.updateConfig({ specialLeadDays: 0 });
  service.placeOrder('012003', id('A餐'));
  service.placeOrder('E002', id('B餐'));
  service.placeOrder('E003', id('A餐'));
  service.setExemption(DAY, 'E003', '出差');
  setClock(`${DAY}T13:30`);

  const { rows } = readXlsx(excel.deductionsWorkbook(service, DAY), { sheet: '未取餐扣款清單' });
  assert.deepEqual(rows[0], ['日期', '員編', '姓名', '部門', '餐別', '品項', '應扣金額', '扣款狀態']);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.slice(1, 3).map((r) => r[1]).sort(), ['012003', 'E002']);
  assert.ok(rows.slice(1, 3).every((r) => r[7] === '待處理'));
  assert.deepEqual(pad(rows[3], 8), ['合計', null, null, null, null, null, 84, null]); // 37 + 47
  service.setDeductionStatus(service.dayOrders(DAY).find((o) => o.employeeId === 'E002').id, 'sent_to_hr');
  const again = readXlsx(excel.deductionsWorkbook(service, DAY), { sheet: '未取餐扣款清單' }).rows;
  assert.equal(again.find((r) => r[1] === 'E002')[7], '已送人事');
});

test('匯出員工名單：員編為文字、不含驗證碼本身', () => {
  const { service } = setup();
  service.importEmployees('員工編號,姓名,驗證碼\nE777,神祕人,SECRET-9876');
  service.bindEmployee({ lineUserId: 'U1', displayName: 'x', employeeId: '12003', name: '吳宗文' });
  const buf = excel.employeesWorkbook(service);
  const { rows } = readXlsx(buf, { sheet: '員工名單' });
  assert.deepEqual(rows[0], ['員工編號', '姓名', '部門', 'LINE 綁定', '已設驗證碼']);
  const r = rows.find((x) => x[0] === '012003');
  assert.deepEqual(pad(r, 5), ['012003', '吳宗文', '2000 總經理室', '已綁定', null]);
  assert.equal(rows.find((x) => x[0] === 'E777')[4], '有');
  assert.ok(!JSON.stringify(readXlsx(buf).rows).includes('SECRET-9876'));
  // 整個壓縮檔裡也找不到（含說明工作表）
  assert.ok(!buf.toString('latin1').includes('SECRET-9876'));
});

test('範本可直接匯入；匯出的月菜單改完可再匯入（來回一致）', () => {
  const { service } = setup();
  const empService = createService(createStore(null));
  const r = empService.importEmployeeRows(excel.employeeRowsFromXlsx(excel.employeesTemplate()));
  assert.equal(r.created, 2, '範本的範例列是有效資料（說明要求使用者匯入前刪除）');

  const menuBuf = excel.menuWorkbook(service, '2026-10');
  const { rows } = readXlsx(menuBuf, { sheet: '菜單' });
  assert.deepEqual(rows[0], ['日期', '餐別', '品名', '定價', '主菜', '配菜', '蔬菜／湯品', '特殊商品']);
  assert.deepEqual(pad(rows[1], 8), [DAY, '午餐', 'A餐', 70, '雞排', '香腸、黑輪', '時蔬', null]);
  assert.equal(rows[2][7], '★');

  const fresh = createService(createStore(null));
  fresh.importMenuRows(excel.menuRowsFromXlsx(menuBuf));
  const strip = (items) => items.map(({ id: _id, ...rest }) => rest);
  assert.deepEqual(strip(fresh.getMenu(DAY)), strip(service.getMenu(DAY)));

  // 該月沒有菜單時，範本放三列範例，且格式是可匯入的
  const tpl = excel.menuTemplate(createService(createStore(null)), '2026-11');
  const sample = createService(createStore(null));
  assert.equal(sample.importMenuRows(excel.menuRowsFromXlsx(tpl)).items, 3);
});

test('CSV 匯出：以 = + - @ 開頭的文字會加單引號防止被當成公式；數字與一般文字不變', () => {
  const csv = toCsv([['=HYPERLINK("x")', '+1', '-2', '@a', '012003', '一般', -5, 12, null, 'a,b']]);
  assert.equal(csv, `"'=HYPERLINK(""x"")",'+1,'-2,'@a,012003,一般,-5,12,,"a,b"`);
});
