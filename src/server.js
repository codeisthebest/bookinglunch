const { createStore } = require('./store');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);

const store = createStore();
const { app, authMode } = createApp({ store });

app.listen(PORT, () => {
  console.log(`訂餐系統已啟動：http://localhost:${PORT}`);
  console.log(`員工端 /  取餐口 /pickup.html  管理後台 /admin.html`);
  if (authMode === 'mock') {
    console.warn('⚠ 目前是模擬登入（只憑員編即可登入），僅供展示。正式環境請設定 LINE_LOGIN_CHANNEL_ID 與 LIFF_ID。');
  }
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('⚠ 管理後台使用預設密碼 admin，請設定環境變數 ADMIN_PASSWORD。');
  }
});
