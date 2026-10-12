// 產生展示用資料：30 位假員工、當日午晚餐菜單（60／70／80 元）。
// 用法：node scripts/seed.js   （會覆寫 data/db.json，請勿在正式資料上執行）

const path = require('node:path');
const { createStore } = require('../src/store');
const { createService } = require('../src/service');
const { createAdminService } = require('../src/admins');
const { createKioskService } = require('../src/kiosks');
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

// 展示用的各角色後台帳號（密碼固定，僅限展示環境）。系統管理員 admin 的密碼取自 ADMIN_PASSWORD（未設定則為 admin）。
const admins = createAdminService(store);
admins.ensureBootstrap(process.env.ADMIN_PASSWORD || 'admin');
admins.create({ username: 'assistant', displayName: '助理小姐', role: 'operator', password: 'demo-assistant-1' });
admins.create({ username: 'auditor', displayName: '稽核（唯讀）', role: 'viewer', password: 'demo-auditor-1' });

// 展示用取餐口裝置（金鑰固定，僅限展示環境；正式環境請在後台「系統設定」建立並使用隨機金鑰）
createKioskService(store).create({ id: 'KIOSK-01', name: '展示用取餐平板', key: 'kiosk-key-demo-0001' });

// 當月每個平日（週一至週五）都上架同一份展示菜單
const { date } = taipeiNow();
const [year, month] = date.split('-').map(Number);
const daysInMonth = new Date(year, month, 0).getDate();
let menuDays = 0;
for (let d = 1; d <= daysInMonth; d += 1) {
  const day = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const weekday = new Date(`${day}T12:00:00+08:00`).getUTCDay();
  if (weekday === 0 || weekday === 6) continue;
  service.setMenu(day, [
    { meal: 'lunch', name: '素食 A餐', price: 60, main: '滷四角油', sides: ['炒三色豆', '焗汁洋芋'], veg: '營養青菜、時蔬兩道' },
    { meal: 'lunch', name: 'A餐', price: 70, main: '照燒雞排', sides: ['蔥爆香腸', '蘿蔔滷黑輪'], veg: '時蔬兩道' },
    { meal: 'lunch', name: 'B餐', price: 80, main: '炒泡麵＋主菜', special: true },
    { meal: 'dinner', name: '滷肉飯套餐', price: 60, main: '滷肉飯', sides: ['滷蛋', '燙青菜'] },
    { meal: 'dinner', name: '薑燒豬排飯', price: 70, main: '薑燒豬排', sides: ['玉子燒'], veg: '時蔬兩道' },
    { meal: 'dinner', name: '牛肉麵套餐', price: 80, main: '紅燒牛肉麵', special: true },
  ]);
  menuDays += 1;
}

console.log(`展示取餐口裝置：KIOSK-01（金鑰 kiosk-key-demo-0001）`);
console.log(`已產生 30 位員工與 ${year}-${String(month).padStart(2, '0')} 月 ${menuDays} 個平日的菜單（資料檔：${process.env.DATA_FILE || 'data/db.json'}）`);
