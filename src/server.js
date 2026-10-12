const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('./store');
const { importLegacyJson } = require('./migrate');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);

const store = createStore();

// 舊版把資料存成 JSON 檔：資料庫是空的、而舊檔還在時，自動搬進 SQLite（舊檔改名保留，不會刪除）
const legacyPath = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
if (store.isEmpty() && fs.existsSync(legacyPath)) {
  try {
    const counts = importLegacyJson(store, JSON.parse(fs.readFileSync(legacyPath, 'utf8')));
    fs.renameSync(legacyPath, `${legacyPath}.migrated`);
    console.log(`已將舊的 JSON 資料搬進 SQLite：${JSON.stringify(counts)}；舊檔改名為 ${legacyPath}.migrated`);
  } catch (err) {
    console.error(`舊資料搬遷失敗，已整筆回復：${err.message}`);
    process.exit(1);
  }
}
const { app, authMode, adminService } = createApp({ store });

const server = app.listen(PORT, () => {
  console.log(`訂餐系統已啟動：http://localhost:${PORT}`);
  console.log(`員工端 /  取餐口 /pickup.html  管理後台 /admin.html`);
  if (authMode === 'mock') {
    console.warn('⚠ 目前是模擬登入（只憑員編即可登入），僅供展示。正式環境請設定 LINE_LOGIN_CHANNEL_ID 與 LIFF_ID。');
  }
  if (adminService.hasDefaultCredential()) {
    console.warn('⚠ 管理員 admin 仍使用預設密碼，請登入後立即更改，或首次啟動前設定環境變數 ADMIN_PASSWORD。');
  }
});

// 容器以 PID 1 執行時不會自動處理停止訊號；收到 SIGTERM（docker stop）時正常關閉，
// 不再接新連線並讓處理中的請求完成。資料每次寫入都已同步落地，所以不會遺失。
function shutdown(signal) {
  console.log(`收到 ${signal}，關閉中…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
