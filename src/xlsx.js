// .xlsx 讀寫（只用 fflate 解壓縮與 fast-xml-parser 解析 XML，沒有其他依賴）。
//
// 讀取：員工名單、菜單等「第一列是標題」的表格。支援 Excel／WPS／LibreOffice 常見的儲存方式：
//   共用字串、行內字串、公式的快取結果、日期格式（轉成 YYYY-MM-DD）、數字格式的員編。
// 寫出：每個欄位依型別輸出。文字一律存成「字串儲存格」，Excel 不會把它當公式執行，
//   員編欄另外套用「文字」格式，所以 012003 不會被吃成 12003。
//
// 安全：上傳檔案不可信。這裡限制檔案大小、解壓縮後大小、列數，並拒絕含 DOCTYPE／ENTITY 的 XML
// （xlsx 用不到，用來防止 XML 實體膨脹攻擊）。

const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');
const { XMLParser } = require('fast-xml-parser');
const { AppError } = require('./service');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_ROWS = 100000;
const MAX_COLS = 500;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------- 讀取 ----------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  textNodeName: '#text',
  htmlEntities: true, // 解碼 &#37096; 這類數字字元參照（openpyxl、部分匯出工具會這樣寫中文）
  isArray: (name) => ['row', 'c', 'si', 'r', 't', 'sheet', 'Relationship', 'xf', 'numFmt'].includes(name),
});

function parseXml(bytes, label) {
  const text = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new AppError(400, `檔案內容不安全（${label} 含有不允許的 XML 宣告），已拒絕`);
  }
  try {
    return parser.parse(text);
  } catch (_) {
    throw new AppError(400, `檔案已損毀，無法解析（${label}）`);
  }
}

const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const textOf = (node) => {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  return node['#text'] === undefined ? '' : String(node['#text']);
};

// 共用字串／行內字串：可能是單一 <t>，也可能是多段 <r><t>（格式化文字）；略過注音 <rPh>
function richText(si) {
  if (si === undefined || si === null) return '';
  if (typeof si === 'string') return si;
  const direct = toArray(si.t).map(textOf).join('');
  const runs = toArray(si.r).map((r) => toArray(r.t).map(textOf).join('')).join('');
  return direct + runs;
}

function colIndex(ref) {
  const m = /^([A-Za-z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function isDateFormatCode(code) {
  const stripped = String(code || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[ymdhs]/i.test(stripped) && !/^general$/i.test(stripped.trim());
}

function dateStyleSet(stylesBytes) {
  const set = new Set();
  if (!stylesBytes) return set;
  const sheet = parseXml(stylesBytes, 'styles.xml').styleSheet || {};
  const custom = new Map(toArray(sheet.numFmts && sheet.numFmts.numFmt).map((n) => [Number(n['@_numFmtId']), n['@_formatCode']]));
  toArray(sheet.cellXfs && sheet.cellXfs.xf).forEach((xf, index) => {
    const id = Number(xf['@_numFmtId'] || 0);
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id)))) set.add(index);
  });
  return set;
}

// Excel 的日期是「從 1899-12-30 起算的天數」（1904 系統是從 1904-01-01 起算）
function serialToText(serial, date1904) {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + Math.floor(serial) * 86400000 + Math.round((serial % 1) * 1440) * 60000);
  const iso = d.toISOString();
  if (Number.isInteger(serial)) return iso.slice(0, 10);
  return serial < 1 ? iso.slice(11, 16) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function cellValue(c, shared, dateStyles, date1904) {
  const type = c['@_t'];
  if (type === 'inlineStr') return richText(c.is);
  const raw = c.v === undefined ? '' : textOf(c.v);
  if (raw === '') return null;
  if (type === 's') return shared[Number(raw)] === undefined ? '' : shared[Number(raw)];
  if (type === 'str') return raw;
  if (type === 'b') return raw === '1' || raw.toLowerCase() === 'true';
  if (type === 'e') return null;
  if (type === 'd') return raw.slice(0, 10);
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (dateStyles.has(Number(c['@_s']))) return serialToText(n, date1904);
  return n;
}

function normalizeTarget(target) {
  const t = String(target || '');
  if (t.startsWith('/')) return t.slice(1);
  const parts = `xl/${t}`.split('/');
  const out = [];
  parts.forEach((p) => {
    if (p === '..') out.pop();
    else if (p !== '.') out.push(p);
  });
  return out.join('/');
}

function unzipSelected(bytes, wanted) {
  try {
    return unzipSync(bytes, {
      filter(file) {
        if (!wanted(file.name)) return false;
        if (file.originalSize > MAX_ENTRY_BYTES) throw new AppError(400, '檔案解壓縮後過大，已拒絕');
        return true;
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(400, '無法解開檔案，可能已損毀或有密碼保護');
  }
}

// 讀取第一個（或指定名稱的）工作表。回傳 { sheetName, sheetNames, rows }。
// rows 是二維陣列，索引與 Excel 列號對齊（rows[0] = 第 1 列），空白儲存格為 null。
function readXlsx(buffer, { sheet, prefer = [] } = {}) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw new AppError(400, '沒有收到檔案內容');
  if (buffer.length === 0) throw new AppError(400, '檔案是空的');
  if (buffer.length > MAX_FILE_BYTES) throw new AppError(400, '檔案過大（上限 10 MB）');
  const bytes = new Uint8Array(buffer);

  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new AppError(400, '不支援舊版 .xls 或有密碼保護的檔案，請另存為 .xlsx（Excel 活頁簿）後再上傳');
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new AppError(400, '這不是有效的 .xlsx 檔案');

  const base = unzipSelected(bytes, (name) => ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml'].includes(name));
  if (!base['xl/workbook.xml']) throw new AppError(400, '這不是有效的 Excel 活頁簿（找不到 workbook.xml）');

  const workbook = parseXml(base['xl/workbook.xml'], 'workbook.xml').workbook || {};
  const sheets = toArray(workbook.sheets && workbook.sheets.sheet).map((s) => ({
    name: s['@_name'], rid: s['@_id'], hidden: s['@_state'] === 'hidden' || s['@_state'] === 'veryHidden',
  }));
  if (sheets.length === 0) throw new AppError(400, '活頁簿裡沒有工作表');
  // 指定名稱 > 偏好名稱（例如「員工名單」）> 第一個可見的工作表
  const target = sheet
    ? sheets.find((s) => s.name === sheet)
    : sheets.find((s) => prefer.includes(s.name) && !s.hidden) || sheets.find((s) => !s.hidden) || sheets[0];
  if (!target) throw new AppError(400, `找不到工作表「${sheet}」`);

  const rels = base['xl/_rels/workbook.xml.rels']
    ? toArray(parseXml(base['xl/_rels/workbook.xml.rels'], 'workbook.xml.rels').Relationships.Relationship)
    : [];
  const rel = rels.find((r) => r['@_Id'] === target.rid);
  const sheetPath = rel ? normalizeTarget(rel['@_Target']) : `xl/worksheets/sheet${sheets.indexOf(target) + 1}.xml`;

  const sheetFiles = unzipSelected(bytes, (name) => name === sheetPath);
  if (!sheetFiles[sheetPath]) throw new AppError(400, '找不到工作表內容，檔案可能已損毀');

  const shared = base['xl/sharedStrings.xml']
    ? toArray((parseXml(base['xl/sharedStrings.xml'], 'sharedStrings.xml').sst || {}).si).map(richText)
    : [];
  const dateStyles = dateStyleSet(base['xl/styles.xml']);
  const date1904 = Boolean(workbook.workbookPr) && ['1', 'true'].includes(String(workbook.workbookPr['@_date1904']));

  const worksheet = parseXml(sheetFiles[sheetPath], 'worksheet').worksheet || {};
  const sparse = [];
  let runningRow = 0;
  toArray(worksheet.sheetData && worksheet.sheetData.row).forEach((row) => {
    const rowIndex = row['@_r'] ? Number(row['@_r']) - 1 : runningRow;
    runningRow = rowIndex + 1;
    if (!(rowIndex >= 0) || rowIndex >= MAX_ROWS) throw new AppError(400, `資料列數過多（上限 ${MAX_ROWS} 列）`);
    const cells = [];
    let col = 0;
    toArray(row.c).forEach((c) => {
      const fromRef = colIndex(c['@_r']);
      col = fromRef >= 0 ? fromRef : col;
      if (col < MAX_COLS) cells[col] = cellValue(c, shared, dateStyles, date1904);
      col += 1;
    });
    sparse[rowIndex] = cells;
  });

  const rows = Array.from(sparse, (r) => (r ? Array.from(r, (v) => (v === undefined ? null : v)) : []));
  while (rows.length > 0 && rows[rows.length - 1].every((v) => v === null || v === '')) rows.pop();
  return { sheetName: target.name, sheetNames: sheets.map((s) => s.name), rows };
}

// ---------- 寫出 ----------

const xmlEscape = (value) => String(value)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // XML 不允許的控制字元
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

function colLetters(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// 儲存格樣式索引（對應下面 styles.xml 的 cellXfs）
const STYLE = { normal: 0, header: 1, text: 2, int: 3, bold: 4, boldInt: 5 };

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF4"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function safeSheetName(name, used) {
  let base = String(name).replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` ${n}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function cellXml(ref, value, style) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  // 一律輸出為字串儲存格：以 = + - @ 開頭的內容也只會被當成文字，不會被執行
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

// sheets: [{ name, columns: [{ header, width?, text?, int? }], rows: [[...] | { bold, cells }] }]
//   text：此欄一律當文字（員編、電話等不可被轉成數字）；int：數字用千分位格式
function buildXlsx(sheets) {
  const usedNames = new Set();
  const named = sheets.map((s) => ({ ...s, name: safeSheetName(s.name, usedNames) }));

  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
  named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
  named.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
  named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
}<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': STYLES_XML,
  };

  named.forEach((sheet, i) => {
    const { columns } = sheet;
    const colsXml = columns.some((c) => c.width)
      ? `<cols>${columns.map((c, ci) => `<col min="${ci + 1}" max="${ci + 1}" width="${c.width || 12}" customWidth="1"/>`).join('')}</cols>`
      : '';

    const headerRow = `<row r="1">${columns.map((c, ci) => cellXml(`${colLetters(ci)}1`, c.header, STYLE.header)).join('')}</row>`;
    const bodyRows = sheet.rows.map((item, ri) => {
      const cells = Array.isArray(item) ? item : item.cells;
      const bold = !Array.isArray(item) && item.bold;
      const rowNumber = ri + 2;
      return `<row r="${rowNumber}">${cells.map((value, ci) => {
        const col = columns[ci] || {};
        let style = STYLE.normal;
        if (typeof value === 'number') style = bold ? STYLE.boldInt : (col.int ? STYLE.int : STYLE.normal);
        else if (col.text) style = STYLE.text;
        else if (bold) style = STYLE.bold;
        return cellXml(`${colLetters(ci)}${rowNumber}`, value, style);
      }).join('')}</row>`;
    }).join('');

    const lastRow = sheet.rows.length + 1;
    const lastCol = colLetters(Math.max(columns.length - 1, 0));
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastCol}${lastRow}"/><sheetViews><sheetView workbookViewId="0"${i === 0 ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${colsXml}<sheetData>${headerRow}${bodyRows}</sheetData>${sheet.rows.length > 0 ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>` : ''}</worksheet>`;
  });

  const zipInput = {};
  Object.entries(files).forEach(([name, content]) => {
    zipInput[name] = strToU8(content);
  });
  return Buffer.from(zipSync(zipInput, { level: 6 }));
}

module.exports = { readXlsx, buildXlsx, XLSX_MIME, MAX_FILE_BYTES, serialToText };
