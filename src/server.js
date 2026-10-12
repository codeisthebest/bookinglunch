const { createStore } = require('./store');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);

const store = createStore();
const { app } = createApp({ store });

app.listen(PORT, () => {
  console.log(`訂餐系統已啟動：http://localhost:${PORT}`);
  console.log(`員工端 /  取餐口 /pickup.html  管理後台 /admin.html`);
});
