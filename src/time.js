// 所有營運時間以台北時間為準。
// 測試或展示時可用 setClock() 模擬現在時間，正式環境不設定即使用系統時間。

const TZ = 'Asia/Taipei';

// 未取餐判定時間（依餐別）
const MEAL_DEADLINES = {
  lunch: '13:00',
  dinner: '18:20',
};

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

let override = null;

function parseClockInput(value) {
  // 接受 "2026-10-12T12:30" 或完整 ISO 字串；沒有時區時視為台北時間
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  const date = new Date(hasZone ? value : `${value}+08:00`);
  if (Number.isNaN(date.getTime())) throw new Error('時間格式錯誤');
  return date;
}

function setClock(value) {
  override = value ? parseClockInput(value) : null;
}

function getClock() {
  return override ? { simulated: true, at: override } : { simulated: false, at: new Date() };
}

// 回傳台北時間的 { date: 'YYYY-MM-DD', time: 'HH:mm' }
function taipeiNow() {
  const parts = Object.fromEntries(
    formatter.formatToParts(override || new Date()).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function isValidDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

module.exports = {
  MEAL_DEADLINES,
  setClock,
  getClock,
  taipeiNow,
  isValidDate,
  isValidTime,
};
