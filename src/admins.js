// 管理員帳號：密碼雜湊、登入鎖定、建立與維護規則。

const crypto = require('node:crypto');
const { AppError } = require('./service');
const { ROLES } = require('./permissions');

const MIN_PASSWORD_LENGTH = 8;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, record) {
  const expected = Buffer.from(record.hash, 'hex');
  const actual = crypto.scryptSync(password, record.salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// 帳號不存在時也跑一次相同成本的雜湊，避免從回應時間猜出帳號是否存在
const DUMMY = hashPassword('dummy-password');

function createAdminService(store) {
  const failures = new Map(); // username -> { count, until }
  const accounts = () => store.db.admins;

  function publicView(admin) {
    return {
      username: admin.username,
      displayName: admin.displayName,
      role: admin.role,
      roleLabel: ROLES[admin.role].label,
      active: admin.active,
      createdAt: admin.createdAt,
    };
  }

  function validatePassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new AppError(400, `密碼至少需要 ${MIN_PASSWORD_LENGTH} 個字元`);
    }
  }

  function activeOwnerCount(except) {
    return Object.values(accounts()).filter((a) => a.active && a.role === 'owner' && a.username !== except).length;
  }

  function create({ username, displayName, role, password }, { skipPasswordPolicy = false } = {}) {
    const name = String(username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(name)) throw new AppError(400, '帳號需為 3–32 字元的小寫英數字、點、底線或連字號');
    if (!ROLES[role]) throw new AppError(400, '角色不正確');
    if (!skipPasswordPolicy) validatePassword(password);
    if (accounts()[name]) throw new AppError(409, '此帳號已存在');

    const { salt, hash } = hashPassword(String(password));
    accounts()[name] = {
      username: name,
      displayName: String(displayName || name).trim() || name,
      role,
      active: true,
      salt,
      hash,
      createdAt: new Date().toISOString(),
    };
    store.save();
    return publicView(accounts()[name]);
  }

  // 第一次啟動且沒有任何管理員時，用初始密碼建立 admin（系統管理員）
  function ensureBootstrap(initialPassword) {
    if (Object.keys(accounts()).length > 0) return false;
    create(
      { username: 'admin', displayName: '初始管理員', role: 'owner', password: initialPassword },
      { skipPasswordPolicy: true },
    );
    return true;
  }

  function authenticate(username, password) {
    const name = String(username || '').trim().toLowerCase();
    const failure = failures.get(name);
    if (failure && failure.until > Date.now()) {
      throw new AppError(429, '嘗試次數過多，請 15 分鐘後再試');
    }

    const admin = accounts()[name];
    const ok = verifyPassword(String(password || ''), admin || DUMMY) && admin && admin.active;
    if (!ok) {
      const lockExpired = failure && failure.until > 0 && failure.until <= Date.now();
      const count = (failure && !lockExpired ? failure.count : 0) + 1;
      failures.set(name, { count, until: count >= MAX_FAILURES ? Date.now() + LOCK_MS : 0 });
      throw new AppError(401, '帳號或密碼錯誤');
    }
    failures.delete(name);
    return admin;
  }

  function getActive(username) {
    const admin = accounts()[username];
    return admin && admin.active ? admin : null;
  }

  function list() {
    return Object.values(accounts())
      .sort((a, b) => a.username.localeCompare(b.username))
      .map(publicView);
  }

  // 回傳 { admin, revokeSessions }：改密碼或停用時，呼叫端要作廢該帳號既有的登入
  function update(username, patch, actor) {
    const admin = accounts()[username];
    if (!admin) throw new AppError(404, '找不到此管理員帳號');

    const isSelf = username === actor;
    let revokeSessions = false;

    if (patch.role !== undefined && patch.role !== admin.role) {
      if (!ROLES[patch.role]) throw new AppError(400, '角色不正確');
      if (isSelf) throw new AppError(400, '不可變更自己的角色，請由其他系統管理員操作');
      if (admin.role === 'owner' && admin.active && activeOwnerCount(username) === 0) {
        throw new AppError(409, '至少要保留一位啟用中的系統管理員');
      }
      admin.role = patch.role;
    }
    if (patch.active !== undefined && Boolean(patch.active) !== admin.active) {
      if (isSelf) throw new AppError(400, '不可停用自己的帳號');
      if (!patch.active && admin.role === 'owner' && activeOwnerCount(username) === 0) {
        throw new AppError(409, '至少要保留一位啟用中的系統管理員');
      }
      admin.active = Boolean(patch.active);
      if (!admin.active) revokeSessions = true;
    }
    if (patch.displayName !== undefined) {
      admin.displayName = String(patch.displayName).trim() || admin.username;
    }
    if (patch.password !== undefined) {
      validatePassword(patch.password);
      Object.assign(admin, hashPassword(patch.password));
      failures.delete(username);
      revokeSessions = true;
    }
    store.save();
    return { admin: publicView(admin), revokeSessions };
  }

  function changeOwnPassword(username, oldPassword, newPassword) {
    const admin = accounts()[username];
    if (!admin || !verifyPassword(String(oldPassword || ''), admin)) {
      throw new AppError(403, '目前的密碼不正確');
    }
    validatePassword(newPassword);
    Object.assign(admin, hashPassword(newPassword));
    store.save();
  }

  // 還在使用預設的 admin / admin 時提醒（正式環境應立刻更換）
  function hasDefaultCredential() {
    const admin = accounts().admin;
    return Boolean(admin && admin.active && verifyPassword('admin', admin));
  }

  return {
    ensureBootstrap,
    authenticate,
    getActive,
    create,
    update,
    list,
    changeOwnPassword,
    hasDefaultCredential,
    publicView,
  };
}

module.exports = { createAdminService, MIN_PASSWORD_LENGTH, hashPassword, verifyPassword };
