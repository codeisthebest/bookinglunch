// 產生展示用資料：30 位假員工、當日午晚餐菜單（60／70／80 元）。
// 用法：node scripts/seed.js   （會覆寫 data/db.json，請勿在正式資料上執行）

const path = require('node:path');
const { createStore } = require('../src/store');
const { createService } = require('../src/service');
const { taipeiNow } = require('../src/time');

const store = createStore(process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'));
store.reset();
const service = createService(store);

const names = ['王小明', '李美惠', '陳志偉', '林佳穎', '張雅婷', '黃建宏', '吳彥廷', '蔡欣怡', '劉俊傑', '鄭淑芬'];
const depts = ['行政', '研發', '業務', '財務', '人資'];
const csvRows = ['員工編號,姓名,部門'];
for (let i = 1; i <= 30; i += 1) {
  const id = `E${String(i).padStart(3, '0')}`;
  csvRows.push(`${id},${names[i % names.length]}${i},${depts[i % depts.length]}`);
}
service.importEmployees(csvRows.join('\n'));

const { date } = taipeiNow();
service.setMenu(date, [
  { meal: 'lunch', name: '照燒雞腿飯', price: 60 },
  { meal: 'lunch', name: '紅燒排骨飯', price: 70 },
  { meal: 'lunch', name: '鮭魚排餐', price: 80 },
  { meal: 'dinner', name: '滷肉飯套餐', price: 60 },
  { meal: 'dinner', name: '薑燒豬排飯', price: 70 },
  { meal: 'dinner', name: '牛肉麵套餐', price: 80 },
]);

console.log(`已產生 30 位員工與 ${date} 菜單（資料檔：${process.env.DATA_FILE || 'data/db.json'}）`);
