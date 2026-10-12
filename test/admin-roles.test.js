const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/store');
const { createApp } = require('../src/app');
const { setClock } = require('../src/time');

const DAY = '2026-10-12';

async function start() {
  const { app } = createApp({ store: createStore(null), adminPassword: 'owner-secret' });
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
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* csv */ }
    return { status: res.status, json, text };
  }

  async function login(username, password) {
    const r = await call('POST', '/api/auth/admin', { body: { username, password } });
    return r.json && r.json.token;
  }

  const owner = await login('admin', 'owner-secret');
  // 建立三種角色的帳號
  for (const [username, role] of [['boss2', 'owner'], ['helper', 'operator'], ['viewer1', 'viewer']]) {
    const r = await call('POST', '/api/admin/admins', {
      token: owner,
      body: { username, displayName: username, role, password: 'password123' },
    });
    assert.equal(r.status, 201, `建立 ${username} 失敗：${JSON.stringify(r.json)}`);
  }
  return { server, call, login, owner };
}

test.afterEach(() => setClock(null));

test('初始以 ADMIN_PASSWORD 建立 admin（系統管理員），帳號密碼登入', async () => {
  const { server, call } = await start();
  try {
    assert.equal((await call('POST', '/api/auth/admin', { body: { username: 'admin', password: 'x' } })).status, 401);
    const r = await call('POST', '/api/auth/admin', { body: { password: 'owner-secret' } }); // 省略帳號 = admin
    assert.equal(r.status, 200);
    assert.equal(r.json.admin.role, 'owner');
    assert.ok(r.json.admin.permissions.includes('admins.manage'));
  } finally {
    server.close();
  }
});

test('權限矩陣：每個角色只能做被允許的事', async () => {
  const { server, call, login, owner } = await start();
  try {
    await call('PUT', '/api/admin/clock', { token: owner, body: { now: `${DAY}T08:00` } });
    const tokens = { owner, helper: await login('helper', 'password123'), viewer: await login('viewer1', 'password123') };

    // [方法, 路徑, 請求內容, owner, operator, viewer 預期是否放行]
    const csv = '員工編號,姓名\nE001,甲';
    const matrix = [
      ['GET', `/api/admin/report?date=${DAY}`, undefined, true, true, true],
      ['GET', `/api/admin/orders?date=${DAY}`, undefined, true, true, true],
      ['GET', `/api/admin/menu?date=${DAY}`, undefined, true, true, true],
      ['GET', `/api/admin/deductions.csv?date=${DAY}`, undefined, true, true, false],
      ['PUT', '/api/admin/menu', { date: DAY, items: [{ meal: 'lunch', name: 'x', price: 60 }] }, true, true, false],
      ['PUT', '/api/admin/exemptions', { date: DAY, employeeId: 'E001', reason: 'r' }, true, true, false],
      ['POST', '/api/admin/employees/import', { csv }, true, false, false],
      ['GET', '/api/admin/employees', undefined, true, false, false],
      ['GET', '/api/admin/bindings', undefined, true, false, false],
      ['GET', '/api/admin/config', undefined, true, false, false],
      ['PUT', '/api/admin/config', { orderCutoff: '10:30' }, true, false, false],
      ['PUT', '/api/admin/clock', { now: null }, true, false, false],
      ['GET', '/api/admin/admins', undefined, true, false, false],
      ['GET', '/api/admin/audit', undefined, true, false, false],
    ];
    // 先讓 owner 匯入員工，後續 exemption 才找得到人
    await call('POST', '/api/admin/employees/import', { token: owner, body: { csv } });

    for (const [method, url, body, ownerOk, operatorOk, viewerOk] of matrix) {
      for (const [who, expected] of [['owner', ownerOk], ['helper', operatorOk], ['viewer', viewerOk]]) {
        const r = await call(method, url, { token: tokens[who], body });
        if (expected) {
          assert.ok(r.status < 400, `${who} 應可 ${method} ${url}，實際 ${r.status}：${JSON.stringify(r.json)}`);
        } else {
          assert.equal(r.status, 403, `${who} 不應可 ${method} ${url}，實際 ${r.status}`);
        }
      }
    }
  } finally {
    server.close();
  }
});

test('未登入、員工身分都不能呼叫後台', async () => {
  const { server, call } = await start();
  try {
    assert.equal((await call('GET', '/api/admin/report?date=2026-10-12')).status, 401);
    assert.equal((await call('GET', '/api/admin/admins')).status, 401);
    assert.equal((await call('GET', '/api/admin/report?date=2026-10-12', { token: 'nope' })).status, 401);
  } finally {
    server.close();
  }
});

test('停用帳號與調整角色立即生效，不必等對方重新登入', async () => {
  const { server, call, login, owner } = await start();
  try {
    const helper = await login('helper', 'password123');
    assert.equal((await call('PUT', '/api/admin/menu', { token: helper, body: { date: DAY, items: [] } })).status, 200);

    await call('PUT', '/api/admin/admins/helper', { token: owner, body: { role: 'viewer' } });
    assert.equal((await call('PUT', '/api/admin/menu', { token: helper, body: { date: DAY, items: [] } })).status, 403);

    await call('PUT', '/api/admin/admins/helper', { token: owner, body: { active: false } });
    assert.equal((await call('GET', `/api/admin/report?date=${DAY}`, { token: helper })).status, 401);
    assert.equal(await login('helper', 'password123'), undefined, '停用後不能再登入');
  } finally {
    server.close();
  }
});

test('不能停用或降級自己；系統管理員之間可以互相調整', async () => {
  const { server, call, owner, login } = await start();
  try {
    assert.equal((await call('PUT', '/api/admin/admins/admin', { token: owner, body: { active: false } })).status, 400);
    assert.equal((await call('PUT', '/api/admin/admins/admin', { token: owner, body: { role: 'viewer' } })).status, 400);

    // 另一位 owner 可以降級 admin；被降級的人立刻失去管理權限
    const boss2 = await login('boss2', 'password123');
    assert.equal((await call('PUT', '/api/admin/admins/admin', { token: boss2, body: { role: 'viewer' } })).status, 200);
    assert.equal((await call('GET', '/api/admin/admins', { token: owner })).status, 403);

    // boss2 也能把 admin 升回來
    assert.equal((await call('PUT', '/api/admin/admins/admin', { token: boss2, body: { role: 'owner' } })).status, 200);
    assert.equal((await call('GET', '/api/admin/admins', { token: owner })).status, 200);
  } finally {
    server.close();
  }
});

test('重設密碼會作廢對方既有登入；密碼長度與重複帳號有檢查', async () => {
  const { server, call, login, owner } = await start();
  try {
    const helper = await login('helper', 'password123');
    assert.equal((await call('PUT', '/api/admin/admins/helper', { token: owner, body: { password: 'short' } })).status, 400);
    assert.equal((await call('PUT', '/api/admin/admins/helper', { token: owner, body: { password: 'new-password-1' } })).status, 200);
    assert.equal((await call('GET', `/api/admin/report?date=${DAY}`, { token: helper })).status, 401);
    assert.ok(await login('helper', 'new-password-1'));

    const dup = await call('POST', '/api/admin/admins', {
      token: owner, body: { username: 'helper', role: 'viewer', password: 'password123' },
    });
    assert.equal(dup.status, 409);
    const bad = await call('POST', '/api/admin/admins', {
      token: owner, body: { username: 'Bad Name!', role: 'viewer', password: 'password123' },
    });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test('自己改密碼：需要舊密碼', async () => {
  const { server, call, login } = await start();
  try {
    const viewer = await login('viewer1', 'password123');
    const wrong = await call('POST', '/api/admin/me/password', { token: viewer, body: { oldPassword: 'x', newPassword: 'another-pass-1' } });
    assert.equal(wrong.status, 403);
    const ok = await call('POST', '/api/admin/me/password', { token: viewer, body: { oldPassword: 'password123', newPassword: 'another-pass-1' } });
    assert.equal(ok.status, 200);
    assert.equal(await login('viewer1', 'password123'), undefined);
    assert.ok(await login('viewer1', 'another-pass-1'));
  } finally {
    server.close();
  }
});

test('連續登入失敗 5 次會鎖定該帳號', async () => {
  const { server, call, login } = await start();
  try {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await call('POST', '/api/auth/admin', { body: { username: 'viewer1', password: 'wrong' } })).status, 401);
    }
    const locked = await call('POST', '/api/auth/admin', { body: { username: 'viewer1', password: 'password123' } });
    assert.equal(locked.status, 429);
    assert.ok(await login('helper', 'password123'), '其他帳號不受影響');
  } finally {
    server.close();
  }
});

test('管理員列表不外洩密碼雜湊；操作紀錄記下操作者且不含請求內容', async () => {
  const { server, call, login, owner } = await start();
  try {
    const list = await call('GET', '/api/admin/admins', { token: owner });
    assert.equal(list.json.length, 4);
    assert.ok(!JSON.stringify(list.json).match(/hash|salt|password/i));

    const helper = await login('helper', 'password123');
    const viewer = await login('viewer1', 'password123');
    await call('PUT', '/api/admin/menu', { token: helper, body: { date: DAY, items: [] } });
    const denied = await call('PUT', '/api/admin/menu', { token: viewer, body: { date: DAY, items: [] } });
    assert.equal(denied.status, 403);
    await call('PUT', '/api/admin/admins/viewer1', { token: owner, body: { password: 'super-secret-pass' } });

    const audit = (await call('GET', '/api/admin/audit', { token: owner })).json;
    assert.ok(audit.some((a) => a.actor === 'helper' && a.method === 'PUT' && a.path === '/api/admin/menu'));
    assert.ok(audit.some((a) => a.actor === 'admin' && a.path === '/api/admin/admins/viewer1'));
    assert.ok(!JSON.stringify(audit).includes('super-secret-pass'), '操作紀錄不可含密碼');
    assert.ok(!audit.some((a) => a.actor === 'viewer1'), '被拒絕的請求不記錄');
  } finally {
    server.close();
  }
});
