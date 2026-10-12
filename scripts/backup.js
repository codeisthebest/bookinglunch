// 備份資料庫（伺服器運作中也能執行，取得的是一致的完整快照）。
//   node scripts/backup.js [目的檔路徑]
// 未指定時寫到資料庫同目錄的 backups/bookinglunch-YYYY-MM-DD-HHmm.db。
// 不要直接複製運作中的 .db 檔：WAL 模式下最新的資料可能還在 -wal 檔裡。

const path = require('node:path');
const { createStore } = require('../src/store');

const store = createStore();
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-');
const dest = process.argv[2] || path.join(path.dirname(store.filename), 'backups', `bookinglunch-${stamp}.db`);

try {
  store.backup(dest);
  console.log(`已備份到 ${dest}`);
} catch (err) {
  console.error(`備份失敗：${err.message}`);
  process.exit(1);
}
store.close();
