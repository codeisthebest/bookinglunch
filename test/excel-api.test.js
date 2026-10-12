const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../src/store');
const { createApp } = require('../src/app');
const { readXlsx, XLSX_MIME } = require('../src/xlsx');
const { setClock } = require('../src/time');

const DAY = '2026-10-12';
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

async function start() {
  const { app } = createApp({ store: createStore(null), adminPassword: 'pw' });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function raw(method, url, { token, body, type } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (type) headers['Content-Type'] = type;
    const res = await fetch(base + url, { method, headers, body });
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buffer };
  }
  async function json(method, url, { token, body } = {}) {
    const r = await raw(method, url, { token, body: body ? JSON.stringify(body) : undefined, type: body ? 'application/json' : undefined });
    let data = null;
    try { data = JSON.parse(r.buffer.toString('utf8')); } catch (_) { /* binary */ }
    return { status: r.status, json: data };
  }
  async function login(username, password) {
    return (await json('POST', '/api/auth/admin', { body: { username, password } })).json.token;
  }

  const owner = await login('admin', 'pw');
  for (const [username, role] of [['helper', 'operator'], ['viewer1', 'viewer']]) {
    await json('POST', '/api/admin/admins', { token: owner, body: { username, role, password: 'password123' } });
  }
  const tokens = { owner, operator: await login('helper', 'password123'), viewer: await login('viewer1', 'password123') };

  await json('POST', '/api/admin/employees/import', { token: owner, body: { csv: '員工編號,姓名,部門\n012003,吳宗文,2000 總經理室\nE002,乙,研發' } });
  await json('PUT', '/api/admin/menu', { token: owner, body: { date: DAY, items: [{ meal: 'lunch', name: 'A餐', price: 70, main: '雞排' }] } });
  return { server, raw, json, tokens };
}

test.afterEach(() => setClock(null));

test('下載 .xlsx：Content-Type、中文檔名、可被讀回', async () => {
  const { server, raw, tokens } = await start();
  try {
    setClock(`${DAY}T08:00`);
    const res = await raw('GET', `/api/admin/export/orders.xlsx?from=${DAY}&to=${DAY}`, { token: tokens.owner });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), XLSX_MIME);
    const disposition = res.headers.get('content-disposition');
    assert.match(disposition, /^attachment; filename="orders_2026-10-12_2026-10-12\.xlsx"; filename\*=UTF-8''/);
    assert.equal(decodeURIComponent(disposition.split("UTF-8''")[1]), '訂單明細_2026-10-12_2026-10-12.xlsx');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(readXlsx(res.buffer, { sheet: '每日統計' }).rows[0].slice(0, 2), ['日期', '總訂餐數']);

    const menu = await raw('GET', '/api/admin/export/menu.xlsx?month=2026-10', { token: tokens.viewer });
    assert.equal(readXlsx(menu.buffer, { sheet: '菜單' }).rows[1][2], 'A餐');
    const bad = await raw('GET', '/api/admin/export/orders.xlsx?from=2026-10-12&to=2026-10-01', { token: tokens.owner });
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.buffer.toString()).error, /不可晚於/);
  } finally {
    server.close();
  }
});

test('上傳員工名單 .xlsx：不論 Content-Type 都能收；補零與逐列錯誤回報', async () => {
  const { server, raw, json, tokens } = await start();
  try {
    for (const type of ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', undefined]) {
      const res = await raw('POST', '/api/admin/employees/import-xlsx', { token: tokens.owner, body: fixture('roster-openpyxl.xlsx'), type });
      const body = JSON.parse(res.buffer.toString());
      assert.equal(res.status, 200, `Content-Type=${type}：${res.buffer}`);
      assert.equal(body.padded, 2);
      assert.deepEqual(body.errors, [{ line: 6, message: '員工編號或姓名為空' }]);
    }
    const list = (await json('GET', '/api/admin/employees', { token: tokens.owner })).json;
    assert.ok(list.some((e) => e.id === '010412' && e.name === '黃文杰'));
    assert.ok(list.some((e) => e.id === '012003' && e.name === '吳宗文'), '原有員工被更新（相同員編）');
    assert.equal(list.filter((e) => e.id === '012003').length, 1);
  } finally {
    server.close();
  }
});

test('上傳錯誤的檔案：清楚的錯誤訊息，不會 500', async () => {
  const { server, raw, json, tokens } = await start();
  try {
    const post = (body, type) => raw('POST', '/api/admin/employees/import-xlsx', { token: tokens.owner, body, type });
    const msg = (r) => JSON.parse(r.buffer.toString()).error;

    let r = await post(undefined);
    assert.equal(r.status, 400);
    assert.match(msg(r), /沒有收到檔案/);

    r = await post(Buffer.from('員工編號,姓名\nE9,甲\n'), 'text/csv');
    assert.equal(r.status, 400);
    assert.match(msg(r), /不是有效的 \.xlsx/);

    r = await post(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
    assert.equal(r.status, 400);
    assert.match(msg(r), /舊版 \.xls/);

    r = await post(Buffer.alloc(11 * 1024 * 1024, 0x50), 'application/octet-stream');
    assert.equal(r.status, 413);
    assert.match(msg(r), /過大/);

    // 用 JSON 內容類型送，被 JSON 解析器收走，不是檔案
    r = await raw('POST', '/api/admin/employees/import-xlsx', { token: tokens.owner, body: JSON.stringify({ a: 1 }), type: 'application/json' });
    assert.equal(r.status, 400);

    // 失敗後伺服器仍正常
    assert.equal((await json('GET', '/healthz')).status, 200);
  } finally {
    server.close();
  }
});

test('菜單匯入：成功、整份驗證失敗回報逐列細節且不改動資料、CSV 路徑', async () => {
  const { server, raw, json, tokens } = await start();
  try {
    const ok = await raw('POST', '/api/admin/menu/import-xlsx', { token: tokens.operator, body: fixture('menu-openpyxl.xlsx'), type: 'application/octet-stream' });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.buffer.toString()).perDate.map((d) => d.date), ['2026-10-14', '2026-10-15']);
    const menu = (await json('GET', '/api/admin/menu?date=2026-10-14', { token: tokens.viewer })).json;
    assert.equal(menu.length, 3);

    const { buildXlsx } = require('../src/xlsx');
    const bad = buildXlsx([{ name: '菜單', columns: [{ header: '日期' }, { header: '餐別' }, { header: '品名' }, { header: '定價' }], rows: [['2026-10-20', '午餐', 'ok', 70], ['不是日期', '午餐', 'x', 70], ['2026-10-20', '宵夜', 'y', 0]] }]);
    const res = await raw('POST', '/api/admin/menu/import-xlsx', { token: tokens.owner, body: bad, type: 'application/octet-stream' });
    const body = JSON.parse(res.buffer.toString());
    assert.equal(res.status, 400);
    assert.match(body.error, /2 列需要修正/);
    assert.deepEqual(body.details.map((d) => d.line), [3, 4]);
    assert.equal((await json('GET', '/api/admin/menu?date=2026-10-20', { token: tokens.owner })).json.length, 0, '一筆都沒匯入');

    const csv = await json('POST', '/api/admin/menu/import', { token: tokens.operator, body: { csv: '日期,餐別,品名,定價\n2026-10-21,晚餐,滷肉飯,60' } });
    assert.equal(csv.status, 200);
    assert.equal(csv.json.items, 1);
  } finally {
    server.close();
  }
});

test('權限矩陣：每個新端點只有被允許的角色能用', async () => {
  const { server, raw, tokens } = await start();
  try {
    setClock(`${DAY}T08:00`);
    const xlsx = fixture('menu-openpyxl.xlsx');
    const roster = fixture('roster-openpyxl.xlsx');
    // [方法, 路徑, 內容, owner, operator, viewer 是否放行]
    const matrix = [
      ['GET', `/api/admin/export/orders.xlsx?from=${DAY}&to=${DAY}`, undefined, true, true, false],
      ['GET', `/api/admin/export/deductions.xlsx?date=${DAY}`, undefined, true, true, false],
      ['GET', '/api/admin/export/employees.xlsx', undefined, true, false, false],
      ['GET', '/api/admin/export/menu.xlsx?month=2026-10', undefined, true, true, true],
      ['GET', '/api/admin/templates/employees.xlsx', undefined, true, false, false],
      ['GET', '/api/admin/templates/menu.xlsx?month=2026-10', undefined, true, true, false],
      ['POST', '/api/admin/employees/import-xlsx', roster, true, false, false],
      ['POST', '/api/admin/menu/import-xlsx', xlsx, true, true, false],
    ];
    for (const [method, url, body, ownerOk, operatorOk, viewerOk] of matrix) {
      for (const [who, expected] of [['owner', ownerOk], ['operator', operatorOk], ['viewer', viewerOk]]) {
        const r = await raw(method, url, { token: tokens[who], body, type: body ? 'application/octet-stream' : undefined });
        if (expected) assert.ok(r.status < 400, `${who} 應可 ${method} ${url}，實際 ${r.status}：${r.buffer.toString().slice(0, 100)}`);
        else assert.equal(r.status, 403, `${who} 不應可 ${method} ${url}，實際 ${r.status}`);
      }
      const anonymous = await raw(method, url, { body, type: body ? 'application/octet-stream' : undefined });
      assert.equal(anonymous.status, 401, `未登入不可 ${method} ${url}`);
    }
  } finally {
    server.close();
  }
});

test('操作紀錄：匯入記下操作者與路徑，不含檔案內容', async () => {
  const { server, raw, json, tokens } = await start();
  try {
    await raw('POST', '/api/admin/employees/import-xlsx', { token: tokens.owner, body: fixture('roster-openpyxl.xlsx'), type: 'application/octet-stream' });
    const audit = (await json('GET', '/api/admin/audit', { token: tokens.owner })).json;
    assert.ok(audit.some((a) => a.actor === 'admin' && a.method === 'POST' && a.path === '/api/admin/employees/import-xlsx'));
    assert.ok(!JSON.stringify(audit).includes('吳宗文'));
  } finally {
    server.close();
  }
});
