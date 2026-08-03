/**
 * DataSync 的本機回歸測試 —— 用 Node 模擬 Apps Script API，
 * 餵入從實際試算表擷取的標題列與末幾列資料。
 *
 * 執行：node test_datasync.cjs
 *
 * ⚠️ 副檔名刻意用 .cjs：.clasp.json 的 scriptExtensions 含 .js，
 *    叫 .js 會被 clasp push 當成 GAS 原始碼一起推上去。
 */
const fs = require('fs');
const path = require('path');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasync_fixture.data'), 'utf8'));

// ─── Apps Script mock ────────────────────────────────────────────
function pad(v, n) { const a = v.slice(); while (a.length < n) a.push(''); return a; }

class Sheet {
  constructor(name, rows) {
    this.name = name;
    this.rows = rows.map(r => r.slice());
    this.width = Math.max(...this.rows.map(r => r.length));
    this.rows = this.rows.map(r => pad(r, this.width));
  }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i--)
      if (this.rows[i].some(v => v !== '' && v !== null && v !== undefined)) return i + 1;
    return 0;
  }
  getLastColumn() {
    let last = 0;
    this.rows.forEach(r => r.forEach((v, j) => {
      if (v !== '' && v !== null && v !== undefined) last = Math.max(last, j + 1);
    }));
    return last;
  }
  _ensure(row) {
    while (this.rows.length < row) this.rows.push(pad([], this.width));
  }
  getRange(a, b, nr, nc) {
    if (typeof a === 'string') {
      const m = a.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/) || a.match(/^([A-Z]+)(\d+)$/);
      const L = s => s.split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
      if (m.length === 5) { b = L(m[1]); a = +m[2]; nr = +m[4] - +m[2] + 1; nc = L(m[3]) - L(m[1]) + 1; }
      else { b = L(m[1]); a = +m[2]; nr = 1; nc = 1; }
    }
    nr = nr || 1; nc = nc || 1;
    const self = this;
    return {
      getValues() {
        self._ensure(a + nr - 1);
        const out = [];
        for (let i = 0; i < nr; i++) out.push(pad(self.rows[a + i - 1], b + nc - 1).slice(b - 1, b - 1 + nc));
        return out;
      },
      getValue() { return this.getValues()[0][0]; },
      getDisplayValues() { return this.getValues().map(r => r.map(v => String(v === null || v === undefined ? '' : v))); },
      setValues(vals) {
        self._ensure(a + nr - 1);
        self.width = Math.max(self.width, b + nc - 1);
        for (let i = 0; i < nr; i++) {
          self.rows[a + i - 1] = pad(self.rows[a + i - 1], self.width);
          for (let j = 0; j < nc; j++) self.rows[a + i - 1][b + j - 1] = vals[i][j];
        }
      },
      setValue(v) { this.setValues([[v]]); }
    };
  }
  insertColumnBefore(pos) {
    this.width++;
    this.rows = this.rows.map(r => { const a = pad(r, this.width - 1); a.splice(pos - 1, 0, ''); return a; });
    this.inserted = (this.inserted || []).concat(pos);
  }
}

class SS {
  constructor(sheets) { this.sheets = sheets; }
  getSheetByName(n) { return this.sheets[n] || null; }
  getSpreadsheetTimeZone() { return 'Asia/Taipei'; }
}

let NOW = new Date('2026-08-03T18:00:00+08:00');
global.SpreadsheetApp = { openById: () => global.__SS };
global.Utilities = {
  formatDate(d, tz, fmt) {
    const p = n => String(n).padStart(2, '0');
    // 測試環境固定 +8
    const t = new Date(d.getTime() + 8 * 3600e3);
    return fmt.replace('yyyy', t.getUTCFullYear())
              .replace('MM', p(t.getUTCMonth() + 1))
              .replace('dd', p(t.getUTCDate()));
  }
};
global.Config = { SHEET_ID: 'x' };
const logs = [];
global.Logger = {
  info: (t, m, d) => logs.push(['INFO', t, m, d]),
  warning: (t, m, d) => logs.push(['WARN', t, m, d]),
  error: (t, m, d) => logs.push(['ERROR', t, m, d])
};
const _RealDate = Date;
global.Date = class extends _RealDate {
  constructor(...a) { return a.length ? new _RealDate(...a) : new _RealDate(NOW); }
};
global.Date.now = _RealDate.now;

eval(fs.readFileSync(__dirname + '/DataSync.gs', 'utf8').replace(/^function setData[\s\S]*$/m, ''));

// ─── 測試工具 ────────────────────────────────────────────────────
function build({ extraStock, panelRows } = {}) {
  const stocks = fixture.stocks.map(r => r.slice());
  if (extraStock) stocks.push(extraStock);
  return new SS({
    '@所有股票紀錄': new Sheet('rec', fixture.record),
    '所有股票': new Sheet('st', stocks),
    '面板': new Sheet('pn', panelRows || fixture.panel)
  });
}
// 期望值一律從 fixture 推導。⚠️ 不要把真實金額寫回這個檔案 —— 它會進 GitHub，
// fixture 不會（見 .gitignore）。
const REC_HDR     = fixture.record[0].filter(v => v !== '');
const HOLDINGS    = fixture.stocks.slice(2).map(r => ({ code: r[0], name: r[1], price: r[6] }));
const CASH        = fixture.panel.map(r => ({ label: r[4], value: r[5] })).filter(x => x.label !== '');
const HIST_LAST   = fixture.record[fixture.record.length - 1];
const NEXT_ROW    = fixture.record.length + 1;      // fixture 只保留末幾列
const I_STOCKSUM  = REC_HDR.indexOf('股票總價值');  // 0-based
const I_LASTCASH  = REC_HDR.length - 1;             // 黃金那一欄
const COL = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const SUM = (from, to) => '=SUM(' + COL(from) + NEXT_ROW + ':' + COL(to) + NEXT_ROW + ')';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}

// ─── T1：現況（8 檔），不應插欄，且應 append ──────────────────────
console.log('\nT1  現況 8 檔，隔天執行');
global.__SS = build();
let r = DataSync.run();
let rec = global.__SS.getSheetByName('@所有股票紀錄');
let hdr = rec.rows[0].filter(v => v !== '');
check('沒有插入任何欄位', (rec.inserted || []).length === 0, JSON.stringify(rec.inserted));
check('標題列最後補上「狀態」', hdr.length === REC_HDR.length + 1 && hdr[hdr.length - 1] === '狀態', hdr.join('|'));
check('是 append 不是 overwrite', r.mode === 'append', r.mode);
check('寫在最後一列之後', r.row === NEXT_ROW, String(r.row));
let written = rec.rows[r.row - 1];
check('日期 = 2026-08-03', written[0] === '2026-08-03', String(written[0]));
check('B 欄合計公式涵蓋 股票總價值→最後一個現金帳戶',
  written[1] === SUM(I_STOCKSUM + 1, I_LASTCASH + 1), String(written[1]));
check('第一檔持股的價格寫進它自己的欄位',
  written[hdr.indexOf(HOLDINGS[0].name)] === HOLDINGS[0].price, String(written[2]));
check('最後一個現金帳戶寫在狀態的前一欄',
  written[I_LASTCASH] === CASH[CASH.length - 1].value, String(written[I_LASTCASH]));
check('狀態 = 資料未更新（週一但股價與前日相同）', written[REC_HDR.length] === '資料未更新', String(written[REC_HDR.length]));

// ─── T2：加入 009826，應在「股票總價值」前插一欄 ─────────────────
console.log('\nT2  加入第 9 檔 009826（8/3 掛牌）');
global.__SS = build({ extraStock: ['009826', '貝萊德世界股票', '指數投資', 0, 1000, 50000, 51.2] });
r = DataSync.run();
rec = global.__SS.getSheetByName('@所有股票紀錄');
hdr = rec.rows[0].filter(v => v !== '');
check('插入了 1 欄', (rec.inserted || []).length === 1, JSON.stringify(rec.inserted));
check('插在原本 股票總價值 的位置', (rec.inserted || [])[0] === I_STOCKSUM + 1, JSON.stringify(rec.inserted));
check('新持股排在 股票總價值 之前',
  hdr[I_STOCKSUM] === '貝萊德世界股票' && hdr[I_STOCKSUM + 1] === '股票總價值',
  hdr.slice(I_STOCKSUM - 1, I_STOCKSUM + 3).join('|'));
check('現金區整段右移一欄，狀態仍在最後',
  hdr[I_LASTCASH + 1] === REC_HDR[I_LASTCASH] && hdr[hdr.length - 1] === '狀態', hdr.slice(-3).join('|'));
written = rec.rows[r.row - 1];
check('B 欄合計公式跟著右移一欄',
  written[1] === SUM(I_STOCKSUM + 2, I_LASTCASH + 2), String(written[1]));
check('新持股的價格寫進新插的那一欄', written[I_STOCKSUM] === 51.2, String(written[I_STOCKSUM]));
check('最後一個現金帳戶的值跟著搬到新位置',
  written[I_LASTCASH + 1] === CASH[CASH.length - 1].value, String(written[I_LASTCASH + 1]));
// 歷史列：插入處變空白，其餘不動
let hist = rec.rows[fixture.record.length - 1];   // fixture 的最後一筆歷史
check('歷史列的新持股欄留空（當時沒持有）', hist[I_STOCKSUM] === '', JSON.stringify(hist[I_STOCKSUM]));
check('歷史列原有的值沒被動到', hist[I_LASTCASH + 1] === HIST_LAST[I_LASTCASH], String(hist[I_LASTCASH + 1]));

// ─── T3：同日重跑應覆寫 ──────────────────────────────────────────
console.log('\nT3  同一天重複執行');
global.__SS = build();
DataSync.run();
rec = global.__SS.getSheetByName('@所有股票紀錄');
const after1 = rec.getLastRow();
r = DataSync.run();
check('第二次是 overwrite', r.mode === 'overwrite', r.mode);
check('列數沒有增加', rec.getLastRow() === after1, rec.getLastRow() + ' vs ' + after1);

// ─── T4：週末標記休市 ────────────────────────────────────────────
console.log('\nT4  週六執行');
NOW = new _RealDate('2026-08-08T18:00:00+08:00');
global.__SS = build();
r = DataSync.run();
check('狀態 = 休市', r.status === '休市', r.status);

// ─── T5：報價全滅不寫入 ──────────────────────────────────────────
console.log('\nT5  GOOGLEFINANCE 全數失效');
NOW = new _RealDate('2026-08-03T18:00:00+08:00');
const broken = fixture.stocks.map(r2 => r2.slice());
for (let i = 2; i < broken.length; i++) broken[i][6] = '#N/A';
global.__SS = new SS({
  '@所有股票紀錄': new Sheet('rec', fixture.record),
  '所有股票': new Sheet('st', broken),
  '面板': new Sheet('pn', fixture.panel)
});
const before = global.__SS.getSheetByName('@所有股票紀錄').getLastRow();
r = DataSync.run();
check('拒絕寫入', r.ok === false, JSON.stringify(r));
check('沒有多長一列', global.__SS.getSheetByName('@所有股票紀錄').getLastRow() === before);

// ─── T6：部分報價失效 → 標記報價異常，該欄留空 ───────────────────
console.log('\nT6  單檔報價失效');
const BAD = 2;                       // 第三檔持股
const partial = fixture.stocks.map(r2 => r2.slice());
partial[2 + BAD][6] = '#N/A';
global.__SS = new SS({
  '@所有股票紀錄': new Sheet('rec', fixture.record),
  '所有股票': new Sheet('st', partial),
  '面板': new Sheet('pn', fixture.panel)
});
r = DataSync.run();
rec = global.__SS.getSheetByName('@所有股票紀錄');
written = rec.rows[r.row - 1];
check('狀態 = 報價異常', r.status === '報價異常', r.status);
check('該檔欄位留空而非 0 或 #N/A', written[hdr.indexOf(HOLDINGS[BAD].name)] === '', JSON.stringify(written[4]));
check('其他檔照常寫入', written[hdr.indexOf(HOLDINGS[0].name)] === HOLDINGS[0].price, String(written[2]));

// ─── T7：新增現金帳戶 ────────────────────────────────────────────
console.log('\nT7  面板新增一個現金帳戶');
const panel2 = fixture.panel.map(r2 => r2.slice());
const RENAMED = CASH[4].label;                       // 覆蓋既有帳戶名 → 視為新帳戶
panel2[4][4] = '玉山現金戶'; panel2[4][5] = 200000;
global.__SS = build({ panelRows: panel2 });
r = DataSync.run();
rec = global.__SS.getSheetByName('@所有股票紀錄');
hdr = rec.rows[0].filter(v => v !== '');
check('新帳戶插在「狀態」之前', hdr[hdr.length - 1] === '狀態' && hdr.includes('玉山現金戶'), hdr.slice(-4).join('|'));
check('被改掉的舊帳戶欄位保留未刪', hdr.includes(RENAMED), hdr.join('|'));

// ─── T8：標題列缺錨點應丟例外 ────────────────────────────────────
console.log('\nT8  標題列缺少「股票總價值」錨點');
const badHdr = fixture.record.map(r2 => r2.slice());
badHdr[0][10] = '亂改的欄名';
global.__SS = new SS({
  '@所有股票紀錄': new Sheet('rec', badHdr),
  '所有股票': new Sheet('st', fixture.stocks),
  '面板': new Sheet('pn', fixture.panel)
});
let threw = false;
try { DataSync.run(); } catch (e) { threw = /股票總價值/.test(e.message); }
check('丟出例外而不是寫壞資料', threw);

// ─── T9：dryRun 不得寫入任何東西（含標題列）────────────────────
console.log('\nT9  dryRun 有新持股時仍不可動到試算表');
global.__SS = build({ extraStock: ['009826', '貝萊德世界股票', '指數投資', 0, 1000, 50000, 51.2] });
rec = global.__SS.getSheetByName('@所有股票紀錄');
const snapshot = JSON.stringify(rec.rows);
r = DataSync.run({ dryRun: true });
check('沒有真的插欄', (rec.inserted || []).length === 0, JSON.stringify(rec.inserted));
check('試算表內容完全沒變', JSON.stringify(rec.rows) === snapshot);
check('但仍預告會插入的欄位', r.headerInserted.length === 2, JSON.stringify(r.headerInserted));
check('預覽用的是模擬後的標題列（含新持股）',
  /貝萊德世界股票=51.2/.test(r.preview) && /狀態=/.test(r.preview), r.preview);
check('預覽的合計公式已對齊模擬欄位', /=SUM\(L\d+:T\d+\)/.test(r.preview),
  (r.preview.match(/=SUM\([^)]*\)/) || [])[0]);

console.log('\n' + (fail === 0 ? '全部通過' : fail + ' 項失敗') + '（' + pass + '/' + (pass + fail) + '）');
process.exit(fail === 0 ? 0 : 1);
