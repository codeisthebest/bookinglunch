// 取餐口裝置：共用平板不走個人帳號，用「裝置編號＋裝置金鑰」登入。
// 金鑰只在建立或重設時顯示一次，資料庫只存加鹽雜湊。

const crypto = require('node:crypto');
const { AppError } = require('./service');
const { hashPassword, verifyPassword } = require('./admins');

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const ID_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
const DUMMY = hashPassword('dummy-kiosk-key');

function generateKey() {
  return `kiosk-${crypto.randomBytes(18).toString('base64url')}`;
}

function createKioskService(store) {
  const failures = new Map();

  function publicView(k) {
    return { id: k.id, name: k.name, active: k.active, createdAt: k.createdAt, lastSeen: k.lastSeen || null };
  }

  // 建立裝置；key 可指定（展示用），未指定則隨機產生。回傳明文金鑰僅此一次。
  function create({ id, name, key }) {
    const deviceId = String(id || '').trim().toUpperCase();
    if (!ID_RE.test(deviceId)) throw new AppError(400, '裝置編號需為 2–32 字元的英數字、底線或連字號');
    if (store.kiosks.get(deviceId)) throw new AppError(409, '此裝置編號已存在');
    const plain = key || generateKey();
    const { salt, hash } = hashPassword(plain);
    const device = {
      id: deviceId,
      name: String(name || deviceId).trim() || deviceId,
      active: true,
      salt,
      hash,
      createdAt: new Date().toISOString(),
      lastSeen: null,
    };
    store.kiosks.save(device);
    return { kiosk: publicView(device), key: plain };
  }

  function authenticate(deviceId, key) {
    const id = String(deviceId || '').trim().toUpperCase();
    const failure = failures.get(id);
    if (failure && failure.until > Date.now()) throw new AppError(429, '嘗試次數過多，請 15 分鐘後再試');

    const device = store.kiosks.get(id);
    const ok = verifyPassword(String(key || ''), device || DUMMY) && device && device.active;
    if (!ok) {
      const lockExpired = failure && failure.until > 0 && failure.until <= Date.now();
      const count = (failure && !lockExpired ? failure.count : 0) + 1;
      failures.set(id, { count, until: count >= MAX_FAILURES ? Date.now() + LOCK_MS : 0 });
      throw new AppError(401, '裝置編號或金鑰錯誤');
    }
    failures.delete(id);
    device.lastSeen = new Date().toISOString();
    store.kiosks.save(device);
    return publicView(device);
  }

  function getActive(deviceId) {
    const device = store.kiosks.get(deviceId);
    return device && device.active ? device : null;
  }

  function list() {
    return store.kiosks.all().map(publicView);
  }

  // patch: { active?, name?, resetKey? }。停用或重設金鑰時，呼叫端要作廢該裝置既有的登入。
  function update(deviceId, patch) {
    const device = store.kiosks.get(deviceId);
    if (!device) throw new AppError(404, '找不到此裝置');
    let newKey = null;
    let revokeSessions = false;
    if (patch.name !== undefined) device.name = String(patch.name).trim() || device.id;
    if (patch.active !== undefined && Boolean(patch.active) !== device.active) {
      device.active = Boolean(patch.active);
      if (!device.active) revokeSessions = true;
    }
    if (patch.resetKey) {
      newKey = generateKey();
      Object.assign(device, hashPassword(newKey));
      failures.delete(deviceId);
      revokeSessions = true;
    }
    store.kiosks.save(device);
    return { kiosk: publicView(device), key: newKey, revokeSessions };
  }

  return { create, authenticate, getActive, list, update };
}

module.exports = { createKioskService };
