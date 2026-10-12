// 忘記系統管理員密碼時，在伺服器上執行：
//   node scripts/reset-admin.js <帳號> <新密碼>
// 帳號不存在會建立為系統管理員；存在則重設密碼並啟用、恢復為系統管理員。
// 需要能讀寫資料庫（DB_FILE 或 data/bookinglunch.db）。

const { createStore } = require('../src/store');
const { createAdminService } = require('../src/admins');

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('用法：node scripts/reset-admin.js <帳號> <新密碼>');
  process.exit(1);
}

const store = createStore();
const admins = createAdminService(store);
const exists = store.admins.get(username.toLowerCase());

try {
  if (exists) {
    admins.update(username.toLowerCase(), { password, active: true, role: 'owner' }, null);
    console.log(`已重設 ${username} 的密碼，並恢復為啟用中的系統管理員`);
  } else {
    admins.create({ username, displayName: username, role: 'owner', password });
    console.log(`已建立系統管理員 ${username}`);
  }
} catch (err) {
  console.error(`失敗：${err.message}`);
  process.exit(1);
}
