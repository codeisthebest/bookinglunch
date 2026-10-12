const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/store');
const { createApp } = require('../src/app');
const { AppError } = require('../src/service');

// 假的 LINE 驗證：idToken 形如 "tok-<userId>"，"bad" 代表驗證失敗
function fakeVerifier(idToken) {
  if (!idToken.startsWith('tok-')) return Promise.reject(new AppError(401, 'LINE 登入驗證失敗，請重新開啟頁面'));
  const sub = idToken.slice(4);
  return Promise.resolve({ sub, name: `LINE-${sub}` });
}

async function start(mode = 'line') {
  const { app } = createApp({
    store: createStore(null),
    adminPassword: 'pw',
    auth: mode === 'line'
      ? { mode: 'line', lineChannelId: 'ch', liffId: '1234-abcd', verifyIdToken: fakeVerifier }
      : { mode: 'mock' },
  });
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
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  const admin = (await call('POST', '/api/auth/admin', { body: { password: 'pw' } })).json.token;
  await call('POST', '/api/admin/employees/import', {
    token: admin,
    body: { csv: '員工編號,姓名,部門,驗證碼\nE001,王小明,行政,\nE002,李美惠,研發,0615' },
  });
  return { server, call, admin };
}

test('LINE 模式：設定可供前端讀取，且模擬登入被關閉', async () => {
  const { server, call } = await start();
  try {
    const config = await call('GET', '/api/config');
    assert.deepEqual(config.json, { authMode: 'line', liffId: '1234-abcd' });
    const mock = await call('POST', '/api/auth/employee', { body: { employeeId: 'E001' } });
    assert.equal(mock.status, 404, '啟用 LINE 登入後，只靠員編不能登入');
  } finally {
    server.close();
  }
});

test('mock 模式：不提供 LINE 登入端點', async () => {
  const { server, call } = await start('mock');
  try {
    assert.equal((await call('GET', '/api/config')).json.authMode, 'mock');
    assert.equal((await call('POST', '/api/auth/line', { body: { idToken: 'tok-U1' } })).status, 404);
  } finally {
    server.close();
  }
});

test('ID Token 驗證失敗不會發 session', async () => {
  const { server, call } = await start();
  try {
    assert.equal((await call('POST', '/api/auth/line', { body: { idToken: 'bad' } })).status, 401);
    assert.equal((await call('POST', '/api/auth/line', { body: {} })).status, 400);
  } finally {
    server.close();
  }
});

test('首次登入需綁定，綁定後下次直接登入', async () => {
  const { server, call } = await start();
  try {
    const first = await call('POST', '/api/auth/line', { body: { idToken: 'tok-U1' } });
    assert.equal(first.json.status, 'need_binding');
    assert.equal(first.json.displayName, 'LINE-U1');

    // 待綁定憑證不能當一般登入使用
    assert.equal((await call('GET', '/api/menu', { token: first.json.bindToken })).status, 401);

    // 姓名不符
    const wrong = await call('POST', '/api/auth/line/bind', {
      body: { bindToken: first.json.bindToken, employeeId: 'E001', name: '別人' },
    });
    assert.equal(wrong.status, 403);

    const ok = await call('POST', '/api/auth/line/bind', {
      body: { bindToken: first.json.bindToken, employeeId: 'E001', name: '王小明' },
    });
    assert.equal(ok.json.status, 'ok');
    assert.equal(ok.json.employee.id, 'E001');
    assert.equal((await call('GET', '/api/menu', { token: ok.json.token })).status, 200);

    // 綁定憑證只能用一次
    const reuse = await call('POST', '/api/auth/line/bind', {
      body: { bindToken: first.json.bindToken, employeeId: 'E001', name: '王小明' },
    });
    assert.equal(reuse.status, 401);

    const again = await call('POST', '/api/auth/line', { body: { idToken: 'tok-U1' } });
    assert.equal(again.json.status, 'ok');
    assert.equal(again.json.employee.id, 'E001');
  } finally {
    server.close();
  }
});

test('名單有驗證碼的員工，綁定時必須提供；回應不洩漏驗證碼', async () => {
  const { server, call, admin } = await start();
  try {
    const login = await call('POST', '/api/auth/line', { body: { idToken: 'tok-U2' } });
    const bind = (verification) => call('POST', '/api/auth/line/bind', {
      body: { bindToken: login.json.bindToken, employeeId: 'E002', name: '李美惠', verification },
    });
    assert.equal((await bind(undefined)).status, 403);
    assert.equal((await bind('9999')).status, 403);
    assert.equal((await bind('0615')).status, 200);

    const list = await call('GET', '/api/admin/employees', { token: admin });
    const e2 = list.json.find((e) => e.id === 'E002');
    assert.equal(e2.hasVerify, true);
    assert.equal(e2.bound, true);
    assert.equal('verify' in e2, false, '管理端列表不回傳驗證碼');
  } finally {
    server.close();
  }
});

test('一個員編只能綁一個 LINE 帳號；已綁定的帳號登入時不會再拿到綁定憑證', async () => {
  const { server, call } = await start();
  try {
    const a = await call('POST', '/api/auth/line', { body: { idToken: 'tok-A' } });
    await call('POST', '/api/auth/line/bind', { body: { bindToken: a.json.bindToken, employeeId: 'E001', name: '王小明' } });

    const b = await call('POST', '/api/auth/line', { body: { idToken: 'tok-B' } });
    const stolen = await call('POST', '/api/auth/line/bind', {
      body: { bindToken: b.json.bindToken, employeeId: 'E001', name: '王小明' },
    });
    assert.equal(stolen.status, 409);

    const a2 = await call('POST', '/api/auth/line', { body: { idToken: 'tok-A' } });
    assert.equal(a2.json.status, 'ok');
    assert.equal(a2.json.bindToken, undefined);
  } finally {
    server.close();
  }
});

test('連續綁定失敗 5 次會暫時鎖定', async () => {
  const { server, call } = await start();
  try {
    const login = await call('POST', '/api/auth/line', { body: { idToken: 'tok-Z' } });
    const attempt = (name) => call('POST', '/api/auth/line/bind', {
      body: { bindToken: login.json.bindToken, employeeId: 'E001', name },
    });
    for (let i = 0; i < 5; i += 1) assert.equal((await attempt('錯')).status, 403);
    assert.equal((await attempt('王小明')).status, 429, '鎖定後連正確資料也要等');
  } finally {
    server.close();
  }
});

test('管理員解除綁定後，原本的登入作廢且需重新綁定', async () => {
  const { server, call, admin } = await start();
  try {
    const login = await call('POST', '/api/auth/line', { body: { idToken: 'tok-U9' } });
    const bound = await call('POST', '/api/auth/line/bind', {
      body: { bindToken: login.json.bindToken, employeeId: 'E001', name: '王小明' },
    });
    const bindings = await call('GET', '/api/admin/bindings', { token: admin });
    assert.equal(bindings.json.length, 1);
    assert.equal(bindings.json[0].employeeName, '王小明');
    assert.equal((await call('GET', '/api/admin/bindings')).status, 401);

    const del = await call('DELETE', '/api/admin/bindings/U9', { token: admin });
    assert.equal(del.status, 200);
    assert.equal((await call('GET', '/api/menu', { token: bound.json.token })).status, 401);
    assert.equal((await call('POST', '/api/auth/line', { body: { idToken: 'tok-U9' } })).json.status, 'need_binding');
  } finally {
    server.close();
  }
});

test('AUTH_MODE=line 缺少設定時啟動失敗', () => {
  assert.throws(
    () => createApp({ store: createStore(null), auth: { mode: 'line', lineChannelId: 'ch', liffId: '' } }),
    /LIFF_ID/,
  );
});
