// HTTP 層：路由、權限與錯誤處理。規則都在 service.js。

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { createService, AppError } = require('./service');
const { getClock, setClock, taipeiNow } = require('./time');
const { toCsv } = require('./csv');

const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const PENDING_BIND_MS = 10 * 60 * 1000;

// 向 LINE 驗證 LIFF 取得的 ID Token，回傳 { sub, name }。
// 絕不信任前端自報的 userId；一定要由伺服器向 LINE 驗證簽章、有效期限與 channel。
function createLineVerifier(channelId, verifyUrl = process.env.LINE_VERIFY_URL || LINE_VERIFY_URL) {
  return async function verifyIdToken(idToken) {
    let res;
    try {
      res = await fetch(verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      throw new AppError(502, '無法連線到 LINE 驗證服務，請稍後再試');
    }
    if (!res.ok) throw new AppError(401, 'LINE 登入驗證失敗，請重新開啟頁面');
    const claims = await res.json();
    if (!claims.sub) throw new AppError(401, 'LINE 登入驗證失敗，請重新開啟頁面');
    return { sub: claims.sub, name: claims.name || '' };
  };
}

function resolveAuth(options = {}) {
  const channelId = options.lineChannelId !== undefined ? options.lineChannelId : process.env.LINE_LOGIN_CHANNEL_ID;
  const liffId = options.liffId !== undefined ? options.liffId : process.env.LIFF_ID;
  const mode = options.mode || process.env.AUTH_MODE || (channelId ? 'line' : 'mock');
  if (!['mock', 'line'].includes(mode)) throw new Error(`AUTH_MODE 只能是 mock 或 line，收到：${mode}`);
  if (mode === 'line' && (!channelId || !liffId)) {
    throw new Error('AUTH_MODE=line 需要同時設定 LINE_LOGIN_CHANNEL_ID 與 LIFF_ID');
  }
  const verifyIdToken = options.verifyIdToken || (mode === 'line' ? createLineVerifier(channelId) : null);
  return { mode, liffId: mode === 'line' ? liffId : null, verifyIdToken };
}

function createApp({ store, adminPassword = process.env.ADMIN_PASSWORD || 'admin', auth } = {}) {
  const service = createService(store);
  const authConfig = resolveAuth(auth);
  const sessions = new Map(); // token -> { role, employeeId?, expires? }

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  function issue(session) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, session);
    return token;
  }

  function bearer(req) {
    const header = req.get('authorization') || '';
    return header.startsWith('Bearer ') ? header.slice(7) : null;
  }

  function getSession(token) {
    const session = token && sessions.get(token);
    if (!session) return null;
    if (session.expires && session.expires <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return session;
  }

  function requireEmployee(req, res, next) {
    const session = getSession(bearer(req));
    if (!session || session.role !== 'employee') return res.status(401).json({ error: '請先登入' });
    req.employeeId = session.employeeId;
    return next();
  }

  function requireAdmin(req, res, next) {
    const session = getSession(bearer(req));
    if (!session || session.role !== 'admin') return res.status(401).json({ error: '請以管理員身分登入' });
    return next();
  }

  // ---------- 登入 ----------

  // 前端依這個設定決定走 LIFF 還是模擬登入
  app.get('/api/config', (req, res) => {
    res.json({ authMode: authConfig.mode, liffId: authConfig.liffId });
  });

  // 模擬登入：只在 mock 模式可用。啟用 LINE 登入後整個關閉，避免只靠員編就能冒用身分。
  app.post('/api/auth/employee', (req, res, next) => {
    try {
      if (authConfig.mode !== 'mock') throw new AppError(404, '此環境已啟用 LINE 登入');
      const employeeId = String(req.body.employeeId || '').trim();
      const employee = service.getEmployee(employeeId);
      if (!employee) throw new AppError(403, '查無此員工編號，僅限內部員工使用');
      const token = issue({ role: 'employee', employeeId });
      res.json({ token, employee });
    } catch (err) {
      next(err);
    }
  });

  // LIFF 登入：前端送 ID Token，伺服器向 LINE 驗證後依綁定紀錄發 session。
  app.post('/api/auth/line', async (req, res, next) => {
    try {
      if (authConfig.mode !== 'line') throw new AppError(404, '此環境未啟用 LINE 登入');
      const idToken = String(req.body.idToken || '');
      if (!idToken) throw new AppError(400, '缺少 LINE ID Token');
      const profile = await authConfig.verifyIdToken(idToken);

      const employee = service.findBinding(profile.sub);
      if (employee) {
        const token = issue({ role: 'employee', employeeId: employee.id });
        return res.json({ status: 'ok', token, employee });
      }
      // 尚未綁定：發一個短效的待綁定憑證，只能用來呼叫綁定 API
      const bindToken = issue({
        role: 'pending-bind',
        lineUserId: profile.sub,
        displayName: profile.name,
        expires: Date.now() + PENDING_BIND_MS,
      });
      return res.json({ status: 'need_binding', bindToken, displayName: profile.name });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/auth/line/bind', (req, res, next) => {
    try {
      if (authConfig.mode !== 'line') throw new AppError(404, '此環境未啟用 LINE 登入');
      const pendingToken = String(req.body.bindToken || '');
      const pending = getSession(pendingToken);
      if (!pending || pending.role !== 'pending-bind') {
        throw new AppError(401, '綁定連結已逾時，請重新開啟頁面');
      }
      const employee = service.bindEmployee({
        lineUserId: pending.lineUserId,
        displayName: pending.displayName,
        employeeId: req.body.employeeId,
        name: req.body.name,
        verification: req.body.verification,
      });
      sessions.delete(pendingToken); // 一次性
      const token = issue({ role: 'employee', employeeId: employee.id });
      res.json({ status: 'ok', token, employee });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/admin', (req, res) => {
    if (String(req.body.password || '') !== adminPassword) {
      return res.status(401).json({ error: '密碼錯誤' });
    }
    return res.json({ token: issue({ role: 'admin' }) });
  });

  app.get('/api/me', requireEmployee, (req, res, next) => {
    try {
      res.json(service.getEmployee(req.employeeId));
    } catch (err) {
      next(err);
    }
  });

  // ---------- 員工端 ----------

  // 指定日期的菜單（?date=YYYY-MM-DD，省略為今天）；today 為相容舊路徑
  app.get(['/api/menu', '/api/menu/today'], requireEmployee, (req, res, next) => {
    try {
      res.json(service.menuForDate(req.employeeId, req.query.date ? String(req.query.date) : undefined));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/orders', requireEmployee, (req, res, next) => {
    try {
      res.status(201).json(service.placeOrder(req.employeeId, req.body.itemId, req.body.date));
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/orders/:id', requireEmployee, (req, res, next) => {
    try {
      res.json(service.cancelOrder(req.employeeId, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/orders/:id/transfer', requireEmployee, (req, res, next) => {
    try {
      res.json(service.transferOrder(req.employeeId, req.params.id, String(req.body.toEmployeeId || '').trim()));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/orders/:id/delegate', requireEmployee, (req, res, next) => {
    try {
      res.json(service.delegateOrder(req.employeeId, req.params.id, String(req.body.delegateId || '').trim()));
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/orders/:id/delegate', requireEmployee, (req, res, next) => {
    try {
      res.json(service.undelegateOrder(req.employeeId, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  // ---------- 取餐口（無需登入，放在現場平板） ----------

  app.post('/api/pickup/lookup', (req, res, next) => {
    try {
      res.json(service.pickupLookup(req.body.code));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/pickup/confirm', (req, res, next) => {
    try {
      const order = service.pickupConfirm({
        orderId: req.body.orderId,
        code: req.body.code,
        employeeId: String(req.body.employeeId || '').trim(),
      });
      res.json(order);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/pickup/status', (req, res, next) => {
    try {
      const today = taipeiNow();
      res.json({ date: today.date, time: today.time, ...service.orderingStatus(today.date) });
    } catch (err) {
      next(err);
    }
  });

  // ---------- 管理端 ----------

  app.get('/api/admin/config', requireAdmin, (req, res) => res.json(service.getConfig()));

  app.put('/api/admin/config', requireAdmin, (req, res, next) => {
    try {
      res.json(service.updateConfig(req.body));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/clock', requireAdmin, (req, res) => {
    const clock = getClock();
    res.json({ simulated: clock.simulated, at: clock.at.toISOString(), taipei: taipeiNow() });
  });

  app.put('/api/admin/clock', requireAdmin, (req, res, next) => {
    try {
      setClock(req.body.now || null);
      const clock = getClock();
      res.json({ simulated: clock.simulated, at: clock.at.toISOString(), taipei: taipeiNow() });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/employees', requireAdmin, (req, res) => res.json(service.listEmployees()));

  app.post('/api/admin/employees/import', requireAdmin, (req, res, next) => {
    try {
      res.json(service.importEmployees(req.body.csv));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/bindings', requireAdmin, (req, res) => res.json(service.listBindings()));

  app.delete('/api/admin/bindings/:lineUserId', requireAdmin, (req, res, next) => {
    try {
      const binding = service.listBindings().find((b) => b.lineUserId === req.params.lineUserId);
      const result = service.unbind(req.params.lineUserId);
      // 解除綁定時，該員工已發出的登入一併作廢
      sessions.forEach((session, token) => {
        if (session.role === 'employee' && binding && session.employeeId === binding.employeeId) {
          sessions.delete(token);
        }
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/menu', requireAdmin, (req, res) => res.json(service.getMenu(String(req.query.date || ''))));

  app.put('/api/admin/menu', requireAdmin, (req, res, next) => {
    try {
      res.json(service.setMenu(req.body.date, req.body.items));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/report', requireAdmin, (req, res, next) => {
    try {
      res.json(service.dayReport(String(req.query.date || '')));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/orders', requireAdmin, (req, res, next) => {
    try {
      res.json(service.dayOrders(String(req.query.date || '')));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/deductions.csv', requireAdmin, (req, res, next) => {
    try {
      const report = service.dayReport(String(req.query.date || ''));
      const rows = [['日期', '員工編號', '姓名', '餐別', '品項', '應付金額', '扣款狀態']];
      report.deductionList.forEach((o) => {
        rows.push([o.date, o.employeeId, o.employeeName, o.mealLabel, o.itemName, o.amount, o.deductionStatus]);
      });
      res.type('text/csv; charset=utf-8');
      res.attachment(`deductions-${report.date}.csv`);
      res.send(`﻿${toCsv(rows)}`);
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/admin/deductions/:orderId', requireAdmin, (req, res, next) => {
    try {
      res.json(service.setDeductionStatus(req.params.orderId, req.body.status));
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/admin/exemptions', requireAdmin, (req, res, next) => {
    try {
      res.json(service.setExemption(req.body.date, String(req.body.employeeId || '').trim(), req.body.reason));
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/admin/exemptions', requireAdmin, (req, res, next) => {
    try {
      res.json(service.removeExemption(String(req.query.date || ''), String(req.query.employeeId || '')));
    } catch (err) {
      next(err);
    }
  });

  // ---------- 錯誤處理 ----------

  app.use((req, res) => res.status(404).json({ error: '找不到路徑' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON 格式錯誤' });
    console.error(err);
    return res.status(500).json({ error: '伺服器錯誤' });
  });

  return { app, service, sessions, authMode: authConfig.mode };
}

module.exports = { createApp };
