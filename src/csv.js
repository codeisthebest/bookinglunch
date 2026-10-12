// 簡易 CSV 解析（支援引號包住的欄位與 BOM）。匯入員工名單與報表匯出使用。

function parseCsv(text) {
  const source = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

function toCsv(rows) {
  const escape = (value) => {
    let s = value === null || value === undefined ? '' : String(value);
    // 公式注入防護：字串以 = + - @ 或定位字元開頭時，Excel 會把它當公式執行，前面補一個單引號讓它只是文字
    // （數字型別不處理，所以負數金額不受影響）
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(escape).join(',')).join('\r\n');
}

module.exports = { parseCsv, toCsv };
