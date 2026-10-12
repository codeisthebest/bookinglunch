// 把舊版 JSON 資料檔搬進 SQLite（一般不需手動執行：伺服器啟動時發現資料庫是空的、
// 而舊檔存在，會自動搬遷）。
//   node scripts/migrate-json.js <舊 db.json 路徑> [SQLite 檔路徑]
// 目標資料庫必須是空的，避免覆蓋現有資料。

const fs = require('node:fs');
const { createStore } = require('../src/store');
const { importLegacyJson } = require('../src/migrate');

const [source, target] = process.argv.slice(2);
if (!source) {
  console.error('用法：node scripts/migrate-json.js <舊 db.json 路徑> [SQLite 檔路徑]');
  process.exit(1);
}

const store = createStore(target);
if (!store.isEmpty()) {
  console.error('目標資料庫已有資料，為避免覆蓋已中止。請指定一個空的資料庫檔。');
  process.exit(1);
}

try {
  const counts = importLegacyJson(store, JSON.parse(fs.readFileSync(source, 'utf8')));
  console.log('搬遷完成：', JSON.stringify(counts));
} catch (err) {
  console.error(`搬遷失敗（已整筆回復，資料庫維持原狀）：${err.message}`);
  process.exit(1);
}
