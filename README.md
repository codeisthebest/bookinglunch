# bookinglunch：企業內部訂餐與取餐管理系統（原型）

員工用手機訂餐，取餐口即時驗證訂餐資格，後台管理名單、菜單與未取餐扣款追蹤。
目前是**可展示的原型**：已支援 LINE LIFF 登入（需設定 channel，未設定時為展示用的模擬登入），尚未串接鼎新 ERP。

## 啟動

```bash
npm install
node scripts/seed.js   # 產生 30 位展示用員工（E001–E030）與當月平日菜單；會覆寫 data/db.json
npm start              # http://localhost:3000
npm test               # 單元與 API 測試
```

| 頁面 | 路徑 | 說明 |
|---|---|---|
| 員工訂餐 | `/` | LINE（LIFF）登入；未設定時用員編模擬登入。訂餐、改單、取消、轉讓、委託代領、顯示取餐碼 |
| 取餐口 | `/pickup.html` | 放在現場平板。USB 條碼槍直接掃，或手動輸入；瀏覽器支援時可用相機掃碼 |
| 管理後台 | `/admin.html` | 預設密碼 `admin`，正式環境請用環境變數 `ADMIN_PASSWORD` 覆寫 |

環境變數：

| 變數 | 說明 |
|---|---|
| `PORT` | 預設 3000 |
| `ADMIN_PASSWORD` | 後台密碼，預設 `admin`（正式環境務必設定） |
| `DATA_FILE` | 資料檔路徑，預設 `data/db.json` |
| `LINE_LOGIN_CHANNEL_ID` | LINE Login channel 的 Channel ID。設定後自動切換為 LINE 登入模式 |
| `LIFF_ID` | LIFF 應用的 ID（形如 `1234567890-AbCdEfGh`）。LINE 模式必填 |
| `AUTH_MODE` | 選填，`mock`（模擬登入）或 `line`；未設定時依是否有 `LINE_LOGIN_CHANNEL_ID` 決定 |

## LINE 登入（LIFF）

不使用 LINE Official Account，只需要一個 **LINE Login channel**，免費。

**LINE Developers Console 設定**

1. 登入 [LINE Developers Console](https://developers.line.biz/console/)，建立 Provider（建議用公司名稱）。
2. 在 Provider 底下建立 **LINE Login** channel，Region 選 Taiwan 或 Japan 皆可。
3. 在 channel 的「LIFF」分頁新增 LIFF 應用：
   - Endpoint URL：本系統對外的 **HTTPS** 網址（例如 `https://lunch.example.com/`），LIFF 不接受 http。
   - Size：Full。Scope：勾選 `openid`、`profile`（必須有 `openid` 才拿得到 ID Token）。
   - Bot link feature：Off。
4. 取得 **Channel ID**（Basic settings）與 **LIFF ID**，填入上面的環境變數。
5. 把 channel 狀態從 Developing 切換為 **Published**，否則只有管理員與測試者能登入。
6. 員工入口：把 LIFF URL（`https://liff.line.me/<LIFF_ID>`）做成 QR Code 或內部公告連結即可。

**運作方式**

- 前端用 LIFF SDK 取得 ID Token，**由伺服器向 LINE 驗證**（`/oauth2/v2.1/verify`），不信任前端自報的身分。
- 第一次開啟時員工輸入「員工編號＋姓名」（名單若有「驗證碼」欄位則需一併輸入）完成綁定；之後同一個 LINE 帳號自動登入。
- 一個員編只能綁一個 LINE 帳號；連續失敗 5 次會鎖定 15 分鐘；換手機或誤綁由後台「員工名單」頁解除綁定。
- 啟用 LINE 模式後，員編模擬登入端點會關閉。
- LINE 模式下登入狀態不存在瀏覽器，每次開啟都由 LIFF 重新驗證。

**測試**：`npm test` 以假的 LINE 驗證服務涵蓋綁定、鎖定、冒綁與解除綁定流程。與真實 LINE 的串接需要實際的 channel 才能驗證。

## 已實作的規則

- 僅名單內員工可登入與訂餐；後台可匯入 CSV（欄位：員工編號、姓名、部門，相同員編會更新）。
- 開放訂購**當月**任一天（今天起、有上架菜單的日期）；每天統一截止時間（預設 10:00，後台可改），該日截止前可改單、取消、轉讓；每人每日每餐別（午、晚）限訂一份。
- 公司補貼 33 元（後台可改），員工自付 = 定價 − 補貼（60／70／80 元 → 27／37／47 元）。
- 取餐口：掃員工碼即顯示今日訂餐內容；已取餐不可重複領。
- 委託代領：訂餐人必須先指定代領人員編才會產生委託碼（不受訂餐截止限制，只要該餐尚未過取餐期限即可設定或取消）；取餐口仍須代領人輸入自己的員編，且必須與指定者相符，訂餐人本人也不放行。轉讓或取消訂單時委託一併清除。
- 未取餐判定：午餐 13:00、晚餐 18:20 之後仍未取餐者列入清單。後台可設定例外（出差、請假）免列入。
- 「記錄未取餐」與「實際扣款」分開：清單狀態為 待處理／已送人事／已豁免，可匯出 CSV 給人事確認後再送薪資。
- 報表：當日總訂餐數、各金額級距、午晚餐數量、已取／待取／未取、扣款合計。
- 後台「模擬時間」僅供展示截止與未取餐判定，正式環境請恢復系統時間。

## 原型的假設與限制（待確認）

- 截止時間 10:00 是暫定值；「當月」指與今天同一個月份，下個月的訂餐要等到下個月才開放。
- 未設定 LINE channel 時是員編模擬登入，**沒有真正的身分驗證**，僅供展示。
- **取餐口仍只憑員編**：員工 QR Code 內容是固定的 `EMP:員編`，知道員編的人可以在取餐口輸入冒領。建議下一步改為短效簽章的取餐碼。人臉辨識是否導入尚待法規確認。
- LIFF 登入已用模擬的 LINE 驗證服務測過，**尚未用真實 LINE channel 驗證**。
- 不使用 LINE Official Account，因此沒有推播提醒；未取餐通知管道尚未決定。
- 儲存為單一 JSON 檔，適合展示，正式上線需換成資料庫。
- 員工名單匯入只支援 CSV（Excel／鼎新匯出後另存 CSV）；歷史訂餐匯入與薪資扣款串接尚未實作。
- 管理員只有單一共用密碼，未做權限分級。
- QR Code 圖片由 cdnjs 的 qrcode-generator 產生，離線環境會退回顯示文字代碼。
