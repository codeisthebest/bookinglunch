// HTTP 層：路由、權限與錯誤處理。規則都在 service.js。

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { createService, AppError } = require('./service');
const { getClock, setClock, taipeiNow } = require('./time');
const { toCsv } = require('./csv');

function createApp({ store, adminPassword = process.env.ADMIN_PASSWORD || 'admin' } = {}) {
  const service = createService(store);
  const sessions = new Map(); // token -> { role, employeeId? }

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

  function requireEmployee(req, res, next) {
    const session = sessions.get(bearer(req));
    if (!session || session.role !== 'employee') return res.status(401).json({ error: '請先登入' });
    req.employeeId = session.employeeId;
    return next();
  }

  function requireAdmin(req, res, next) {
    const session = sessions.get(bearer(req));
    if (!session || session.role !== 'admin') return res.status(401).json({ error: '請以管理員身分登入' });
    return next();
  }

  // ---------- 登入 ----------

  // 原型：以員工編號比對名單模擬 LIFF 身分綁定。正式版改為 LINE Login 取得 userId 後綁定。
  app.post('/api/auth/employee', (req, res, next) => {
    try {
      const employeeId = String(req.body.employeeId || '').trim();
      const employee = service.getEmployee(employeeId);
      if (!employee) throw new AppError(403, '查無此員工編號，僅限內部員工使用');
      const token = issue({ role: 'employee', employeeId });
      res.json({ token, employee });
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

  app.get('/api/menu/today', requireEmployee, (req, res, next) => {
    try {
      res.json(service.todayMenu(req.employeeId));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/orders', requireEmployee, (req, res, next) => {
    try {
      res.status(201).json(service.placeOrder(req.employeeId, req.body.itemId));
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

  return { app, service, sessions };
}

module.exports = { createApp };
