// 動態取餐碼：由伺服器簽發與驗證，簽章金鑰絕不送到瀏覽器。
//
// 取餐碼格式：P.<員編>.<時間窗格>.<簽章>
//   - 時間窗格 = 30 秒一格的 Unix 時間；每格重新簽發
//   - 簽章 = HMAC-SHA256(金鑰, "P:員編:時間窗格") 取前 16 碼十六進位
//   - 驗證時接受本格與上一格，所以效期約 30–60 秒；截圖轉傳會因逾時失效
//
// 取餐口驗證通過後會再發一張「取餐憑證」（ticket），綁定員工與取餐口裝置、2 分鐘內有效，
// 之後按「確認取餐」時用憑證，不必在 60 秒內完成操作，也不能拿到別台取餐口使用。

const crypto = require('node:crypto');

const WINDOW_SECONDS = 30;
const VALID_WINDOWS = 2;
const TICKET_TTL_MS = 2 * 60 * 1000;
const TOKEN_RE = /^P\.(.+)\.(\d+)\.([0-9a-f]{16})$/;

function createTokenService({ secret, nowMs = () => Date.now() } = {}) {
  const key = secret ? Buffer.from(String(secret)) : crypto.randomBytes(32);

  const windowOf = (ms) => Math.floor(ms / 1000 / WINDOW_SECONDS);
  const sign = (text) => crypto.createHmac('sha256', key).update(text).digest('hex').slice(0, 16);
  const safeEqual = (a, b) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  function looksLikeToken(value) {
    return TOKEN_RE.test(String(value || '').trim());
  }

  function issue(employeeId) {
    const w = windowOf(nowMs());
    const secondsLeft = WINDOW_SECONDS - (Math.floor(nowMs() / 1000) % WINDOW_SECONDS);
    return {
      token: `P.${employeeId}.${w}.${sign(`P:${employeeId}:${w}`)}`,
      refreshInSeconds: secondsLeft,
    };
  }

  // 回傳 { ok: true, employeeId } 或 { ok: false, reason: 'format' | 'signature' | 'expired' }
  function verify(token) {
    const match = TOKEN_RE.exec(String(token || '').trim());
    if (!match) return { ok: false, reason: 'format' };
    const [, employeeId, windowText, sig] = match;
    const w = Number(windowText);
    if (!safeEqual(sign(`P:${employeeId}:${w}`), sig)) return { ok: false, reason: 'signature' };
    if (windowOf(nowMs()) - w > VALID_WINDOWS - 1 || w > windowOf(nowMs())) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, employeeId };
  }

  function issueTicket(employeeId, kioskId) {
    const payload = Buffer.from(JSON.stringify({ e: employeeId, k: kioskId || '', x: nowMs() + TICKET_TTL_MS })).toString('base64url');
    return `${payload}.${sign(`T:${payload}`)}`;
  }

  // 回傳 { ok: true, employeeId } 或 { ok: false, reason: 'format' | 'signature' | 'expired' | 'kiosk' }
  function verifyTicket(ticket, kioskId) {
    const [payload, sig, extra] = String(ticket || '').split('.');
    if (!payload || !sig || extra !== undefined) return { ok: false, reason: 'format' };
    if (!safeEqual(sign(`T:${payload}`), sig)) return { ok: false, reason: 'signature' };
    let data;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch (_) {
      return { ok: false, reason: 'format' };
    }
    if (data.x <= nowMs()) return { ok: false, reason: 'expired' };
    if ((data.k || '') !== (kioskId || '')) return { ok: false, reason: 'kiosk' };
    return { ok: true, employeeId: data.e };
  }

  return { looksLikeToken, issue, verify, issueTicket, verifyTicket, WINDOW_SECONDS };
}

module.exports = { createTokenService, WINDOW_SECONDS };
