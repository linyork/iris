/**
 * 「資產管理」試算表的本機回歸測試。
 *
 * 用 Node 模擬 Apps Script（含一個小型公式求值器），拿舊試算表的**真實資料**
 * 跑完整流程：建表 → 遷移 → 重算 → 對帳，並驗證新表算出來的數字與舊表一致。
 *
 * 執行：node test_asset.cjs
 *
 * ⚠️ 副檔名用 .cjs：.clasp.json 的 scriptExtensions 含 .js，
 *    叫 .js 會被 clasp push 當成 GAS 原始碼推上去。
 */
const fs = require('fs');
const path = require('path');
// 副檔名不用 .json：.clasp.json 的 jsonExtensions 含 .json，會被 clasp push 推上 GAS
const LEGACY = JSON.parse(fs.readFileSync(path.join(__dirname, 'legacy_fixture.data'), 'utf8'));

// ═══ 期望值與假報價，一律從 fixture 推導 ═════════════════════════
//
// ⚠️ 真實金額不可以寫進這個檔案 —— 它會進 GitHub，fixture 不會（見 .gitignore）。
//    要驗證的是「新表算出來 == 舊表本來就有的數字」，所以兩邊都從 fixture 取，
//    寫死反而讓斷言和資料脫鉤。
const L_STOCK = LEGACY['所有股票'];
const L_PANEL = LEGACY['面板'];
const L_ALLOC = LEGACY['配置'];

const HOLD = L_STOCK.slice(2).map(r => ({
  code: String(r[0]), name: r[1], shares: +r[4], cost: +r[5], price: +r[6], dividend: +r[10]
}));
const H0 = HOLD[0];                       // 拿來跑細節斷言的那一檔

const EXP = {
  totalCost:      +L_PANEL[0][1],         // 面板 B1
  unrealized:     +L_PANEL[1][1],         // 面板 B2 收益
  stockValue:     +L_PANEL[2][1],         // 面板 B3 總價值
  totalAssets:    +L_PANEL[3][3],         // 面板 D4 總資產
  legacyDividend: +L_STOCK[1][10],        // 舊表「總股利」（只 SUMIF 到現有持股）
  dividendAll:    LEGACY['@股利'].slice(1).reduce((a, r) => a + (+r[2] || 0), 0),
  cash:           L_PANEL.map(r => ({ label: r[4], value: +r[5], origin: +r[6], fx: +r[7] })).filter(x => x.label),
  twValue:        L_ALLOC.slice(1).filter(r => r[4] === '台').reduce((a, r) => a + (+r[3] || 0), 0)
};
const GOLD = EXP.cash[EXP.cash.length - 1];

// 用舊表當天的收盤價，新表算出來的市值才對得起舊表
const PRICES = {};
HOLD.forEach(h => { PRICES[h.code] = h.price; });
// XAUTWD 不是 Google Finance 認得的貨幣對，只有 XAUUSD 是 —— 台幣要自己乘。
// 這裡從舊表的每公克台幣價反推回每盎司美金價，讓假報價和真實 API 的形狀一致。
const FX = {
  USDTWD: +L_PANEL[2][7],
  JPYTWD: +L_PANEL[3][7],
  XAUUSD: (+L_PANEL[7][7] * 31.1035) / (+L_PANEL[2][7])
};

// ═══ Apps Script mock ════════════════════════════════════════════
const A1 = (c) => { let n = 0; for (const ch of c) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
const L1 = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const padTo = (a, n) => { const b = a.slice(); while (b.length < n) b.push(''); return b; };

class Sheet {
  constructor(name, rows = []) {
    this.name = name;
    this.rows = rows.map(r => r.slice());
    this.width = Math.max(1, ...this.rows.map(r => r.length));
    this.rows = this.rows.map(r => padTo(r, this.width));
    this.frozen = 0;
    this.formats = {};        // 1-based 欄號 → 數值格式
  }
  getMaxRows() { return Math.max(this.rows.length, 1000); }
  getMaxColumns() { return this.width; }
  getFrozenRows() { return this.frozen; }
  /**
   * 模擬 Sheets 寫入時的型別轉換：看起來像整數的字串會被存成數字，
   * 除非該欄的格式是純文字 '@'。台股代號 '0056' 就是這樣變成 56 的。
   */
  _coerce(v, col) {
    if (typeof v !== 'string' || this.formats[col] === '@') return v;
    return /^\d+$/.test(v) ? Number(v) : v;
  }
  _grow(row, col) {
    this.width = Math.max(this.width, col);
    while (this.rows.length < row) this.rows.push([]);
    this.rows = this.rows.map(r => padTo(r, this.width));
  }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i--)
      if (this.rows[i].some(v => v !== '' && v !== null && v !== undefined)) return i + 1;
    return 0;
  }
  /**
   * 資產層一律走 getRange().setValues()，所以這個 mock 本來沒有 appendRow ——
   * 但系統層（AlertLog / AdviceLog / GoogleSheet 的記憶與日誌）用的是它。
   * 少了它的症狀是那些模組**安靜地回失敗**：它們都包在 try/catch 裡，
   * 例外被吞掉，測試只看到「寫入回傳 false」而看不出原因。
   */
  appendRow(values) {
    const r = this.getLastRow() + 1;
    this._grow(r, values.length);
    values.forEach((v, i) => { this.rows[r - 1][i] = this._coerce(v, i + 1); });
    EVAL.reset();
    return this;
  }
  getLastColumn() {
    let last = 0;
    this.rows.forEach(r => r.forEach((v, j) => { if (v !== '' && v !== null && v !== undefined) last = Math.max(last, j + 1); }));
    return last;
  }
  getRange(a, b, nr, nc) {
    if (typeof a === 'string') {
      let m = a.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if (m) { b = A1(m[1]); nc = A1(m[3]) - b + 1; a = +m[2]; nr = +m[4] - a + 1; }
      else { m = a.match(/^([A-Z]+)(\d+)$/); b = A1(m[1]); a = +m[2]; nr = 1; nc = 1; }
    }
    nr = nr || 1; nc = nc || 1;
    const self = this;
    const api = {
      getValues() {
        self._grow(a + nr - 1, b + nc - 1);
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = [];
          for (let j = 0; j < nc; j++) row.push(EVAL.cell(self, a + i, b + j));
          out.push(row);
        }
        return out;
      },
      getValue() { return api.getValues()[0][0]; },
      getDisplayValues() { return api.getValues().map(r => r.map(v => String(v == null ? '' : v))); },
      setValues(vals) {
        self._grow(a + nr - 1, b + nc - 1);
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) {
          self.rows[a + i - 1][b + j - 1] = self._coerce(vals[i][j], b + j);
        }
        EVAL.reset();
      },
      setNumberFormat(fmt) {
        for (let j = 0; j < nc; j++) self.formats[b + j] = fmt;
        return api;
      },
      setFormulas(vals) { return api.setValues(vals); },
      setFormula(v) { return api.setValues([[v]]); },
      setValue(v) { return api.setValues([[v]]); },
      clearContent() {
        self._grow(a + nr - 1, b + nc - 1);
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) self.rows[a + i - 1][b + j - 1] = '';
        EVAL.reset();
      },
      setFontWeight() { return api; }
    };
    return api;
  }
  getName() { return this.name; }
  setFrozenRows(n) { this.frozen = n; }
  setFrozenColumns() { }
  clear() { this.rows = []; this.width = 1; this.formats = {}; EVAL.reset(); }
  clearNotes() { }
  deleteRow(r) { this.rows.splice(r - 1, 1); EVAL.reset(); }
  deleteRows(r, n) { this.rows.splice(r - 1, n); EVAL.reset(); }
  /** 取原始儲存格內容（不求值） */
  raw(row, col) { const r = this.rows[row - 1]; return r ? (r[col - 1] === undefined ? '' : r[col - 1]) : ''; }
}

class SS {
  constructor(id) { this.id = id; this.sheets = []; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  getSheets() { return this.sheets.slice(); }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
  getSpreadsheetTimeZone() { return 'Asia/Taipei'; }
}

// ═══ 公式求值器 ═══════════════════════════════════════════════════
// 只支援本專案實際產生的那些公式；不是通用試算表引擎。
const EVAL = {
  memo: new Map(),
  stack: new Set(),
  reset() { this.memo.clear(); },
  cell(sheet, row, col) {
    const raw = sheet.raw(row, col);
    if (typeof raw !== 'string' || raw.charAt(0) !== '=') return raw;
    const key = sheet.name + '!' + col + ':' + row;
    if (this.memo.has(key)) return this.memo.get(key);
    if (this.stack.has(key)) return 0;               // 循環參照
    this.stack.add(key);
    let v;
    try { v = evalFormula(raw.slice(1), sheet, row); }
    catch (e) { v = '#ERR:' + e.message; }
    this.stack.delete(key);
    this.memo.set(key, v);
    return v;
  }
};

const NA = Symbol('NA');
const isErr = (v) => v === NA || (typeof v === 'number' && !isFinite(v)) || (typeof v === 'string' && v.startsWith('#'));
const num = (v) => {
  if (v === NA || v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/[,$%]/g, ''));
  return isNaN(n) ? 0 : n;
};

function evalFormula(src, sheet, row) {
  const F = {
    IF: (c, a, b) => (c ? a : (b === undefined ? false : b)),
    IFS: (...a) => { for (let i = 0; i < a.length; i += 2) if (a[i]) return a[i + 1]; return NA; },
    OR: (...a) => a.some(Boolean),
    AND: (...a) => a.every(Boolean),
    IFERROR: (a, b) => (isErr(a) ? (b === undefined ? '' : b) : a),
    N: (v) => num(v),
    SUM: (...a) => a.flat(Infinity).reduce((s, v) => s + num(v), 0),
    SUMIF: (range, crit, sumRange) => {
      const r = range.flat(Infinity), s = (sumRange || range).flat(Infinity);
      let t = 0;
      for (let i = 0; i < r.length; i++) if (String(r[i]) === String(crit)) t += num(s[i]);
      return t;
    },
    VLOOKUP: (key, table, idx) => {
      for (const r of table) if (String(r[0]) === String(key)) return r[idx - 1];
      return NA;
    },
    GOOGLEFINANCE: (q) => {
      const s = String(q);
      let m = s.match(/^CURRENCY:(\w{3})(\w{3})$/);
      if (m) return FX[m[1] + m[2]] !== undefined ? FX[m[1] + m[2]] : NA;
      m = s.match(/^[A-Z]+:(.+)$/);
      if (m && PRICES[m[1]] !== undefined) return PRICES[m[1]];
      return NA;
    },
    // GOOGLEFINANCE 在夾具裡對所有現存持股都查得到，所以 IFERROR 的第一分支
    // 永遠會贏 —— 底下這五個只需要「不丟例外」，TWSE 那條備援路徑本身的語意
    // 對測試沒有影響，本機也沒有網路可以真的打 TWSE。
    ISNUMBER: (v) => typeof v === 'number' && isFinite(v),
    TODAY: () => new Date(),
    TEXT: (v) => String(v),
    IMPORTDATA: () => NA,
    CONCATENATE: (...a) => a.flat(Infinity).map(v => (v === NA ? '' : String(v))).join(''),
    REGEXEXTRACT: () => NA,
    VALUE: (v) => (v === NA ? NA : num(v)),
    // 範圍與儲存格存取
    _R1: (sheetName, colLetter, fromRow) => {
      const sh = sheetName ? CURRENT_SS.getSheetByName(sheetName) : sheet;
      if (!sh) return [];
      const c = A1(colLetter), out = [];
      for (let r = fromRow || 1; r <= Math.max(sh.getLastRow(), 1); r++) out.push(EVAL.cell(sh, r, c));
      return out;
    },
    _R2: (sheetName, c1, c2) => {
      const sh = sheetName ? CURRENT_SS.getSheetByName(sheetName) : sheet;
      if (!sh) return [];
      const a = A1(c1), b = A1(c2), out = [];
      for (let r = 1; r <= Math.max(sh.getLastRow(), 1); r++) {
        const line = [];
        for (let c = a; c <= b; c++) line.push(EVAL.cell(sh, r, c));
        out.push(line);
      }
      return out;
    },
    _C: (sheetName, colLetter, r) => {
      const sh = sheetName ? CURRENT_SS.getSheetByName(sheetName) : sheet;
      return sh ? EVAL.cell(sh, r, A1(colLetter)) : '';
    }
  };

  // ── 轉成 JS 運算式 ──
  // 先把字串常值抽走，否則 "CURRENCY:XAUTWD" 會被當成 A:B 範圍。
  // Sheets 的字串跳脫是連續兩個雙引號，不是反斜線，所以要用 (?:[^"]|"")*
  // 才吃得完整段 —— 單純 [^"]* 會在第一個 "" 就提早斷掉，把 REGEXEXTRACT 的
  // pattern 從中間切開。抽出來之後還要還原成真字元、再用 JSON.stringify 包成
  // 合法的 JS 字面值，否則 pattern 裡的反斜線會被 JS 自己的跳脫規則吃掉，
  // 組出來的運算式編譯不過。
  const lits = [];
  let js = src.replace(/"(?:[^"]|"")*"/g, m => {
    lits.push(JSON.stringify(m.slice(1, -1).replace(/""/g, '"')));
    return '' + (lits.length - 1) + '';
  });

  const SH = '(?:([\\u4e00-\\u9fa5A-Za-z_][\\u4e00-\\u9fa5\\w]*)!)?';
  // 兩欄範圍 A:B
  js = js.replace(new RegExp(SH + '\\$?([A-Z]+):\\$?([A-Z]+)(?![0-9])', 'g'),
    (_, sh, c1, c2) => `F._R2(${sh ? JSON.stringify(sh) : 'null'},"${c1}","${c2}")`);
  // 單欄自某列起 $I$2:$I
  js = js.replace(new RegExp(SH + '\\$?([A-Z]+)\\$?(\\d+):\\$?([A-Z]+)(?![0-9])', 'g'),
    (_, sh, c1, r1) => `F._R1(${sh ? JSON.stringify(sh) : 'null'},"${c1}",${r1})`);
  // 單一儲存格 $C2。前置的 lookbehind 是為了不去咬 F._R1 / F._R2 這種產物
  js = js.replace(new RegExp('(?<![\\w.$])' + SH + '\\$?([A-Z]{1,2})\\$?(\\d+)(?![\\w(])', 'g'),
    (_, sh, c, r) => `F._C(${sh ? JSON.stringify(sh) : 'null'},"${c}",${r})`);
  // 函式名
  js = js.replace(/\b(IFERROR|IFS|IF|OR|AND|SUMIF|SUM|VLOOKUP|GOOGLEFINANCE|ISNUMBER|TODAY|TEXT|IMPORTDATA|CONCATENATE|REGEXEXTRACT|VALUE|N)\(/g, 'F.$1(');
  // 比較運算子（& 是字串連接）
  js = js.replace(/<>/g, '!==').replace(/&/g, '+');
  js = js.replace(/([^<>!=])=([^=])/g, '$1==$2');
  js = js.replace(/\bTRUE\b/g, 'true').replace(/\bFALSE\b/g, 'false');

  js = js.replace(/(\d+)/g, (_, i) => lits[+i]);

  // eslint-disable-next-line no-new-func
  return new Function('F', 'return (' + js + ');')(F);
}

// ═══ 全域環境 ════════════════════════════════════════════════════
let CURRENT_SS = null;
const STORE = {};
let NOW = new Date('2026-08-03T18:00:00+08:00');

global.SpreadsheetApp = {
  openById(id) {
    if (!STORE[id]) { STORE[id] = new SS(id); }
    CURRENT_SS = STORE[id];
    return STORE[id];
  },
  flush() { EVAL.reset(); }
};
global.Utilities = {
  formatDate(d, tz, fmt) {
    const p = n => String(n).padStart(2, '0');
    const t = new Date(d.getTime() + 8 * 3600e3);
    return fmt.replace('yyyy', t.getUTCFullYear()).replace('MM', p(t.getUTCMonth() + 1))
      .replace('dd', p(t.getUTCDate())).replace('HH', p(t.getUTCHours()))
      .replace('mm', p(t.getUTCMinutes())).replace('ss', p(t.getUTCSeconds()));
  }
};
// AssetSchema.SHEET_ID 是指回這裡的 getter（正式環境讀指令碼屬性），
// 所以 mock 一定要在第一次讀取試算表之前就位。值本身是什麼不重要，
// 只要跟 LEGACY_SHEET_ID 不同、能當 STORE 的鍵就行。
global.Config = { SHEET_ID: 'assets' };
const LOGS = [];
global.Logger = {
  info: (...a) => LOGS.push(['INFO', ...a]),
  warning: (...a) => LOGS.push(['WARN', ...a]),
  error: (...a) => LOGS.push(['ERROR', ...a])
};
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(NOW); }
};
global.Date.now = RealDate.now;

// 用間接 eval 讓 .gs 的 var 宣告落在全域，跟 Apps Script 的平坦命名空間一致
const load = f => (0, eval)(fs.readFileSync(path.join(__dirname, f), 'utf8'));

// Utils 要在資產層之前 —— 真正寫進試算表的地方會叫 Utils.noteLedgerWrite()，
// 那是「模型說已記錄到底有沒有寫」的唯一證據，載真的比 stub 有意義（見 T27）
load('Utils.gs');
load('AssetSchema.gs');
load('Panel.gs');        // Position.rebuild() 最後會叫它重畫面板
load('Position.gs');
load('AssetMigrate.gs');
load('AssetTools.gs');
load('AssetImport.gs');
// Snapshot 需要 StockPrice（TWSE 即時報價），本機測試不打外網
global.StockPrice = { getRawPrices: () => [] };
load('Snapshot.gs');

// 用真實資料建好舊試算表
const legacySS = SpreadsheetApp.openById(AssetSchema.LEGACY_SHEET_ID);
Object.keys(LEGACY).forEach(name => { legacySS.sheets.push(new Sheet(name, LEGACY[name])); });

// ═══ 測試 ════════════════════════════════════════════════════════
let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (detail !== undefined ? '  → ' + detail : '')); }
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1 : tol);
// T6 用的賣出情境：賣價刻意設成比市價高 0.02，用來驗總資產的變動方向
const SELL_QTY = 3000, SELL_FEE = 21;
const SELL_PRICE = Math.round((HOLD[0].price + 0.02) * 100) / 100;
const money = n => Math.round(n).toLocaleString();

// ─── T1  加權平均成本與已實現損益（獨立單元）─────────────────────
console.log('\nT1  加權平均成本與已實現損益');
{
  const t = (日期, 動作, 代號, 股數, 單價, 手續費, 交易稅, 金額) =>
    ({ 日期, 動作, 代號, 股數, 單價, 手續費: 手續費 || 0, 交易稅: 交易稅 || 0, 金額: 金額 || '' });
  const r = Position.replay([
    t('2026-01-05', '買進', 'X', 1000, 10, 20),      // 成本 10,020
    t('2026-02-05', '買進', 'X', 1000, 20, 40),      // 成本 20,040 → 累計 30,060 / 2000 股 = 15.03
    t('2026-03-05', '賣出', 'X', 500, 25, 30, 40),   // 收 12,500-70=12,430；沖銷 500*15.03=7,515
    t('2026-04-05', '股利', 'X', '', '', 0, 0, 1234)
  ]);
  const p = r.positions['X'];
  check('剩餘股數 1500', p.shares === 1500, p.shares);
  check('賣出前均價 15.03', near(r.realized[0].avgBefore, 15.03, 1e-9), r.realized[0].avgBefore);
  check('沖銷成本 7,515', near(p.cost, 30060 - 7515, 1e-6) && near(r.realized[0].costOut, 7515, 1e-6), r.realized[0].costOut);
  check('賣出淨額 12,430', near(r.realized[0].proceeds, 12430, 1e-9), r.realized[0].proceeds);
  check('已實現損益 4,915', near(p.realized, 4915, 1e-6), p.realized);
  check('剩餘總成本 22,545', near(p.cost, 22545, 1e-6), p.cost);
  check('累計股利 1,234', p.dividend === 1234, p.dividend);

  // 出清後再買回，均價不該被舊部位污染
  const r2 = Position.replay([
    t('2026-01-01', '買進', 'Y', 100, 50),
    t('2026-02-01', '賣出', 'Y', 100, 60),
    t('2026-03-01', '買進', 'Y', 100, 30)
  ]);
  check('出清後重建倉均價 = 30', near(r2.positions['Y'].cost / r2.positions['Y'].shares, 30, 1e-9),
    r2.positions['Y'].cost / r2.positions['Y'].shares);

  // 同日先買後賣：順序必須保留
  const r3 = Position.replay([
    t('2026-05-01', '買進', 'Z', 100, 10),
    t('2026-05-01', '買進', 'Z', 100, 30),
    t('2026-05-01', '賣出', 'Z', 100, 40)
  ]);
  check('同日多筆依輸入順序沖銷（均價 20）', near(r3.realized[0].avgBefore, 20, 1e-9), r3.realized[0].avgBefore);

  // 賣超只賣得掉手上有的
  const r4 = Position.replay([t('2026-01-01', '買進', 'W', 100, 10), t('2026-02-01', '賣出', 'W', 500, 20)]);
  check('賣出股數超過持股時以持股為準', r4.realized[0].shares === 100 && r4.positions['W'].shares === 0, r4.realized[0].shares);
}

// ─── T2  XIRR ────────────────────────────────────────────────────
console.log('\nT2  XIRR');
{
  const d = s => new RealDate(s);
  check('一年翻倍 → 100%', near(Position.xirr([
    { date: d('2025-01-01'), amount: -1000 }, { date: d('2026-01-01'), amount: 2000 }]), 1.0, 1e-3));
  check('一年打平 → 0%', near(Position.xirr([
    { date: d('2025-01-01'), amount: -1000 }, { date: d('2026-01-01'), amount: 1000 }]), 0, 1e-6));
  check('虧損 → 負值', Position.xirr([
    { date: d('2025-01-01'), amount: -1000 }, { date: d('2026-01-01'), amount: 500 }]) < -0.4);
  check('現金流全同號 → null', Position.xirr([
    { date: d('2025-01-01'), amount: -1000 }, { date: d('2026-01-01'), amount: -500 }]) === null);
}

// ─── T3  建表 ────────────────────────────────────────────────────
console.log('\nT3  建表');

// 試算表 ID 只能有一個來源。這裡以前寫死一個常數，而系統分頁走指令碼屬性 ——
// 兩者分岔的話資產數字讀舊表、記憶讀新表，不會有任何錯誤。
{
  check('SHEET_ID 讀的是指令碼屬性，不是寫死的常數',
    AssetSchema.SHEET_ID === Config.SHEET_ID, AssetSchema.SHEET_ID);
  const orig = Config.SHEET_ID;
  Config.SHEET_ID = 'somewhere-else';
  check('改了屬性，AssetSchema 就跟著改（沒有第二份真相）',
    AssetSchema.SHEET_ID === 'somewhere-else', AssetSchema.SHEET_ID);
  Config.SHEET_ID = '';
  let threw = '';
  try { AssetSchema.open(); } catch (e) { threw = e.message; }
  check('屬性沒設時 open() 自己擋下來並講清楚原因', /SHEET_ID/.test(threw), threw);
  Config.SHEET_ID = orig;
}

const target = SpreadsheetApp.openById(AssetSchema.SHEET_ID);
target.sheets.push(new Sheet('工作表1'));          // 模擬新試算表的預設分頁
let r3 = AssetSchema.build();
check('建立 17 個分頁', r3.created.length === 17, r3.created.length);
check('預設的「工作表1」被移除', !target.getSheetByName('工作表1'));
check('交易表標題正確', target.getSheetByName('交易').raw(1, 2) === '動作', target.getSheetByName('交易').raw(1, 2));
// 公式只填到有資料的最後一列。空表就該是空的 —— 預灌公式會讓 getLastRow()
// 跳到公式底部，之後 appendTrade 的新交易會落在公式範圍外，現金流永遠算不出來。
check('空的交易表不預灌公式', target.getSheetByName('交易').raw(2, 10) === '', JSON.stringify(target.getSheetByName('交易').raw(2, 10)));
const before = target.getSheetByName('交易').getLastColumn();
r3 = AssetSchema.build();
check('重複執行不會重建（冪等）', r3.created.length === 0 && target.getSheetByName('交易').getLastColumn() === before, JSON.stringify(r3.created));

// ─── T4  遷移 ────────────────────────────────────────────────────
console.log('\nT4  從舊表遷移');
const mig = AssetMigrate.run();
check('標的 11 檔（8 在持 + 3 已出清）', mig.counts['標的'] === 11, mig.counts['標的']);
check('帳戶 7 個（黃金不算帳戶）', mig.counts['帳戶'] === 7, mig.counts['帳戶']);
check('實體資產 8 筆黃金', mig.counts['實體資產'] === 8, mig.counts['實體資產']);
check('交易 58 筆（8 期初 + 50 股利）', mig.counts['交易'] === 58, mig.counts['交易']);
check('補建 3 檔已出清標的（舊表股利表裡有、持股表裡沒有）', mig.counts['已出清標的'] === 3, mig.counts['已出清標的']);
check('每日快照 = 950 天 × 18 列', mig.counts['每日快照'] === 950 * 18, mig.counts['每日快照']);
{
  const acct = AssetSchema.readObjects(target.getSheetByName('帳戶'));
  const usd = acct.find(a => a['帳戶'] === '國泰外幣戶(美)');
  const twd = acct.find(a => a['帳戶'] === '國泰證券戶');
  check('外幣帳戶存的是原幣不是台幣值', near(usd['期初餘額'], EXP.cash[2].origin, 0.01) && usd['幣別'] === 'USD', usd['期初餘額'] + ' ' + usd['幣別']);
  check('台幣帳戶不誤用 G 欄雜訊', near(twd['期初餘額'], EXP.cash[0].value, 1), twd['期初餘額']);
  check('證券戶類型判定為「證券」', twd['類型'] === '證券', twd['類型']);

  const inst = AssetSchema.readObjects(target.getSheetByName('標的'));
  const i646 = inst.find(x => x['代號'] === '00646') || {};
  check('00646 分類帶入 區域=美 / 類型=指', i646['區域'] === '美' && i646['類型'] === '指', i646['區域'] + '/' + i646['類型']);

  const trades = AssetSchema.readObjects(target.getSheetByName('交易'));
  const seed = trades.filter(t => t['動作'] === '期初');
  const s56 = seed.find(t => t['代號'] === H0.code) || {};
  check('期初股數與舊表一致', near(s56['股數'], H0.shares, 0), s56['股數']);
  check('期初單價 = 總成本/股數', near(s56['單價'] * H0.shares, H0.cost, 1), s56['單價'] * H0.shares);
  check('期初列的現金流 = 0（不動帳戶餘額）', near(num(s56['現金流']), 0, 1e-9), s56['現金流']);
  check('遷移列的帳戶留空', String(s56['帳戶']) === '', JSON.stringify(s56['帳戶']));
  check('名稱由標的表 VLOOKUP 帶出', s56['名稱'] === '元大高股息', s56['名稱']);
}
{
  const snap = target.getSheetByName('每日快照');
  const hdr = snap.rows[0].filter(v => v !== '');
  check('快照是長表 9 欄', hdr.length === 9 && hdr[1] === '類型', hdr.join('|'));
  const rows = AssetSchema.readObjects(snap);
  const last = rows.filter(x => x['日期'] === '2026-08-02');
  const total = last.find(x => x['鍵'] === '總資產');
  check('最後一天總資產與舊表一致', near(num(total['市值']), EXP.totalAssets, 1), total['市值']);
  check('持股列有單價、無市值（舊表沒有歷史股數）',
    last.filter(x => x['類型'] === '持股').every(x => num(x['單價']) > 0 && x['市值'] === ''), '');
}

// 重跑遷移不該疊加
const mig2 = AssetMigrate.run({ skipSnapshot: true });
check('重跑遷移不會產生重複交易列',
  AssetSchema.readObjects(target.getSheetByName('交易')).filter(t => t['來源'] === 'migration').length === 58,
  AssetSchema.readObjects(target.getSheetByName('交易')).filter(t => t['來源'] === 'migration').length);

// ─── T5  重算並與舊表對帳 ────────────────────────────────────────
console.log('\nT5  重算持倉並與舊表對帳');
const reb = Position.rebuild();
check('重算成功', reb.ok === true, JSON.stringify(reb));
check('持倉 11 檔（8 檔在持 + 3 檔已出清但領過息）', reb.positions === 11, reb.positions);
check('已實現損益 0 筆（還沒賣過）', reb.realized === 0, reb.realized);
{
  const pos = AssetSchema.readObjects(target.getSheetByName('持倉'));
  const legacyStocks = LEGACY['所有股票'].slice(2);
  let allOk = true, detail = [];
  legacyStocks.forEach(row => {
    const code = String(row[0]), shares = row[4], cost = row[5], div = row[10];
    const np = pos.find(x => String(x['代號']) === code);
    if (!np || !near(num(np['股數']), shares, 0.001) || !near(num(np['總成本']), cost, 1)
        || !near(num(np['累計股利']), div, 1)) {
      allOk = false; detail.push(code);
    }
  });
  check('8 檔的股數／成本／累計股利都與舊表一致', allOk, detail.join(','));

  const p56 = pos.find(x => x['代號'] === H0.code) || {};
  const netCost = H0.cost - H0.dividend;
  check('市值 = 股數 × 市價', near(num(p56['市值']), H0.shares * H0.price, 1), money(num(p56['市值'])));
  check('淨成本 = 總成本 − 累計股利', near(num(p56['淨成本']), netCost, 1), money(num(p56['淨成本'])));
  check('淨報酬率 = (市值 − 淨成本) / 淨成本',
    near(num(p56['淨報酬率']), (H0.shares * H0.price - netCost) / netCost, 1e-3), num(p56['淨報酬率']));

  const stockValue = pos.reduce((s, x) => s + num(x['市值']), 0);
  check('股票市值合計 = 舊表面板 B3', near(stockValue, EXP.stockValue, 2), money(stockValue));
}
{
  const cash = AssetSchema.readObjects(target.getSheetByName('現金'));
  const usd = cash.find(c => c['帳戶'] === '國泰外幣戶(美)');
  check('美元帳戶換算台幣與舊表一致', near(num(usd['台幣值']), EXP.cash[2].value, 1), money(num(usd['台幣值'])));
  const cashTotal = cash.reduce((s, c) => s + num(c['台幣值']), 0);
  // 舊表面板 F1..F7（不含黃金）
  const legacyCash = EXP.cash.slice(0, EXP.cash.length - 1).reduce((a, c) => a + c.value, 0);
  check('現金合計與舊表一致', near(cashTotal, legacyCash, 2), money(cashTotal) + ' vs ' + money(legacyCash));
}
{
  const panel = AssetSchema.readObjects(target.getSheetByName('指標'));
  const get = k => num((panel.find(x => x['指標'] === k) || {})['數值']);
  check('指標總資產 = 舊表面板 D4', near(get('總資產'), EXP.totalAssets, 3), money(get('總資產')));
  check('指標股票市值 = 舊表面板 B3', near(get('股票市值'), EXP.stockValue, 2), money(get('股票市值')));
  check('指標未實現損益 = 舊表收益', near(get('未實現損益'), EXP.unrealized, 2), money(get('未實現損益')));
  // 舊表的「總股利」只 SUMIF 到還在持股表裡的持股，已出清標的領過的息從沒被算進去。
  // 新表把整本股利帳都算回來，所以會比舊表大 —— 這是修正不是 bug。
  check('指標累計股利 = 整本股利帳（含已出清標的）',
    near(get('累計股利'), EXP.dividendAll, 2), money(get('累計股利')));
  check('而且確實大於舊表的總股利', get('累計股利') > EXP.legacyDividend,
    money(get('累計股利')) + ' vs ' + money(EXP.legacyDividend));
  check('實體資產 = 舊表黃金市值', near(get('實體資產'), GOLD.value, 2), money(get('實體資產')));
  check('XIRR 留空（期初日 = 今天，時間跨度為 0，不假裝有歷史）',
    String((panel.find(x => x['指標'] === 'XIRR（年化）') || {})['數值']) === '', '');
}
{
  const alloc = AssetSchema.readObjects(target.getSheetByName('配置'));
  const region = alloc.filter(a => a['維度'] === '區域');
  const tw = region.find(a => a['分組'] === '台');
  // 舊表配置：台股佔股票市值 56.73%，這裡分母是總資產，所以會小一些
  check('區域維度有 台/美/歐/日 四組', region.length === 4, region.map(x => x['分組']).join(','));
  check('台股市值 = 舊表配置表裡區域為台的合計', near(num(tw['市值']), EXP.twValue, 2), money(num(tw['市值'])));
  const kinds = alloc.filter(a => a['維度'] === '類型');
  check('類型維度有 息/指 兩組', kinds.length === 2, kinds.map(x => x['分組']).join(','));
  const major = alloc.filter(a => a['維度'] === '大類');
  check('大類三組相加 = 總資產', near(major.reduce((s, x) => s + num(x['市值']), 0), EXP.totalAssets, 3),
    money(major.reduce((s, x) => s + num(x['市值']), 0)));
}

// ─── T6  加一筆真實賣出，驗證全鏈路 ──────────────────────────────
console.log('\nT6  記一筆賣出（模擬 Telegram 輸入）');
{
  // 走 appendTrade（工具層之後也走這條），它會順手補上該列的公式
  AssetSchema.appendTrade({
    日期: '2026-08-03', 動作: '賣出', 代號: H0.code, 股數: SELL_QTY, 單價: SELL_PRICE,
    手續費: 21, 交易稅: 0, 幣別: 'TWD', 帳戶: '國泰證券戶', 分類: '投資',
    備註: '測試賣出', 來源: 'telegram', 建立時間: '2026-08-03 18:00:00'
  }, target);
  const reb2 = Position.rebuild();
  const pos = AssetSchema.readObjects(target.getSheetByName('持倉'));
  const p56 = pos.find(x => x['代號'] === '0056');
  const real = AssetSchema.readObjects(target.getSheetByName('已實現損益'));

  const AVG = H0.cost / H0.shares;            // 加權平均成本
  const OUT = AVG * SELL_QTY;                 // 沖銷成本
  const NET = SELL_QTY * SELL_PRICE - SELL_FEE;

  check('賣出後股數 = 期初 − 賣出', near(num(p56['股數']), H0.shares - SELL_QTY, 0), p56['股數']);
  check('沖銷成本 = 均價 × 賣出股數', near(num(real[0]['沖銷成本']), OUT, 1), money(num(real[0]['沖銷成本'])));
  check('賣出淨額 = 股數 × 單價 − 手續費', near(num(real[0]['賣出淨額']), NET, 0.01), money(num(real[0]['賣出淨額'])));
  check('已實現損益 = 淨額 − 沖銷成本', near(num(real[0]['已實現損益']), NET - OUT, 1),
    money(num(real[0]['已實現損益'])));
  check('剩餘成本 = 總成本 − 沖銷成本', near(num(p56['總成本']), H0.cost - OUT, 1), money(num(p56['總成本'])));
  check('平均成本不變（加權平均法）', near(num(p56['平均成本']), AVG, 1e-4), p56['平均成本']);

  const cash = AssetSchema.readObjects(target.getSheetByName('現金'));
  const broker = cash.find(c => c['帳戶'] === '國泰證券戶');
  check('券商戶餘額 = 期初 + 賣出淨額', near(num(broker['餘額']), EXP.cash[0].value + NET, 1), money(num(broker['餘額'])));

  const panel = AssetSchema.readObjects(target.getSheetByName('指標'));
  const get = k => num((panel.find(x => x['指標'] === k) || {})['數值']);
  check('指標已實現損益跟著出現', near(get('已實現損益'), NET - OUT, 1), money(get('已實現損益')));
  // 期初日就是今天，離開帳日只有幾天 → 不年化，但說明要講出真正的原因
  // （舊版一律寫「時間跨度不足」，那句話在三種情況裡有兩種是騙人的）
  const xirrNote = String((panel.find(x => x['指標'] === 'XIRR（年化）') || {})['說明']);
  check('短期間的 XIRR 仍為空，且說明講清楚原因（不年化，但給期間報酬）',
    String((panel.find(x => x['指標'] === 'XIRR（年化）') || {})['數值']) === '' &&
    /年化沒有意義|開帳市值無從取得|無解/.test(xirrNote), xirrNote);
  check('說明沒有再謊稱「時間跨度不足」', !/時間跨度不足/.test(xirrNote), xirrNote);
  // 賣價比評價用的市價高一點，所以總資產不是原地不動：
  // 股票市值 −股數×市價、現金 +股數×賣價−手續費
  check('總資產守恆：只差在賣價與市價的價差扣掉手續費',
    near(get('總資產'), EXP.totalAssets + SELL_QTY * (SELL_PRICE - H0.price) - SELL_FEE, 3),
    money(get('總資產')));
}

// ─── T7b  代號必須維持文字型別 ───────────────────────────────────
// 台股代號有前導零。寫進「自動」格式的欄位會被 Sheets 轉成數字（0056 → 56），
// GOOGLEFINANCE("TPE:"&代號) 就查無此股，市值整欄靜默變 0。
console.log('\nT7b  代號的前導零不能被吃掉');
{
  // 先驗 mock 本身：它必須真的複製 Sheets 的型別轉換，
  // 否則下面那些保護等於沒測到（這個 bug 就是這樣從 84 個測試底下溜過去的）。
  const probe = new Sheet('probe');
  probe.getRange(1, 1).setValue('0056');
  check('mock 會把像數字的字串轉成數字（與 Sheets 相同）',
    probe.raw(1, 1) === 56, JSON.stringify(probe.raw(1, 1)));
  probe.getRange(1, 2).setNumberFormat('@');
  probe.getRange(1, 2).setValue('0056');
  check('設成純文字格式後就不再轉換',
    probe.raw(1, 2) === '0056', JSON.stringify(probe.raw(1, 2)));

  const inst = AssetSchema.readObjects(target.getSheetByName('標的'));
  const codes = inst.map(x => String(x['代號']));
  check('標的表的代號與舊表逐字相同',
    HOLD.every(h => codes.includes(h.code)), codes.slice(0, 4).join(','));

  const pos = AssetSchema.readObjects(target.getSheetByName('持倉'));
  check('持倉表的代號也沒被轉成數字',
    HOLD.every(h => pos.some(p => String(p['代號']) === h.code)),
    pos.map(p => p['代號']).slice(0, 4).join(','));

  const held = pos.filter(p => num(p['股數']) > 0);
  check('每一檔在持部位都抓得到市價（代號正確才查得到）',
    held.every(p => num(p['市價']) > 0), held.map(p => p['代號'] + '=' + p['市價']).join(' '));

  // 修復情境：某一列的代號已經被轉成數字了，重跑遷移必須「覆寫那一列」，
  // 而不是把正確的文字代號當成新標的再append一列。
  const instSheet = target.getSheetByName('標的');
  const rowOf = (code) => AssetSchema.readObjects(instSheet)
    .findIndex(x => String(x['代號']) === code) + 2;
  const before = AssetSchema.readObjects(instSheet).length;
  instSheet.getRange(rowOf(H0.code), 1).setValue(Number(H0.code));   // 模擬被吃掉前導零
  AssetMigrate.run({ skipSnapshot: true });
  const after = AssetSchema.readObjects(instSheet);
  check('重跑遷移會修好被轉成數字的代號，不是再長一列',
    after.length === before, before + ' → ' + after.length);
  check('該列的代號已修回文字',
    after.some(x => String(x['代號']) === H0.code), after.map(x => x['代號']).slice(0, 3).join(','));
}

// ─── T8  標題列契約 ──────────────────────────────────────────────
// 寫入是位置對應（公式裡的欄位字母也寫死），所以標題列一旦錯位就必須擋下來，
// 不能像舊 sheet 那樣把缺的欄補在最後面然後繼續寫。
console.log('\nT8  標題列與寫入位置必須一致');
{
  const panelSheet = target.getSheetByName('指標');
  panelSheet.getRange(1, 1).setValue('亂改的欄名');
  let threw = false;
  try { Position.rebuild(); } catch (e) { threw = /指標.*第 1 欄/.test(e.message); }
  check('generated 分頁標題錯位 → 寫入被擋下', threw);

  const r8 = AssetSchema.build();
  check('build() 把 generated 分頁的標題列修回來',
    panelSheet.getRange(1, 1).getValue() === '指標', String(panelSheet.getRange(1, 1).getValue()));
  check('修復動作有回報', r8.patched.some(x => /指標/.test(x)), JSON.stringify(r8.patched));

  // 輸入層有人工資料，程式不可以自作主張搬欄位
  const tradeSheet = target.getSheetByName('交易');
  tradeSheet.getRange(1, 2).setValue('動做');       // 錯字
  let threw2 = false;
  try { AssetSchema.build(); } catch (e) { threw2 = /交易.*第 2 欄/.test(e.message); }
  check('輸入層分頁標題錯位 → build() 丟例外而不是亂補', threw2);

  tradeSheet.getRange(1, 2).setValue('動作');
  AssetSchema.build();
  check('修回來之後 build() 恢復正常',
    AssetSchema.checkHeader(tradeSheet, AssetSchema.expected('交易')).ok);
  check('持倉標題列與 TABS 逐格對齊',
    AssetSchema.checkHeader(target.getSheetByName('持倉'), AssetSchema.expected('持倉')).ok);
}

// ─── T9  賣超股數 ────────────────────────────────────────────────
// 程式會把股數夾到實際持股，但交易列的「現金流」公式用的是原始股數 ——
// 兩邊會對不起來，所以這件事必須浮到指標表，不能只寫進 consolelog。
console.log('\nT9  賣超股數必須浮上來');
{
  AssetSchema.appendTrade({
    日期: '2026-08-03', 動作: '賣出', 代號: '0056', 股數: 999999, 單價: 49.5,
    手續費: 21, 交易稅: 0, 幣別: 'TWD', 帳戶: '國泰證券戶', 分類: '投資',
    備註: '打錯一個 0', 來源: 'telegram'
  });
  const r9 = Position.rebuild();
  check('rebuild 的結果帶出警告', (r9.warnings || []).length === 1, JSON.stringify(r9.warnings));
  check('警告講明現金流會對不起來', /現金流/.test((r9.warnings || [])[0] || ''), (r9.warnings || [])[0]);

  const panel = AssetSchema.readObjects(target.getSheetByName('指標'));
  check('指標表最上面出現待修正列', /待修正/.test(String(panel[0]['指標'])), String(panel[0]['指標']));
  check('插在最前面不影響 VLOOKUP 取總資產',
    num((panel.find(x => x['指標'] === '總資產') || {})['數值']) > 0);
}

// ─── T10  期初日 ─────────────────────────────────────────────────
// 期初列是成本基礎與 XIRR 的起算點。重跑遷移若把它改成「今天」，
// 就可能排到已記錄的真實交易之後，那些賣出會被當成「無持股」跳過。
console.log('\nT10  期初日不能因為重跑遷移而移動');
{
  const tradeSheet = target.getSheetByName('交易');
  const epochOf = () => AssetSchema.readObjects(tradeSheet)
    .filter(t => String(t['來源']) === 'migration' && String(t['動作']) === '期初')
    .map(t => String(t['日期']))[0];

  const before10 = epochOf();
  NOW = new RealDate('2026-09-15T10:00:00+08:00');
  AssetMigrate.run({ skipSnapshot: true });
  check('隔了一個多月重跑，期初日沿用原本的',
    epochOf() === before10, epochOf() + ' vs ' + before10);

  AssetSchema.appendTrade({
    日期: '2026-07-01', 動作: '買進', 代號: '0056', 股數: 1000, 單價: 48,
    手續費: 20, 幣別: 'TWD', 帳戶: '國泰證券戶', 來源: 'telegram', 備註: '回補的舊交易'
  });
  let threw = false;
  try { AssetMigrate.run({ skipSnapshot: true }); } catch (e) { threw = /早於期初日/.test(e.message); }
  check('有早於期初日的真實交易 → 擋下重跑', threw);

  let forced = false;
  try { AssetMigrate.run({ skipSnapshot: true, force: true }); forced = true; } catch (e) { forced = false; }
  check('force:true 可以覆蓋這個保護', forced);
}

// ─── T11  recordTrade（Telegram 講一句話就記一筆）──────────────────
console.log('\nT11  recordTrade 的驗證與寫入');
{
  const tradeSheet = target.getSheetByName('交易');
  const instSheet  = target.getSheetByName('標的');
  const countTrades = () => AssetSchema.readObjects(tradeSheet).length;
  const sharesOf = (code) => {
    const p = AssetSchema.readObjects(target.getSheetByName('持倉'))
      .find(x => String(x['代號']) === code);
    return p ? num(p['股數']) : 0;
  };

  // 拒絕的情況都不可以寫進表裡
  const n0 = countTrades();
  check('不認識的動作被擋下',
    /不認識的動作/.test(AssetTools.recordTrade({ action: '亂寫一通' })), '');
  check('買賣缺股數會說缺什麼',
    /股數/.test(AssetTools.recordTrade({ action: '賣出', symbol: H0.code, price: 50 })), '');
  check('未知帳戶會列出可用的帳戶',
    /沒有這個帳戶/.test(AssetTools.recordTrade({
      action: '買進', symbol: H0.code, shares: 1000, price: 50, account: '火星銀行' })), '');
  check('賣出未登記的標的被擋下',
    /標的/.test(AssetTools.recordTrade({ action: '賣出', symbol: '9999', shares: 1, price: 1 })), '');
  check('被擋下的四筆都沒有寫進交易表', countTrades() === n0, countTrades() + ' vs ' + n0);

  // 正常買進
  const before = sharesOf(H0.code);
  const r1 = AssetTools.recordTrade({
    action: '買進', symbol: H0.code, shares: 1000, price: 50, fee: 20, note: '測試買進'
  });
  check('買進有記錄成功', /已記錄第 \d+ 列/.test(r1), r1.split('\n')[0]);
  check('交易表多一列', countTrades() === n0 + 1, countTrades() + ' vs ' + (n0 + 1));
  check('持倉股數增加 1000', sharesOf(H0.code) === before + 1000, sharesOf(H0.code) + ' vs ' + (before + 1000));
  check('只有一個證券戶時自動帶入帳戶', /國泰證券戶/.test(r1), r1);
  check('回覆帶回重算後的持倉與帳戶餘額', /均價/.test(r1) && /餘額/.test(r1), r1);

  // 新標的自動登記，且代號必須是文字
  const instBefore = AssetSchema.readObjects(instSheet).length;
  const r2 = AssetTools.recordTrade({ action: '買進', symbol: '00929', shares: 500, price: 20 });
  const inst = AssetSchema.readObjects(instSheet);
  check('新標的自動加進標的表', inst.length === instBefore + 1, inst.length + ' vs ' + (instBefore + 1));
  check('新標的的代號保留前導零',
    inst.some(x => x['代號'] === '00929'), JSON.stringify(inst.map(x => x['代號']).slice(-2)));
  check('回覆有說明是自動建立的', /自動/.test(r2), r2);

  // 股利只是動作欄不同的一列交易，走同一條路才會觸發重算
  const divBefore = num((AssetSchema.readObjects(target.getSheetByName('持倉'))
    .find(x => x['代號'] === H0.code) || {})['累計股利']);
  const r3 = AssetTools.recordTrade({ action: '股利', symbol: H0.code, amount: 12345, date: '2026-09-01' });
  const divRow = AssetSchema.readObjects(target.getSheetByName('交易'))
    .filter(t => t['動作'] === '股利' && String(t['代號']) === H0.code).slice(-1)[0] || {};
  check('股利寫成「交易」的一列', num(divRow['金額']) === 12345, JSON.stringify(divRow['金額']));
  check('日期正規化成 yyyy-MM-dd', String(divRow['日期']) === '2026-09-01', divRow['日期']);
  check('重算後累計股利跟著加上去',
    near(num((AssetSchema.readObjects(target.getSheetByName('持倉'))
      .find(x => x['代號'] === H0.code) || {})['累計股利']), divBefore + 12345, 1),
    r3);
}

// ─── T12  券商已實現損益 CSV 匯入 ─────────────────────────────────
// 用合成的數字，不放真實成交（見 .gitignore 的說明）。
console.log('\nT12  券商 CSV 匯入');
{
  const H1 = HOLD[1];
  const CSV = '﻿股票名稱,日期,股數,損益,交易別,買進日期,賣出日期,買進單價,賣出單價,手續費,交易稅,買進價金,賣出價金,報酬率,幣別\n' +
    H1.name + ',2026/08/03,"2,000","3,000",現股,2025/07/08,2026/08/03,20,31.5,40,63,"40,000","62,897",7.5%,台幣\n' +
    H1.name + ',2026/08/03,500,"1,000",現股,2025/08/06,2026/08/03,21,31.5,12,15,"10,500","15,723",9.5%,台幣\n' +
    '不存在的標的,2026/08/03,100,"50",現股,2025/08/06,2026/08/03,10,11,1,1,"1,000","1,098",9.8%,台幣\n';

  const tradeSheet = target.getSheetByName('交易');
  const countTrades = () => AssetSchema.readObjects(tradeSheet).length;

  // 解析
  const parsed = AssetImport.parseRealized(CSV);
  check('解析出 2 列（第 3 列的標的不存在）', parsed.rows.length === 2, parsed.rows.length);
  check('名稱有對應回代號', parsed.rows.every(r => r.code === H1.code),
    parsed.rows.map(r => r.code).join(','));
  check('找不到的標的有列進 errors', parsed.errors.some(e => /不存在的標的/.test(e)),
    JSON.stringify(parsed.errors));
  // 單價要能還原券商的入帳金額：(賣出價金 + 手續費 + 交易稅) / 股數
  check('單價是反推的，不是報表上顯示的',
    Math.abs(parsed.rows[0].price - (62897 + 40 + 63) / 2000) < 1e-6, parsed.rows[0].price);

  // 預覽不可寫入
  const n0 = countTrades();
  const preview = AssetImport.importRealized(CSV, { dryRun: true });
  check('預覽不寫入任何一列', countTrades() === n0, countTrades() + ' vs ' + n0);
  check('預覽有列出彙總', /賣出 2,500 股/.test(preview), preview.split('\n').find(l => /賣出/.test(l)));

  // 正式匯入
  const sharesBefore = num((AssetSchema.readObjects(target.getSheetByName('持倉'))
    .find(x => String(x['代號']) === H1.code) || {})['股數']);
  const out = AssetImport.importRealized(CSV);
  check('匯入 2 列', countTrades() === n0 + 2, countTrades() + ' vs ' + (n0 + 2));
  const sharesAfter = num((AssetSchema.readObjects(target.getSheetByName('持倉'))
    .find(x => String(x['代號']) === H1.code) || {})['股數']);
  check('持股減少 2,500', sharesBefore - sharesAfter === 2500, sharesBefore + ' → ' + sharesAfter);
  check('有說明損益算法與券商不同', /加權平均/.test(out), '');

  // 同一份檔案重匯不可以重複記帳
  const again = AssetImport.importRealized(CSV);
  check('重複匯入被去重擋下', countTrades() === n0 + 2, countTrades() + ' vs ' + (n0 + 2));
  check('回覆有說略過幾列', /略過 2 列/.test(again), again.split('\n')[1]);

  // 券商自己的損益要留在備註裡，之後才對得回去
  const last = AssetSchema.readObjects(tradeSheet).slice(-1)[0];
  check('備註保留券商損益與去重鍵',
    /券商損益/.test(String(last['備註'])) && /imp:/.test(String(last['備註'])),
    String(last['備註']).slice(0, 60));

  // ── 從 Telegram 收檔案 ──
  const CSV2 = '﻿股票名稱,日期,股數,損益,交易別,買進日期,賣出日期,買進單價,賣出單價,手續費,交易稅,買進價金,賣出價金,報酬率,幣別\n' +
    H1.name + ',2026/08/04,100,"120",現股,2025/07/08,2026/08/04,20,31.5,3,4,"2,000","3,143",6%,台幣\n';
  global.Telegram = { fetchFileText: () => CSV2 };
  const upload = (fileName, size, caption) => AssetImport.fromUpload({
    platform: 'TELEGRAM',
    message: { type: 'document', text: caption || '', document: { fileId: 'f1', fileName: fileName, fileSize: size || 500 } }
  });

  check('非 csv 檔名被拒絕', /只看得懂 \.csv/.test(upload('報表.pdf')), '');
  check('過大的檔案被拒絕', /檔案太大/.test(upload('a.csv', 5 * 1024 * 1024)), '');

  const n1 = countTrades();
  check('附註寫「預覽」時不寫入',
    /預覽/.test(upload('a.csv', 500, '先預覽一下')) && countTrades() === n1, countTrades());
  const up = upload('證券已實現20260804.csv');
  check('正常上傳會匯入', countTrades() === n1 + 1, countTrades() + ' vs ' + (n1 + 1));
  check('重傳同一份不會重複記', (upload('證券已實現20260804.csv'), countTrades() === n1 + 1), countTrades());
}

// ─── T13  Snapshot 讀新表 ─────────────────────────────────────────
// Snapshot 是 Dashboard / MiniApp / AdvisorCheck 共用的接縫，
// 輸出形狀不能變，只換資料來源。
console.log('\nT13  Snapshot 改讀新表');
{
  const ss = Snapshot._open();
  check('_open 指向資產管理表', ss === target, String(ss && ss.id));

  const h = Snapshot._holdings(ss);
  check('_holdings 只回在持部位', h.length > 0 && h.every(x => x.shares > 0), h.length);
  check('_holdings 欄位形狀不變',
    h[0] && ['code', 'name', 'shares', 'price', 'marketValue', 'costBasis',
             'totalDividendReceived', 'pnl', 'pnlPct', 'ratioOfPortfolio']
      .every(k => k in h[0]), JSON.stringify(Object.keys(h[0] || {})));
  check('佔比加總約等於 1',
    Math.abs(h.reduce((s, x) => s + x.ratioOfPortfolio, 0) - 1) < 0.01,
    h.reduce((s, x) => s + x.ratioOfPortfolio, 0));

  const c = Snapshot._cash(ss);
  check('_cash 帳戶數與現金表一致',
    c && c.accounts.length === AssetSchema.readObjects(target.getSheetByName('現金')).length,
    c && c.accounts.length);
  check('_cash 合計 = 各帳戶台幣值加總',
    near(c.total, c.accounts.reduce((s, a) => s + a.amount, 0), 2), c.total);

  const t = Snapshot._totals(ss);
  const panelTotal = num((AssetSchema.readObjects(target.getSheetByName('指標'))
    .find(x => x['指標'] === '總資產') || {})['數值']);
  check('_totals 的今天取指標的即時總資產', near(t.today, panelTotal, 2),
    t.today + ' vs ' + panelTotal);
  check('_totals 有歷史比較欄位', 'dayChangePct' in t && 'monthChangePct' in t, JSON.stringify(t));

  const d = Snapshot._dividends(ss);
  check('_dividends 讀得到交易表裡的股利', d && d.thisYear.count > 0, d && d.thisYear.count);

  const g = Snapshot._gold(ss);
  check('_gold 讀實體資產', g && g.totalWeight > 0 && g.pieces > 0, JSON.stringify(g));

  const series = Snapshot.totalSeries(365, ss);
  check('totalSeries 讀每日快照的合計列', series.length > 0 && series[0].date < series[series.length - 1].date,
    series.length);
  const ds = Snapshot.dividendSeries(ss);
  check('dividendSeries 有年度分佈', ds.byYear.length > 0, JSON.stringify(ds.byYear.map(x => x.year)));

  // ── _metrics：儀表板的績效條靠這支把「指標」接出來 ──
  const panelSheet = target.getSheetByName('指標');
  const panelVal = (k) => num((AssetSchema.readObjects(panelSheet)
    .find(x => x['指標'] === k) || {})['數值']);

  const mt = Snapshot._metrics(ss);
  check('_metrics 讀得到績效欄位', !!mt && Array.isArray(mt.warnings), mt && Object.keys(mt).length);
  check('_metrics 的未實現損益就是指標那一列',
    near(mt.unrealized, panelVal('未實現損益'), 2), mt.unrealized);
  check('_metrics 淨損益 = 未實現 + 已實現 + 股利',
    near(mt.netPnl, mt.unrealized + mt.realized + mt.dividendTotal, 2), mt.netPnl);
  check('_metrics 不把分隔列與警告列當成指標',
    mt.lastRebuild !== '' && !('——' in mt), mt.lastRebuild);

  // 空字串必須讀成 null。XIRR 算不出來時「指標」寫的就是空字串，
  // 直接 _num 會變成 0 —— 畫面上會顯示「年化 0%」而不是「還算不出來」。
  {
    const colA = panelSheet.getRange(1, 1, panelSheet.getLastRow(), 1)
      .getValues().map(r => String(r[0]).trim());
    const rowNo = colA.indexOf('XIRR（年化）') + 1;
    check('指標表上找得到 XIRR 那一列', rowNo > 0, rowNo);
    const cell = panelSheet.getRange(rowNo, 2);
    const keep = cell.getValue();
    cell.setValue('');
    check('_metrics 把空字串讀成 null 而不是 0', Snapshot._metrics(ss).xirr === null,
      String(Snapshot._metrics(ss).xirr));
    cell.setValue(keep);
  }
}

// ─── T14  每日快照改寫長表 ────────────────────────────────────────
console.log('\nT14  DataSync 寫長表快照');
load('DataSync.gs');
{
  const snapSheet = target.getSheetByName('每日快照');
  const rowsOn = (date) => AssetSchema.readObjects(snapSheet)
    .filter(r => String(r['日期']) === date);

  NOW = new RealDate('2026-09-16T18:00:00+08:00');   // 週三
  const today = '2026-09-16';

  // dryRun 不可以寫入
  const before = snapSheet.getLastRow();
  const dry = DataSync.run({ dryRun: true });
  check('dryRun 不寫入', snapSheet.getLastRow() === before, snapSheet.getLastRow());
  check('dryRun 回報要寫幾列', dry.ok && dry.rows > 0, JSON.stringify({ ok: dry.ok, rows: dry.rows }));

  const r = DataSync.run();
  const written = rowsOn(today);
  check('寫入當日的列', r.ok && written.length === r.rows, written.length + ' vs ' + r.rows);

  const panelTotal = num((AssetSchema.readObjects(target.getSheetByName('指標'))
    .find(x => x['指標'] === '總資產') || {})['數值']);
  const snapTotal = written.find(x => x['類型'] === '合計' && x['鍵'] === '總資產');
  check('合計/總資產 = 指標的總資產', near(num(snapTotal['市值']), panelTotal, 2),
    snapTotal && snapTotal['市值']);

  const heldCount = AssetSchema.readObjects(target.getSheetByName('持倉'))
    .filter(x => num(x['股數']) > 0).length;
  check('持股列只記在持部位',
    written.filter(x => x['類型'] === '持股').length === heldCount,
    written.filter(x => x['類型'] === '持股').length + ' vs ' + heldCount);
  check('現金列涵蓋所有帳戶',
    written.filter(x => x['類型'] === '現金').length ===
      AssetSchema.readObjects(target.getSheetByName('現金')).length, '');
  // 前面測試加過一檔沒有報價的合成標的，所以這裡本來就該是「報價異常」——
  // 抓不到價的那檔要被點名，其餘照常寫入，而不是整天不寫。
  check('有持股抓不到市價時標記報價異常',
    r.status === '報價異常' && r.badPrices.length > 0, r.status + ' ' + r.badPrices.join(','));
  check('抓不到價的那檔市值留空',
    written.filter(x => x['類型'] === '持股' && r.badPrices.indexOf(String(x['鍵'])) >= 0)
           .every(x => x['市值'] === ''), '');
  check('其他檔照常有市值',
    written.filter(x => x['類型'] === '持股' && r.badPrices.indexOf(String(x['鍵'])) < 0)
           .every(x => num(x['市值']) > 0), '');
  check('狀態整天一致', new Set(written.map(x => x['狀態'])).size === 1, '');

  // 同日重跑要覆寫，不可以長出第二份
  const total1 = snapSheet.getLastRow();
  const r2 = DataSync.run();
  check('同日重跑覆寫', snapSheet.getLastRow() === total1 && rowsOn(today).length === written.length,
    snapSheet.getLastRow() + ' vs ' + total1);
  check('回報有刪掉幾列', r2.replaced === written.length, r2.replaced);

  // 週末標休市
  NOW = new RealDate('2026-09-19T18:00:00+08:00');   // 週六
  const r3 = DataSync.run();
  check('週末狀態為休市', r3.status === '休市', r3.status);

  // 代號的前導零在快照裡也不能掉
  check('快照的持股鍵保留前導零',
    rowsOn(today).filter(x => x['類型'] === '持股').some(x => /^0\d/.test(String(x['鍵']))),
    rowsOn(today).filter(x => x['類型'] === '持股').map(x => x['鍵']).join(','));
}

// ─── T16  對帳單匯入（買賣都有 + 跨格式去重）──────────────────────
console.log('\nT16  證券對帳單匯入');
{
  const H2 = HOLD[2];
  const STM = '股名,日期,成交股數,淨收付,成交單價,成交價金,手續費,交易稅,稅款,委託書號,幣別,備註\n' +
    // 賣出（錢進來）
    H2.name + ',2026/08/20,"1,000","31,437",31.5,"31,500",20,43,0,A0001,台幣,\n' +
    // 買進（錢出去）
    H2.name + ',2026/08/20,500,"-15,772",31.5,"15,750",22,0,0,A0002,台幣,\n' +
    // 同一張委託分兩批成交，書號相同、股數不同
    H2.name + ',2026/08/21,300,"-9,463",31.5,"9,450",13,0,0,B0001,台幣,\n' +
    H2.name + ',2026/08/21,200,"-6,308",31.5,"6,300",8,0,0,B0001,台幣,\n' +
    '沒登記過的標的,2026/08/21,100,"-1,010",10,"1,000",10,0,0,C0001,台幣,\n';

  const tradeSheet = target.getSheetByName('交易');
  const countTrades = () => AssetSchema.readObjects(tradeSheet).length;

  const parsed = AssetImport.parseStatement(STM);
  check('解析出 4 列（未登記的標的不算）', parsed.rows.length === 4, parsed.rows.length);
  check('淨收付為正判為賣出、為負判為買進',
    parsed.rows[0].action === '賣出' && parsed.rows[1].action === '買進',
    parsed.rows.map(r => r.action).join(','));
  check('單價由成交價金反推', Math.abs(parsed.rows[0].price - 31500 / 1000) < 1e-6, parsed.rows[0].price);
  check('同書號不同批次是兩筆不同的鍵',
    parsed.rows[2].key !== parsed.rows[3].key, parsed.rows[2].key + ' / ' + parsed.rows[3].key);
  check('未登記的標的有回報且要求先補代號',
    parsed.errors.some(e => /沒登記過的標的/.test(e) && /代號/.test(e)), JSON.stringify(parsed.errors));

  const n0 = countTrades();
  AssetImport.importStatement(STM, { dryRun: true });
  check('預覽不寫入', countTrades() === n0, countTrades());

  const out = AssetImport.importStatement(STM);
  check('匯入 4 列', countTrades() === n0 + 4, countTrades() + ' vs ' + (n0 + 4));
  check('重傳同一份被鍵值擋下',
    (AssetImport.importStatement(STM), countTrades() === n0 + 4), countTrades());

  // 跨格式去重：同一批賣出改用「已實現損益」的拆法再送一次，不可以重複記
  const REALIZED = '股票名稱,日期,股數,損益,交易別,買進日期,賣出日期,買進單價,賣出單價,手續費,交易稅,買進價金,賣出價金,報酬率,幣別\n' +
    H2.name + ',2026/08/20,600,"100",現股,2025/01/01,2026/08/20,20,31.5,12,26,"12,000","18,862",5%,台幣\n' +
    H2.name + ',2026/08/20,400,"80",現股,2025/01/01,2026/08/20,20,31.5,8,17,"8,000","12,575",5%,台幣\n';
  const n1 = countTrades();
  const dup = AssetImport.importRealized(REALIZED);
  check('已實現格式的同一批賣出不會再記一次（數量比對）',
    countTrades() === n1, countTrades() + ' vs ' + n1);

  // 反向也要成立：對帳單再送一次也不能因為換格式就漏掉去重
  const again = AssetImport.importStatement(STM);
  check('反向重送仍然不重複', countTrades() === n1, countTrades());
  check('回覆有說明略過的原因', /略過/.test(again), again.split('\n')[1]);
}

// 選用：拿真實的對帳單跑一次解析，只印不斷言（檔案不進版控）
//   STATEMENT_CSV=path/to.csv node test_asset.cjs
if (process.env.STATEMENT_CSV && fs.existsSync(process.env.STATEMENT_CSV)) {
  console.log('\n[對帳單解析預覽] ' + process.env.STATEMENT_CSV);
  const inst = target.getSheetByName('標的');
  inst.getRange(inst.getLastRow() + 1, 1, 1, 10).setValues([['009826', '貝萊德世界股票',
    'TPE', 'TWD', 'GOOGLEFINANCE', '全球', '指', '', '持有中', '預覽用']]);
  const st = AssetImport.parseStatement(fs.readFileSync(process.env.STATEMENT_CSV, 'utf8'));
  console.log('  解析 ' + st.rows.length + ' 列，錯誤 ' + st.errors.length + ' 項');
  st.rows.forEach(r => console.log('  ' + r.date + ' ' + r.action + ' ' + r.code + ' ' +
    r.name + ' ' + r.shares.toLocaleString() + ' 股 @' + r.price +
    ' 淨收付 ' + Math.round(r.net).toLocaleString() + '  ' + r.key));
  st.errors.forEach(e => console.log('  WARN ' + e));
}

// ─── T17  面板只畫還有部位的標的 ──────────────────────────────────
// 面板是人看的，出清的標的擺在上面只會是一排 0；而且它必須是純公式，
// 一旦有人把數字寫死，重算之後就會停在那個時間點。
console.log('\nT17  面板只畫還有部位的標的');
{
  Position.rebuild();
  const pnl = target.getSheetByName('面板');
  const pos = AssetSchema.readObjects(target.getSheetByName('持倉'));
  const heldCodes = pos.filter(x => num(x['股數']) > 0).map(x => String(x['代號'])).sort();
  const soldCodes = pos.filter(x => num(x['股數']) <= 0).map(x => String(x['代號']));

  // 找到明細表頭那一列
  let top = 0;
  for (let r = 1; r <= pnl.getLastRow(); r++) {
    if (String(pnl.getRange(r, 1).getValue()) === '代號') { top = r; break; }
  }
  check('面板有持股明細表頭', top > 0, '第 ' + top + ' 列');

  const shown = [];
  for (let r = top + 1; r <= pnl.getLastRow(); r++) {
    const v = String(pnl.getRange(r, 1).getValue());
    if (!v || v === '合計') break;
    shown.push(v);
  }
  check('面板列出的檔數 = 還有部位的檔數',
    shown.length === heldCodes.length, shown.length + ' vs ' + heldCodes.length);
  check('已出清的標的不出現在面板上',
    soldCodes.length > 0 && !shown.some(c => soldCodes.indexOf(c) >= 0),
    '已出清 ' + soldCodes.join(',') + ' / 面板 ' + shown.join(','));
  check('面板的股數對得上持倉',
    shown.every((c, i) => num(pnl.getRange(top + 1 + i, 5).getValue()) ===
      num((pos.find(x => String(x['代號']) === c) || {})['股數'])));

  // 每一格都必須是公式：寫死的數字撐不過下一次重算
  const raws = shown.map((_, i) => String(pnl.raw(top + 1 + i, 7)));
  check('當前價值那一欄是公式而不是寫死的數字',
    raws.length > 0 && raws.every(x => x.charAt(0) === '='), raws[0]);

  check('總資產那格也是公式', String(pnl.raw(5, 2)).charAt(0) === '=', String(pnl.raw(5, 2)));
}

// ─── T18  市價的 TWSE 備援 ────────────────────────────────────────
// GOOGLEFINANCE 抓不到時退到 TWSE 的 STOCK_DAY_AVG。本機沒有網路也打不到 TWSE，
// 所以這裡驗的是**公式長相**：代號必須是指向 $A 欄的參照，不能是寫死的某一檔 ——
// 寫死的話每一列都會去抓同一支股票的價格，而且完全不會報錯。
console.log('\nT18  市價抓不到時退到 TWSE');
{
  const posSheet = target.getSheetByName('持倉');
  const rows = AssetSchema.readObjects(posSheet);
  const at = rows.findIndex(x => num(x['股數']) > 0) + 2;
  const f = String(posSheet.raw(at, 8));

  check('第一順位仍然是 GOOGLEFINANCE',
    /^=IFERROR\(GOOGLEFINANCE\(/.test(f), f.slice(0, 40));
  check('備援打的是 TWSE STOCK_DAY_AVG', /STOCK_DAY_AVG/.test(f));
  // STOCK_DAY_AVG 回整個月、由舊到新，沒有貪婪前綴會抓到月初那天
  check('正則用貪婪前綴抓最後一筆，不是月初第一筆',
    f.indexOf('".*' + String.fromCharCode(92) + 'd{3}/') >= 0);
  check('stockNo 是指向本列代號的參照，不是寫死的代號',
    f.indexOf('&stockNo="&$A' + at) >= 0, f.slice(f.indexOf('stockNo') - 6, f.indexOf('stockNo') + 18));
  check('備援自己有收尾，失敗時回空字串而不是錯誤值（$I 靠 $H="" 判斷）',
    /,""\)\)$/.test(f), f.slice(-12));

  // 出清的標的整格是空字串（不抓價），所以只檢查還有部位的那幾列
  check('每一列抓的是自己的代號（沒有兩列共用同一個 stockNo）',
    rows.every((x, i) => num(x['股數']) <= 0 ||
      String(posSheet.raw(i + 2, 8)).indexOf('&stockNo="&$A' + (i + 2)) >= 0));
}

// ─── T19  抓不到市價時不能靜默少算 ────────────────────────────────
// 2026-08-04 的真實事故：剛匯入的 009826 當下抓不到報價，市值被讀成 0，
// 於是 302 萬憑空消失、指標寫下死值、儀表板顯示單日 −20%，而且沒有任何錯誤。
// 修法有兩層：頭四個數字改用公式（報價回來會自己好），其餘死值則要出聲。
console.log('\nT19  抓不到市價時要出聲，不要靜默少算');
{
  const posSheet = target.getSheetByName('持倉');
  const before = AssetSchema.readObjects(posSheet);
  const victim = before.findIndex(x => num(x['股數']) > 0) + 2;
  const code = String(posSheet.getRange(victim, 1).getValue());

  // 模擬「GOOGLEFINANCE 這一刻沒有這檔的資料」：市價整格空白
  const saved = String(posSheet.raw(victim, 8));
  posSheet.getRange(victim, 8).setValue('');

  const r = Position._writePanelAndAllocation(target, [], { warnings: [] });
  const panel = AssetSchema.readObjects(target.getSheetByName('指標'));
  const warn = panel.filter(x => /待修正/.test(String(x['指標'])));

  check('指標最上面出現缺價警告', warn.length === 1, JSON.stringify(warn[0] || {}));
  check('警告點名是哪一檔',
    String((warn[0] || {})['說明']).indexOf(code) >= 0,
    String((warn[0] || {})['說明']).slice(0, 40));

  // 頭四個數字是公式 —— 缺價當下算出來會偏低，但公式本身不會被凍住，
  // 報價一回來就自己對了。這裡驗的是「它是公式」而不是「值正確」。
  const rowOf = (k) => {
    const sh = target.getSheetByName('指標');
    for (let i = 2; i <= sh.getLastRow(); i++)
      if (String(sh.getRange(i, 1).getValue()) === k) return i;
    return 0;
  };
  ['總資產', '股票市值', '現金', '實體資產'].forEach(k => {
    const at = rowOf(k);
    check(k + ' 是公式，不是重算當下的死值',
      at > 0 && String(target.getSheetByName('指標').raw(at, 2)).charAt(0) === '=',
      k + ' @' + at + ' = ' + String(target.getSheetByName('指標').raw(at, 2)).slice(0, 24));
  });

  // 還原，後面的測試還要用
  posSheet.getRange(victim, 8).setValue(saved);
  Position.rebuild();
  const after = AssetSchema.readObjects(target.getSheetByName('指標'));
  // 夾具裡另有一檔測試用標的沒有假報價，所以警告不會整個消失 ——
  // 要驗的是「這一檔的報價回來之後就不再被點名」
  // 只看缺價那一類警告 —— 前面 T9 的賣超警告也點名同一檔，但那是另一回事
  const stillNamed = after
    .filter(x => /待修正/.test(String(x['指標'])) && /抓不到市價/.test(String(x['說明'])))
    .some(x => String(x['說明']).indexOf(code) >= 0);
  check('報價回來之後就不再點名這一檔', !stillNamed);
  check('總資產回到正常量級', num((after.find(x => x['指標'] === '總資產') || {})['數值']) > 0);
}

// ─── T20  目標配置% 指回「標的」而不是抄成死值 ────────────────────
// 「標的」是人手維護的輸入表。抄成死值的話，改完目標要等下一次 rebuild
// 偏離才會動；寫成 VLOOKUP 就是改完當下即時反映。
console.log('\nT20  目標配置% 跟著「標的」走');
{
  const posSheet  = target.getSheetByName('持倉');
  const instSheet = target.getSheetByName('標的');
  const TARGET_COL = AssetSchema.expected('持倉').indexOf('目標配置%') + 1;
  const DEV_COL    = AssetSchema.expected('持倉').indexOf('偏離') + 1;
  const SHARE_COL  = AssetSchema.expected('持倉').indexOf('佔總資產%') + 1;

  const at   = AssetSchema.readObjects(posSheet).findIndex(x => num(x['股數']) > 0) + 2;
  const code = String(posSheet.getRange(at, 1).getValue());
  const f    = String(posSheet.raw(at, TARGET_COL));

  check('目標配置% 是公式，不是重算當下抄過來的死值', f.charAt(0) === '=', f);
  check('公式指回「標的」表', /VLOOKUP\(\$A\d+,標的!/.test(f), f);

  // 「標的」的那一列
  const instAt = AssetSchema.readObjects(instSheet)
    .findIndex(x => String(x['代號']) === code) + 2;
  const instCol = AssetSchema.expected('標的').indexOf('目標配置%') + 1;
  const savedTarget = instSheet.raw(instAt, instCol);

  // 比例，不是 12.5 —— 佔總資產% 與配置的實際% 都是 0..1 的比例
  instSheet.getRange(instAt, instCol).setValue(0.125);

  // ⚠️ 這裡刻意**不跑** rebuild
  const row = AssetSchema.readObjects(posSheet)[at - 2];
  check('改「標的」之後不必重算，持倉就跟著變',
    num(row['目標配置%']) === 0.125, row['目標配置%']);
  check('偏離 = 佔總資產% − 目標配置%',
    Math.abs(num(posSheet.getRange(at, DEV_COL).getValue()) -
             (num(posSheet.getRange(at, SHARE_COL).getValue()) - 0.125)) < 1e-9);

  // 空白仍然是 0，不是 #N/A —— 配置那邊用 target > 0 判斷「有沒有設目標」
  instSheet.getRange(instAt, instCol).setValue('');
  check('「標的」留空時讀到 0，不是錯誤值',
    num(AssetSchema.readObjects(posSheet)[at - 2]['目標配置%']) === 0,
    AssetSchema.readObjects(posSheet)[at - 2]['目標配置%']);

  // 重算之後配置表才會把它彙總進去（配置是死值，跟持倉不同）
  instSheet.getRange(instAt, instCol).setValue(0.125);
  Position.rebuild();
  const alloc = AssetSchema.readObjects(target.getSheetByName('配置'));
  check('重算後配置表的分組目標% 含進這一檔',
    alloc.some(x => Math.abs(num(x['目標%']) - 0.125) < 1e-9),
    JSON.stringify(alloc.filter(x => x['目標%'] !== '').map(x => x['分組'] + '=' + x['目標%'])));

  instSheet.getRange(instAt, instCol).setValue(savedTarget === undefined ? '' : savedTarget);
  Position.rebuild();

  // 欄索引讀活的標題列而不是寫死：把 目標配置% 整欄搬到最後面（模擬有人直接
  // 在試算表上調欄序、卻沒動 TABS），公式要跟著搬，而不是繼續抓第 8 欄的「類型」
  const width = AssetSchema.expected('標的').length;
  const saved = instSheet.getRange(1, 1, instSheet.getLastRow(), width).getValues();
  const moved = saved.map(r => {
    const cp = r.slice();
    cp.push(cp.splice(instCol - 1, 1)[0]);            // 那一欄挪到最右邊
    return cp;
  });
  moved[0][moved[0].length - 1] = '目標配置%';
  instSheet.getRange(1, 1, moved.length, width).setValues(moved);
  instSheet.getRange(instAt, width).setValue(0.125);

  Position.rebuild();
  const movedF = String(posSheet.raw(at, TARGET_COL));
  check('欄序改變後公式跟著指到新位置',
    movedF.indexOf(',' + width + ',FALSE)') >= 0, movedF);
  check('欄序改變後讀到的還是同一個目標值',
    num(AssetSchema.readObjects(posSheet)[at - 2]['目標配置%']) === 0.125,
    AssetSchema.readObjects(posSheet)[at - 2]['目標配置%']);

  instSheet.getRange(1, 1, saved.length, width).setValues(saved);
  Position.rebuild();
  check('還原後回到原欄位',
    String(posSheet.raw(at, TARGET_COL)).indexOf(',' + instCol + ',FALSE)') >= 0,
    String(posSheet.raw(at, TARGET_COL)));
}

// ─── T21  現金餘額校正（絕對值 → 一列差額）────────────────────────
// 主人講的是「現在是多少」，帳本能記的只有「差多少」。所以校正不是去改「現金」
// 那一格（generated，下一次 rebuild 就蓋掉），而是往「交易」加一列「調整」。
// 減法必須在 AssetTools 裡做：模型看到的現金是換算過的台幣值，外幣戶差一個匯率。
console.log('\nT21  講絕對值也能改餘額');
{
  const cashSheet   = target.getSheetByName('現金');
  const tradeSheet  = target.getSheetByName('交易');
  const countTrades = () => AssetSchema.readObjects(tradeSheet).length;
  const lastTrade   = () => AssetSchema.readObjects(tradeSheet).slice(-1)[0] || {};
  const balanceOf   = (name) => {
    const r = AssetSchema.readObjects(cashSheet).find(x => String(x['帳戶']) === name);
    return r ? num(r['餘額']) : null;
  };
  const sharesOf = (code) => {
    const p = AssetSchema.readObjects(target.getSheetByName('持倉'))
      .find(x => String(x['代號']) === code);
    return p ? num(p['股數']) : 0;
  };

  const TWD = '國泰證券戶';
  const USD = '國泰外幣戶(美)';
  const heldShares = sharesOf(H0.code);

  // 擋下的情況都不可以寫進表裡
  const n0 = countTrades();
  check('未知帳戶會列出可用的帳戶',
    /沒有這個帳戶/.test(AssetTools.setCashBalance({ account: '火星銀行', balance: 1 })), '');
  check('沒給餘額時會問，不會當成 0',
    /要校正成多少/.test(AssetTools.setCashBalance({ account: TWD })), '');
  check('被擋下的都沒有寫進交易表', countTrades() === n0, countTrades() + ' vs ' + n0);

  // 往上校正（差額是合成數字，不是真實餘額）
  const before = balanceOf(TWD);
  const up = Math.round(before) + 12345;
  const r1 = AssetTools.setCashBalance({ account: TWD, balance: up, note: '對帳後補差額' });
  check('校正後餘額就是指定的數字', near(balanceOf(TWD), up, 0.01), balanceOf(TWD) + ' vs ' + up);
  const t1 = lastTrade();
  check('帳本記的是差額，不是絕對值', near(num(t1['金額']), up - before, 0.01), t1['金額']);
  check('動作是「調整」', String(t1['動作']) === '調整', t1['動作']);
  check('現金流公式認得「調整」', near(num(t1['現金流']), up - before, 0.01), t1['現金流']);
  check('備註留下校正前後的數字與原因',
    /餘額校正/.test(String(t1['備註'])) && /對帳後補差額/.test(String(t1['備註'])), t1['備註']);
  check('回覆帶回列號與校正後的餘額', /已記錄第 \d+ 列/.test(r1) && /餘額/.test(r1), r1.split('\n')[0]);

  // 往下校正 —— 「調整」是全表唯一允許負金額的動作
  const down = up - 20000;
  AssetTools.setCashBalance({ account: TWD, balance: down });
  check('往下校正寫成負的金額', num(lastTrade()['金額']) < 0, lastTrade()['金額']);
  check('往下校正後餘額仍等於指定的數字', near(balanceOf(TWD), down, 0.01), balanceOf(TWD));

  // 已經對上就不該再寫一列
  const n1 = countTrades();
  check('餘額已經對了就不寫任何一列',
    /不用校正/.test(AssetTools.setCashBalance({ account: TWD, balance: balanceOf(TWD) })) &&
    countTrades() === n1, countTrades() + ' vs ' + n1);

  // 外幣戶：填的是原幣，不是模型看得到的台幣值
  const usdBefore = balanceOf(USD);
  AssetTools.setCashBalance({ account: USD, balance: usdBefore + 100 });
  const usdRow = AssetSchema.readObjects(cashSheet).find(x => String(x['帳戶']) === USD);
  check('外幣戶校正的是原幣餘額', near(num(usdRow['餘額']), usdBefore + 100, 0.01), usdRow['餘額']);
  check('台幣值仍然是餘額 × 匯率',
    near(num(usdRow['台幣值']), (usdBefore + 100) * FX.USDTWD, 1), usdRow['台幣值']);
  check('校正列的幣別跟著帳戶走', String(lastTrade()['幣別']) === 'USD', lastTrade()['幣別']);

  // 差額只能由 setCashBalance 算出來，不能讓呼叫端自己填
  const n2 = countTrades();
  check('recordTrade 拒絕「調整」並指路到 setCashBalance',
    /setCashBalance/.test(AssetTools.recordTrade({ action: '調整', amount: 100, account: TWD })) &&
    countTrades() === n2, countTrades() + ' vs ' + n2);

  // 順手修的：存提的幣別也該跟著帳戶，寫死 TWD 會讓外幣戶的每一列都在說謊
  AssetTools.recordTrade({ action: '存入', amount: 50, account: USD });
  check('存入外幣戶時幣別是 USD', String(lastTrade()['幣別']) === 'USD', lastTrade()['幣別']);

  // 校正只動現金
  check('校正不會碰到持倉', sharesOf(H0.code) === heldShares, sharesOf(H0.code) + ' vs ' + heldShares);
}

// ─── T22  開新帳戶 ───────────────────────────────────────────────
// 「帳戶」是輸入層，在 addAccount 之前只能手改 —— 模型碰到「我開了一個新戶頭」
// 無路可走，於是編了一句「已建立完成」。缺工具的代價是它說謊，不是它拒絕。
console.log('\nT22  開新帳戶');
{
  const acctSheet = target.getSheetByName('帳戶');
  const cashSheet = target.getSheetByName('現金');
  const countAccounts = () => AssetSchema.readObjects(acctSheet).length;
  const cashRowOf = (name) =>
    AssetSchema.readObjects(cashSheet).find(x => String(x['帳戶']) === name);

  const n0 = countAccounts();
  check('沒給名字時會問，不會建一列空的',
    /要叫什麼名字/.test(AssetTools.addAccount({})), '');
  check('重複的帳戶名被擋下',
    /已經在/.test(AssetTools.addAccount({ name: '國泰證券戶' })), '');
  check('看不懂的幣別被擋下',
    /幣別/.test(AssetTools.addAccount({ name: '測試戶A', currency: '美金' })), '');
  check('不合法的類型被擋下',
    /類型只能/.test(AssetTools.addAccount({ name: '測試戶A', type: '定存' })), '');
  check('被擋下的都沒有寫進帳戶表', countAccounts() === n0, countAccounts() + ' vs ' + n0);

  // 台幣戶
  const r1 = AssetTools.addAccount({ name: '台新銀行', balance: 2131, institution: '台新銀行' });
  check('建立成功並回報類型與幣別', /已建立帳戶/.test(r1) && /現金／TWD/.test(r1), r1.split('\n')[0]);
  check('帳戶表多一列', countAccounts() === n0 + 1, countAccounts() + ' vs ' + (n0 + 1));
  const newAcct = AssetSchema.readObjects(acctSheet).find(x => x['帳戶'] === '台新銀行') || {};
  check('狀態預設啟用', String(newAcct['狀態']) === '啟用', newAcct['狀態']);
  check('期初日期有填', /^\d{4}-\d{2}-\d{2}$/.test(String(newAcct['期初日期'])), newAcct['期初日期']);
  check('重算後「現金」跟著多一列', !!cashRowOf('台新銀行'), '');
  check('新帳戶餘額 = 期初餘額', near(num(cashRowOf('台新銀行')['餘額']), 2131, 0.01),
    cashRowOf('台新銀行')['餘額']);
  check('回覆提醒期初餘額之後不要再改', /setCashBalance/.test(r1), r1);

  // 建完就能直接記帳與校正
  AssetTools.recordTrade({ action: '存入', amount: 869, account: '台新銀行' });
  check('新帳戶馬上可以記交易', near(num(cashRowOf('台新銀行')['餘額']), 3000, 0.01),
    cashRowOf('台新銀行')['餘額']);
  AssetTools.setCashBalance({ account: '台新銀行', balance: 2500 });
  check('新帳戶馬上可以校正餘額', near(num(cashRowOf('台新銀行')['餘額']), 2500, 0.01),
    cashRowOf('台新銀行')['餘額']);

  // 外幣戶：幣別轉大寫、類型跟著推成「外幣」、台幣值走匯率
  const r2 = AssetTools.addAccount({ name: '測試外幣戶', currency: 'usd', balance: 100 });
  check('幣別轉成大寫', /外幣／USD/.test(r2), r2.split('\n')[0]);
  check('外幣戶的台幣值 = 餘額 × 匯率',
    near(num(cashRowOf('測試外幣戶')['台幣值']), 100 * FX.USDTWD, 1),
    cashRowOf('測試外幣戶')['台幣值']);
  check('推出來的類型有講明是推的', /照名稱與幣別推/.test(r2), r2);

  // 名稱含「證券」→ 類型推成證券（買賣自動選戶就是看這個）
  const r3 = AssetTools.addAccount({ name: '測試證券戶' });
  check('名稱含證券時類型推成證券', /證券／TWD/.test(r3), r3.split('\n')[0]);
  check('多了第二個證券戶之後，買賣就必須講清楚記在哪',
    /要記在哪個帳戶/.test(AssetTools.recordTrade({
      action: '買進', symbol: H0.code, shares: 1000, price: 50 })), '');
}

// ─── T23  作廢記錯的交易 ──────────────────────────────────────────
// 帳本是 append-only，但 append-only 需要的是「撤銷的方法」而不是「不准動」。
// 作廢打的是墓碑：列留著、原始數字留著，只是不再計入任何統計。
// ⚠️ 不能用「反手記一筆相反的交易」代替 —— 那在股票上會被算成真的處分。
console.log('\nT23  作廢記錯的交易');
{
  const tradeSheet = target.getSheetByName('交易');
  const cashSheet  = target.getSheetByName('現金');
  const posSheet   = target.getSheetByName('持倉');
  const realSheet  = target.getSheetByName('已實現損益');
  const ACC  = '國泰證券戶';
  const code = H0.code;

  const countRows  = () => AssetSchema.readObjects(tradeSheet).length;
  const posOf      = (c) => AssetSchema.readObjects(posSheet).find(x => String(x['代號']) === c) || {};
  const balanceOf  = (n) => {
    const r = AssetSchema.readObjects(cashSheet).find(x => String(x['帳戶']) === n);
    return r ? num(r['餘額']) : null;
  };
  const rowOf      = (r) => AssetSchema.readTrades(target, { includeVoid: true }).find(x => x.__row === r);
  const rowNumOf   = (out) => { const m = out.match(/已記錄第 (\d+) 列/); return m ? +m[1] : 0; };
  const divTotal   = () => Snapshot.dividendSeries(target).byYear.reduce((s, y) => s + y.total, 0);

  // ── 買進記錯：持倉與餘額都必須回到原點 ──
  const shares0 = num(posOf(code)['股數']);
  const cost0   = num(posOf(code)['總成本']);
  const bal0    = balanceOf(ACC);
  const rows0   = countRows();

  const BUY_QTY = 1000, BUY_PRICE = 20, BUY_FEE = 30;
  const buyRow = rowNumOf(AssetTools.recordTrade({
    action: '買進', symbol: code, shares: BUY_QTY, price: BUY_PRICE, fee: BUY_FEE, account: ACC }));
  check('買進有回報列號', buyRow >= 2, buyRow);
  check('買進後股數增加', num(posOf(code)['股數']) === shares0 + BUY_QTY, num(posOf(code)['股數']));
  check('買進後餘額減少',
    near(balanceOf(ACC), bal0 - (BUY_QTY * BUY_PRICE + BUY_FEE), 0.01), balanceOf(ACC));

  const v1 = AssetTools.voidTrade({ row: buyRow, reason: '股數打錯' });
  check('作廢後股數回到原本', num(posOf(code)['股數']) === shares0, num(posOf(code)['股數']));
  check('作廢後總成本回到原本', near(num(posOf(code)['總成本']), cost0, 0.01), num(posOf(code)['總成本']));
  check('作廢後餘額回到原本', near(balanceOf(ACC), bal0, 0.01), balanceOf(ACC));
  check('回覆帶回列號與原因', /已作廢第 \d+ 列/.test(v1) && /股數打錯/.test(v1), v1.split('\n')[0]);

  // ── 墓碑：列還在，數字也還在 ──
  const dead = rowOf(buyRow);
  check('那一列沒有被刪掉', countRows() === rows0 + 1, countRows() + ' vs ' + (rows0 + 1));
  check('原始股數仍留在表上', num(dead['股數']) === BUY_QTY, dead['股數']);
  check('狀態標成作廢', String(dead['狀態']) === AssetSchema.VOID, dead['狀態']);
  // ⚠️ 這一格是整個作廢機制的關鍵：現金表的「交易淨流」是整欄 SUMIF，
  //    它不知道 JS 那邊過濾掉了什麼 —— 公式沒失效就會變成「列跳過了、錢還在」
  check('現金流失效成空字串（不是留著死值）', String(dead['現金流']) === '', JSON.stringify(dead['現金流']));
  check('備註保留原因', /股數打錯/.test(String(dead['備註'])), dead['備註']);
  check('readTrades 預設讀不到作廢的列',
    !AssetSchema.readTrades(target).some(x => x.__row === buyRow), '');

  // ── 股利：Snapshot 的統計也要跟著退回去 ──
  const div0 = num(posOf(code)['累計股利']);
  const divSum0 = divTotal();
  const DIV = 1234;
  const divRow = rowNumOf(AssetTools.recordTrade({
    action: '股利', symbol: code, amount: DIV, account: ACC }));
  check('股利入帳', near(num(posOf(code)['累計股利']), div0 + DIV, 0.01), num(posOf(code)['累計股利']));
  AssetTools.voidTrade({ row: divRow, reason: '重複登記' });
  check('作廢股利後累計股利回到原本', near(num(posOf(code)['累計股利']), div0, 0.01), num(posOf(code)['累計股利']));
  check('股利統計（Snapshot）也不再算它', near(divTotal(), divSum0, 0.01), divTotal() + ' vs ' + divSum0);

  // ── 賣出：已實現損益整列消失，不是多一筆反向的 ──
  const real0 = num(posOf(code)['已實現損益']);
  const realRows0 = AssetSchema.readObjects(realSheet).length;
  const sellRow = rowNumOf(AssetTools.recordTrade({
    action: '賣出', symbol: code, shares: 100, price: SELL_PRICE, fee: 20, tax: 5, account: ACC }));
  check('賣出產生一列已實現損益',
    AssetSchema.readObjects(realSheet).length === realRows0 + 1, AssetSchema.readObjects(realSheet).length);
  AssetTools.voidTrade({ row: sellRow, reason: '根本沒賣' });
  check('作廢賣出後已實現損益回到原本', near(num(posOf(code)['已實現損益']), real0, 0.01), num(posOf(code)['已實現損益']));
  check('已實現損益表也退回原本的列數（不是多一筆反向的）',
    AssetSchema.readObjects(realSheet).length === realRows0, AssetSchema.readObjects(realSheet).length);

  // ── 沒有的股票不給賣：擋在寫入之前，不是寫完再警告 ──
  // 持倉那邊會跳過賣不掉的部分，但那一列的現金流是自己的公式算的、看不到持倉 ——
  // 硬記下去就是股票沒動、錢卻入帳。作廢買進之後那檔就該賣不掉了。
  const NEW2 = '0002T';
  const buy2 = rowNumOf(AssetTools.recordTrade({
    action: '買進', symbol: NEW2, shares: 500, price: 10, account: ACC }));
  const nBefore = countRows();
  check('賣超持股被擋下，並講出實際有幾股',
    /只有 500 股/.test(AssetTools.recordTrade({
      action: '賣出', symbol: NEW2, shares: 600, price: 12, account: ACC })), '');
  AssetTools.voidTrade({ row: buy2, reason: '這筆買進是假的' });
  check('把買進作廢之後，那一檔就賣不掉了',
    /手上沒有/.test(AssetTools.recordTrade({
      action: '賣出', symbol: NEW2, shares: 500, price: 12, account: ACC })), '');
  check('被擋下的賣出都沒有寫進交易表',
    countRows() === nBefore, countRows() + ' vs ' + nBefore);

  // ── 擋下來的情況 ──
  const epochRow = (AssetSchema.readTrades(target).find(x => String(x['動作']) === '期初') || {}).__row;
  check('不存在的列號被擋下', /沒有第 9999 列/.test(AssetTools.voidTrade({ row: 9999, reason: 'x' })), '');
  check('沒給列號時會問，不會亂猜', /要作廢哪一列/.test(AssetTools.voidTrade({ reason: 'x' })), '');
  check('已作廢的列不會再作廢一次',
    /已經是作廢狀態/.test(AssetTools.voidTrade({ row: buyRow, reason: 'x' })), '');
  check('「期初」列不給作廢（拿掉它後續賣出會整批被跳過）',
    !!epochRow && /期初/.test(AssetTools.voidTrade({ row: epochRow, reason: 'x' })), epochRow);

  // ── listTrades：作廢要指定列號，列號就得有地方查 ──
  const lt = AssetTools.listTrades({ symbol: code, limit: 5 });
  check('listTrades 每筆都帶實際列號', /第 \d+ 列/.test(lt), lt.split('\n')[1]);
  check('listTrades 預設不列作廢的（但會說有幾筆被藏起來）',
    !/⛔ 已作廢/.test(lt) && /已作廢未列出/.test(lt), lt.split('\n')[0]);
  check('includeVoid 才看得到作廢的列',
    /⛔ 已作廢/.test(AssetTools.listTrades({ symbol: code, limit: 50, includeVoid: true })), '');
  check('listTrades 認得動作的口語說法',
    /賣出/.test(AssetTools.listTrades({ symbol: code, action: '賣掉', limit: 5, includeVoid: true })), '');

  // ── 轉帳只作廢一腿：沒有欄位把兩腿綁在一起，也不碰持倉，所以沒有人會發現 ──
  const legOut = rowNumOf(AssetTools.recordTrade({ action: '轉出', amount: 5000, account: ACC }));
  const vLeg = AssetTools.voidTrade({ row: legOut, reason: '轉錯帳戶' });
  check('作廢轉帳的一腿時會警告另一腿還在',
    /轉帳是兩列/.test(vLeg) && /5,000/.test(vLeg), vLeg.split('\n')[2]);

  // ── 與匯入去重的關係：作廢是刻意的，重送同一份檔案不該讓它復活 ──
  const H2 = HOLD[2];
  const STM2 = '股名,日期,成交股數,淨收付,成交單價,成交價金,手續費,交易稅,稅款,委託書號,幣別,備註\n' +
    H2.name + ',2026/09/01,100,"-1,022",10,"1,000",22,0,0,Z0001,台幣,\n';
  const n0 = countRows();
  AssetImport.importStatement(STM2, { account: ACC });    // 有兩個證券戶，要講清楚
  check('對帳單匯入一列', countRows() === n0 + 1, countRows() + ' vs ' + (n0 + 1));
  // 用內容鍵找那一列，不要用「最後一列」—— 後者在匯入失敗時會指到別人身上
  const impRow = (AssetSchema.readTrades(target)
    .find(x => /Z0001/.test(String(x['備註']))) || {}).__row;
  check('匯入的列有內容鍵', impRow >= 2, impRow);
  AssetTools.voidTrade({ row: impRow, reason: '券商重複出帳' });
  check('作廢後備註裡的匯入鍵還在（去重才認得出來）',
    /stm:/.test(String(rowOf(impRow)['備註'])), rowOf(impRow)['備註']);
  const n1 = countRows();
  AssetImport.importStatement(STM2, { account: ACC });
  check('重送同一份檔案不會讓作廢的列復活', countRows() === n1, countRows() + ' vs ' + n1);
}

// ─── T24  主檔的修改：標的與帳戶 ──────────────────────────────────
// 主檔沒有「再記一筆」可以退：名稱與目標配置% 都是 VLOOKUP 回主檔，
// 新建一列正確的並不會讓舊的失效。所以「改」是唯一的修正路徑，
// 而且改名是**跨兩張表**的事 —— 這正是手改試算表最容易漏的一步。
console.log('\nT24  主檔的修改');
{
  const instSheet = target.getSheetByName('標的');
  const cashSheet = target.getSheetByName('現金');
  const posSheet  = target.getSheetByName('持倉');
  const instOf    = (c) => AssetSchema.readObjects(instSheet).find(x => String(x['代號']) === c) || {};
  const posOf     = (c) => AssetSchema.readObjects(posSheet).find(x => String(x['代號']) === c) || {};
  const balanceOf = (n) => {
    const r = AssetSchema.readObjects(cashSheet).find(x => String(x['帳戶']) === n);
    return r ? num(r['餘額']) : null;
  };
  const totalAssets = () => num((AssetSchema.readObjects(target.getSheetByName('指標'))
    .find(x => String(x['指標']) === '總資產') || {})['數值']);
  const code = H0.code;

  // ── 目標配置%：比例不是百分比 ──
  const target0 = num(instOf(code)['目標配置%']);
  check('填百分比（15）會被擋下並說清楚要填 0.15',
    /0 到 1/.test(AssetTools.updateInstrument({ symbol: code, target: 15 })), '');
  check('被擋下時沒有寫進去', num(instOf(code)['目標配置%']) === target0, instOf(code)['目標配置%']);

  AssetTools.updateInstrument({ symbol: code, target: 0.15 });
  check('比例寫進「標的」', near(num(instOf(code)['目標配置%']), 0.15, 1e-9), instOf(code)['目標配置%']);
  check('「持倉」的目標配置% 跟著（指回去的公式，不是抄過來的死值）',
    near(num(posOf(code)['目標配置%']), 0.15, 1e-9), posOf(code)['目標配置%']);
  check('偏離 = 佔總資產% − 目標配置%',
    near(num(posOf(code)['偏離']), num(posOf(code)['佔總資產%']) - 0.15, 1e-6), posOf(code)['偏離']);

  check('未知代號被擋下並列出現有的',
    /沒有 XXXX/.test(AssetTools.updateInstrument({ symbol: 'XXXX', name: 'x' })), '');
  check('沒給任何要改的欄位時會問', /要改什麼/.test(AssetTools.updateInstrument({ symbol: code })), '');

  // ── 自動建立的標的只生得出半個 ──
  // recordTrade 買進新代號時會自動登記一列，但區域／類型一律留空，
  // 而「配置」就是按這兩欄分組的 —— 沒有 updateInstrument 就永遠補不起來。
  const NEW = '0000T';
  AssetTools.recordTrade({ action: '買進', symbol: NEW, shares: 100, price: 10, account: '國泰證券戶' });
  check('自動建立的標的區域與類型是空的',
    !String(instOf(NEW)['區域']) && !String(instOf(NEW)['類型']), JSON.stringify(instOf(NEW)['區域']));
  check('listInstruments 會點名缺欄位的標的',
    new RegExp(NEW + '（缺 區域、類型）').test(AssetTools.listInstruments()), '');
  AssetTools.updateInstrument({ symbol: NEW, name: '測試標的', region: '測試區', category: '測試類' });
  check('補上之後「配置」多出那個分組',
    AssetSchema.readObjects(target.getSheetByName('配置')).some(x => String(x['分組']) === '測試區'), '');
  check('名稱補上之後交易列的名稱公式也跟著（VLOOKUP 回標的）',
    AssetSchema.readTrades(target).some(x => String(x['代號']) === NEW && String(x['名稱']) === '測試標的'), '');

  // ── 帳戶改名：主檔改了、交易沒改，餘額會靜靜掉回期初 ──
  const OLD = '台新銀行', RENAMED = '台新銀行(數位)';
  const bal0 = balanceOf(OLD);
  const r1 = AssetTools.updateAccount({ name: OLD, newName: RENAMED });
  check('改名後舊名字不在「現金」表了', balanceOf(OLD) === null, balanceOf(OLD));
  check('改名後餘額原封不動（交易列一起改寫了）',
    near(balanceOf(RENAMED), bal0, 0.01), balanceOf(RENAMED) + ' vs ' + bal0);
  check('回覆說明改寫了幾列交易', /「交易」裡 \d+ 列/.test(r1), r1);
  check('交易列真的指向新名字',
    AssetSchema.readTrades(target).filter(x => String(x['帳戶']) === RENAMED).length >= 2, '');
  check('改成已存在的名字會被擋下',
    /已經是另一個帳戶的名字/.test(AssetTools.updateAccount({ name: RENAMED, newName: '國泰證券戶' })), '');

  // ── 幣別：有交易之後不給改 ──
  check('已經有交易的帳戶不給改幣別',
    /不能改幣別/.test(AssetTools.updateAccount({ name: '國泰證券戶', currency: 'USD' })), '');

  // ── 停用：帳戶不能刪，只能停用；而且錢要先清乾淨 ──
  check('還有錢就不給停用（那筆錢會從總資產上消失）',
    /不能直接停用/.test(AssetTools.updateAccount({ name: RENAMED, status: '停用' })), '');
  AssetTools.setCashBalance({ account: RENAMED, balance: 0 });
  const total0 = totalAssets();
  const r2 = AssetTools.updateAccount({ name: RENAMED, status: '停用' });
  check('餘額歸零後可以停用', /狀態：啟用 → 停用/.test(r2), r2);
  check('停用後從「現金」表消失', balanceOf(RENAMED) === null, balanceOf(RENAMED));
  check('停用沒有動到總資產（因為餘額本來就是 0）',
    near(totalAssets(), total0, 1), totalAssets() + ' vs ' + total0);

  // ── listAccounts：停用的帳戶從「現金」表消失，但主檔還在，得看得見 ──
  const la = AssetTools.listAccounts();
  check('listAccounts 連停用的帳戶都列出來',
    new RegExp('\\[停用\\] ' + RENAMED.replace(/[()]/g, '\\$&')).test(la),
    la.split('\n').filter(x => /停用/.test(x))[0]);
  check('listAccounts 給的是原幣，並且講明了', /原幣/.test(la), la.split('\n').pop());
  check('外幣戶同時給原幣與台幣值', /USD（台幣值/.test(la), '');

  check('可以重新啟用', /停用 → 啟用/.test(AssetTools.updateAccount({ name: RENAMED, status: '啟用' })), '');
  check('不存在的帳戶被擋下並列出現有的',
    /沒有這個帳戶/.test(AssetTools.updateAccount({ name: '火星銀行', note: 'x' })), '');
  check('不合法的狀態被擋下',
    /狀態只能/.test(AssetTools.updateAccount({ name: RENAMED, status: '關閉' })), '');
}

// 選用：拿真實的券商匯出檔跑一次解析，只印不斷言（檔案不進版控）
// ─── T25  XIRR 的錨點與殖利率 ────────────────────────────────────
//
// 期初列不是買進，是開帳餘額。舊版拿它的**成本**當第一筆負現金流，等於宣稱
// 「遷移日花了那筆成本，幾天後值今天的市值」—— 一輩子的獲利被壓進幾天裡年化，
// 真正的解會跑到 10¹⁵ 那種量級，遠在求解區間外，於是靜靜回 null，而說明欄還
// 寫著「時間跨度不足」。這裡驗證改用「錨定日前一天的市值」開帳之後有解。
console.log('\nT25  XIRR 錨點與殖利率');
{
  const tradeSheet = target.getSheetByName('交易');
  const anchorRow = AssetSchema.readObjects(tradeSheet).find(r => String(r['動作']) === '期初');
  const anchor = anchorRow['日期'] instanceof Date ? anchorRow['日期'] : new Date(String(anchorRow['日期']));
  const day = (n) => { const d = new Date(anchor); d.setDate(d.getDate() + n); return d; };
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
                     '-' + String(d.getDate()).padStart(2, '0');

  const snapSheet = target.getSheetByName('每日快照');
  // 開帳市值刻意用「真實市值的一半」這種合成值：只要 XIRR 有解就算過，
  // 不能把真實金額寫進這個檔案（見 README「不可進 git 的東西」）
  const panelBefore = AssetSchema.readObjects(target.getSheetByName('指標'));
  const MV = num((panelBefore.find(x => x['指標'] === '股票市值') || {})['數值']);
  const OPEN = Math.round(MV * 0.5);

  // 只留一列：早於錨定日 120 天的股票市值。writeBlock 會把既有列清掉，
  // 所以 _openingValue 只會挑到它 —— 跨度 120 天 > 90 天門檻，該出數字了
  AssetSchema.writeBlock(snapSheet,
    [[ymd(day(-120)), '合計', '股票市值', '', '', '', OPEN, 'TWD', '交易日']], 9);

  const open = Position._openingValue(target, anchor);
  check('_openingValue 取到早於錨定日的那一天', open !== null && num(open.value) === OPEN,
    open ? ymd(open.date) + ' / ' + money(open.value) : 'null');

  Position.rebuild();
  const panel = AssetSchema.readObjects(target.getSheetByName('指標'));
  const row = k => (panel.find(x => x['指標'] === k) || {});
  const xv = row('XIRR（年化）')['數值'];
  check('跨度超過門檻後 XIRR 算得出數字（不再是空白）', String(xv) !== '' && isFinite(num(xv)), String(xv));
  check('XIRR 說明講明是自開帳市值起算', /開帳市值/.test(String(row('XIRR（年化）')['說明'])),
    String(row('XIRR（年化）')['說明']));
  check('開帳市值低於期末市值 → XIRR 為正', num(xv) > 0, String(xv));

  // ── 殖利率 ────────────────────────────────────────────────────
  //
  // 用**差分**驗證，不重算一份絕對值：這張表上的近 12 個月股利來自遷移進來的
  // 真實配息，把它在測試裡重算一遍等於把同一段邏輯抄第二份，抄錯了兩邊一起錯。
  // 「多記一筆該算的就多多少、多記一筆不該算的就不動」才是真正要守的規則。
  const held = AssetSchema.readObjects(target.getSheetByName('持倉'))
    .filter(x => num(x['股數']) > 0).map(x => String(x['代號']));
  const metric = () => {
    const t = AssetSchema.readObjects(target.getSheetByName('指標'));
    const g = k => num((t.find(x => x['指標'] === k) || {})['數值']);
    return { cur: g('現值殖利率'), cost: g('成本殖利率'), mv: g('股票市值'), amt: g('股票投入成本'),
             note: String((t.find(x => x['指標'] === '現值殖利率') || {})['說明']) };
  };
  const addDiv = (code, amount, daysAgo, memo) => AssetSchema.appendTrade({
    日期: ymd(day(-daysAgo)), 動作: '股利', 代號: code, 金額: amount,
    幣別: 'TWD', 帳戶: '國泰證券戶', 分類: '投資', 備註: memo,
    來源: 'test', 建立時間: ymd(day(-daysAgo)) + ' 18:00:00'
  }, target);

  const m0 = metric();
  check('殖利率一開始就有值（遷移進來的配息本來就有真實日期）', m0.cur > 0 && m0.cost > 0,
    m0.cur + ' / ' + m0.cost);

  const DIV = 12345;                                   // 合成金額
  addDiv(held[0], DIV, 30, 'T25 現有持股、12 個月內');
  Position.rebuild();
  const m1 = metric();
  check('現有持股的新配息讓現值殖利率剛好增加 配息÷市值',
    near(m1.cur - m0.cur, DIV / m1.mv, 3e-6), (m1.cur - m0.cur) + ' vs ' + (DIV / m1.mv));
  check('成本殖利率同步增加 配息÷成本',
    near(m1.cost - m0.cost, DIV / m1.amt, 3e-6), (m1.cost - m0.cost) + ' vs ' + (DIV / m1.amt));

  addDiv('ZZ9999', 99999, 30, 'T25 已出清標的');
  Position.rebuild();
  check('已出清標的的配息完全不進分子', near(metric().cur, m1.cur, 1e-9), String(metric().cur));

  addDiv(held[0], 88888, 400, 'T25 一年以前');
  Position.rebuild();
  const m2 = metric();
  check('一年以前的配息完全不進分子', near(m2.cur, m1.cur, 1e-9), String(m2.cur));

  // 兩個指標的比值恆等於 市值÷成本（= 1 + 未實現報酬率）——
  // 這正是「成本殖利率沒有帶來新資訊」的證明，寫成斷言留著
  check('成本殖利率 ÷ 現值殖利率 = 市值 ÷ 成本',
    near(m2.cost / m2.cur, m2.mv / m2.amt, 1e-3), (m2.cost / m2.cur) + ' vs ' + (m2.mv / m2.amt));
  check('說明欄講明分子只算現有持股', /僅計現有持股/.test(m2.note), m2.note);
}

// ─── T26  第三層報價：公式死光時由 GAS 自己抓 ────────────────────
//
// 2026-08-07 六檔裡五檔沒有市價，而 =GOOGLEFINANCE("TPE:00878","price") 單獨貼
// 一格也是 #N/A —— 掛的是 GOOGLEFINANCE 本身。這種時候第二層的 IMPORTDATA 通常
// 一起死（兩個都是試算表側的外部函式，同一份文件層級節流），備援疊在同一層等於
// 沒有備援。第三層必須跳出試算表，走 UrlFetchApp。
console.log('\nT26  公式抓不到價時的第三層備援');
{
  const posSheet = target.getSheetByName('持倉');
  const rows = AssetSchema.readObjects(posSheet);
  const idx = rows.findIndex(x => num(x['股數']) > 0);
  const victim = idx + 2;
  const code = String(posSheet.getRange(victim, 1).getValue());
  const saved = String(posSheet.raw(victim, 8));
  const FALLBACK_PRICE = 77.7;                       // 合成報價

  // 兩層公式都空手而回 = H 是空字串（那正是 _priceFormula 內層 IFERROR 的產物）
  posSheet.getRange(victim, 8).setValue('');

  const asked = [];
  global.UrlFetchApp = global.UrlFetchApp || {};     // 只是讓守門條件過得去
  global.StockPrice = {
    getRawPrices: (list) => {
      list.forEach(c => asked.push(c));
      return list.map(c => ({ code: c, current: c === code ? FALLBACK_PRICE : 0 }));
    }
  };

  const inst = {};
  AssetSchema.readObjects(target.getSheetByName('標的'))
    .forEach(i => { inst[String(i['代號'])] = i; });

  const fix = Position._fillMissingPrices(target, inst);

  check('只去問缺價的那一檔，有價的不重抓', asked.indexOf(code) >= 0 && asked.length >= 1,
    JSON.stringify(asked));
  check('抓到的價寫進正確的那一列（不是 index+2 錯位）',
    num(posSheet.getRange(victim, 8).getValue()) === FALLBACK_PRICE,
    String(posSheet.getRange(victim, 8).getValue()));
  check('回報補了哪幾檔', fix.filled.some(x => x.code === code), JSON.stringify(fix.filled));
  check('寫進去的是死值不是公式', String(posSheet.raw(victim, 8)).charAt(0) !== '=',
    String(posSheet.raw(victim, 8)).slice(0, 20));
  check('市值跟著算出來（$I 的公式看得到新的 $H）',
    num(posSheet.getRange(victim, 9).getValue()) > 0,
    String(posSheet.getRange(victim, 9).getValue()));

  // 端點也回不出價的情況：不能假裝有價，要留在 stillMissing 讓警告點名
  posSheet.getRange(victim, 8).setValue('');
  global.StockPrice = { getRawPrices: (list) => list.map(c => ({ code: c, current: 0 })) };
  const fix2 = Position._fillMissingPrices(target, inst);
  check('第三層也抓不到就照實留白，不編一個價',
    fix2.filled.length === 0 && fix2.stillMissing.indexOf(code) >= 0 &&
    String(posSheet.getRange(victim, 8).getValue()) === '',
    JSON.stringify(fix2));

  delete global.StockPrice;
  posSheet.getRange(victim, 8).setValue(saved);
  Position.rebuild();
}

// ─── T27  被擋下的寫入不能算成「寫過了」──────────────────────────
//
// 這是假宣稱攔截器的地基。以前 ChatBot 看的是「模型有沒有叫寫入工具」，而旗子掀在
// Tools.execute 之前 —— 工具被業務規則擋下時帳本一個字沒改，攔截器卻已放行，
// 偏偏那正是最容易出現假「已記錄」的場合。現在證據取自寫入本身，這裡就是在釘死
// 「擋下 → 計數器不動」與「寫成功 → 計數器一定動」這兩個方向。
console.log('\nT27  擋下的寫入不算寫入');
{
  const held = AssetSchema.readObjects(target.getSheetByName('持倉'))
    .filter(p => num(p['股數']) > 0);
  const code = String(held[0]['代號']);
  const shares = num(held[0]['股數']);

  // ① 賣超被擋下：recordTrade 整筆不寫
  const before = Utils.ledgerWriteCount();
  const blocked = AssetTools.recordTrade({
    action: '賣出', symbol: code, shares: shares + 100000, price: 50,
    account: '國泰證券戶', date: '2026-08-03'
  });
  check('賣超確實被擋下（沒有寫進去）', !/已記錄第/.test(blocked), String(blocked).slice(0, 60));
  check('擋下時計數器沒有動', Utils.ledgerWriteCount() === before,
    before + ' → ' + Utils.ledgerWriteCount());

  // ② 參數不齊：連動作都判斷不了
  const before2 = Utils.ledgerWriteCount();
  AssetTools.recordTrade({ action: '買進', symbol: code });   // 缺股數與單價
  check('參數不齊時計數器沒有動', Utils.ledgerWriteCount() === before2,
    before2 + ' → ' + Utils.ledgerWriteCount());

  // ③ 不存在的帳戶
  const before3 = Utils.ledgerWriteCount();
  AssetTools.setCashBalance({ account: '不存在的戶頭', balance: 123 });
  check('帳戶不存在時計數器沒有動', Utils.ledgerWriteCount() === before3,
    before3 + ' → ' + Utils.ledgerWriteCount());

  // ④ 真的寫成功時一定要動 —— 否則上面三條可以靠「永遠不動」作弊通過
  const before4 = Utils.ledgerWriteCount();
  const ok = AssetTools.recordTrade({
    action: '買進', symbol: code, shares: 1000, price: 10,
    account: '國泰證券戶', date: '2026-08-03', note: 'T27 寫入成功'
  });
  check('寫成功時計數器有動', Utils.ledgerWriteCount() > before4,
    before4 + ' → ' + Utils.ledgerWriteCount() + ' ｜ ' + String(ok).slice(0, 40));

  // ⑤ 更新主檔但值沒變 → 沒動到試算表，不算寫入
  const inst = AssetSchema.readObjects(target.getSheetByName('標的'))
    .find(i => String(i['代號']) === code);
  const before5 = Utils.ledgerWriteCount();
  AssetTools.updateInstrument({ symbol: code, name: String(inst['名稱']) });
  check('主檔值沒變時計數器沒有動', Utils.ledgerWriteCount() === before5,
    before5 + ' → ' + Utils.ledgerWriteCount());
}

// ─── T28  拿不到當日成交價時，不准生出 0% ────────────────────────
//
// 收盤後 MIS 的「最近成交價」是空的，程式退回用昨收當現價，於是
// 「今天漲跌」變成昨收減昨收 —— 恆等於 0，而且長得跟「今天平盤」一模一樣。
// 舊版就這樣一路傳到 LLM 面前，於是每到盤後 Iris 就會說每一檔都剛好平盤。
// 這裡釘死三層：源頭不造 0、中間不把 null 轉回 0、輸出講明取不到。
console.log('\nT28  取不到當日成交價不算平盤');
{
  const savedSP    = global.StockPrice;
  const savedFetch = global.UrlFetchApp;

  const misReply = (rows) => ({
    getResponseCode: () => 200,
    getContentText:  () => JSON.stringify({ msgArray: rows })
  });

  // ① 源頭：z 是 '-'（沒有當日成交價）→ changePct 必須是 null，不是 0
  global.UrlFetchApp = { fetch: () => misReply([
    { c: 'AAAA', n: '收盤後',   z: '-',    y: '50.00' },
    { c: 'BBBB', n: '真的平盤', z: '50.00', y: '50.00' },
    { c: 'CCCC', n: '真的漲',   z: '55.00', y: '50.00' }
  ]) };
  load('StockPrice.gs');   // 覆蓋掉 harness 的 stub，測真的那支

  const raw = StockPrice.getRawPrices(['AAAA', 'BBBB', 'CCCC']);
  const byCode = {};
  raw.forEach(r => { byCode[r.code] = r; });

  check('沒有當日成交價 → changePct 是 null 不是 0',
    byCode.AAAA.changePct === null && byCode.AAAA.isClosed === true,
    JSON.stringify(byCode.AAAA));
  check('真的平盤 → changePct 是 0（不能一起變成 null）',
    byCode.BBBB.changePct === 0 && byCode.BBBB.isClosed === false,
    JSON.stringify(byCode.BBBB));
  check('有成交且上漲 → changePct 照算',
    Math.abs(byCode.CCCC.changePct - 0.1) < 1e-9,
    JSON.stringify(byCode.CCCC));

  // ② 中間層：_round(null) 是 0，Snapshot 不能讓「不知道」在這裡復活
  const held = AssetSchema.readObjects(target.getSheetByName('持倉'))
    .filter(p => num(p['股數']) > 0);
  const code = String(held[0]['代號']);

  global.StockPrice = { getRawPrices: () => [
    { code: code, name: 'X', current: 50, yesterday: 50, changePct: null, isClosed: true }
  ] };
  const rows = Snapshot._holdings(target);
  const row  = rows.find(r => r.code === code);
  check('Snapshot 把 null 原樣傳下去，沒有變成 0',
    row.dayChangePct === null, JSON.stringify(row.dayChangePct));
  check('isClosed 有帶出去（輸出層才有辦法講清楚）',
    row.isClosed === true, JSON.stringify(row.isClosed));

  // ③ 輸出層：給 LLM 的文字不准出現「今日: 0.00%」
  load('GoogleSheet.gs');
  const text = GoogleSheet.getHoldings();
  check('給 LLM 的持倉文字沒有假的 0.00% 當日漲跌',
    text.indexOf('今日: 0.00%') < 0 && text.indexOf('今日: +0.00%') < 0,
    text.split('\n').filter(l => l.indexOf('今日') >= 0).join(' ｜ ').slice(0, 120));
  check('而且明講取不到，不是默默省略',
    /取不到當日成交價/.test(text),
    text.split('\n').filter(l => l.indexOf('今日') >= 0)[0] || '(沒有任何今日欄位)');

  global.StockPrice = savedSP;
  global.UrlFetchApp = savedFetch;
}

// ─── T29  給 LLM 的文字要帶著時點與異常標記 ──────────────────────
//
// 與 T28 同一種病：資訊在下層算好了，排版時被丟掉，模型只好用猜的。
// 這裡管兩支：getHistory 丟掉快照的「狀態」，getHoldings 沒有任何時點。
console.log('\nT29  數字要帶著「什麼時候、可不可信」一起出去');
{
  const snapSheet = target.getSheetByName('每日快照');
  const hdr = AssetSchema.headerMap(snapSheet);
  const rowsBefore = snapSheet.getLastRow();

  // 塞三天合計列：一天正常、一天休市、一天報價異常
  const mkDay = (date, total, status) => {
    const row = new Array(hdr.__header.length).fill('');
    row[hdr['日期']] = date;
    row[hdr['類型']] = '合計';
    row[hdr['鍵']]   = '總資產';
    row[hdr['市值']] = total;
    row[hdr['狀態']] = status;
    snapSheet.getRange(snapSheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  };
  mkDay('2026-07-20', 1000000, '交易日');
  mkDay('2026-07-21', 1000000, '休市');
  mkDay('2026-07-22', 1000000, '報價異常');

  const hist = GoogleSheet.getHistory(365);
  // ⚠️ 要挑出**那一列資料本身**再比對。直接對整份文字比對會被文末的
  //    「終點（2026-07-22：報價異常）」那句話滿足，測不到逐列標記有沒有做。
  const dayLine = (d) => (hist.split('\n').find(l => l.trim().indexOf(d + ':') === 0) || '');
  check('休市那天在該列標出來', /休市/.test(dayLine('2026-07-21')),
    dayLine('2026-07-21') || '(沒有這一列)');
  check('報價異常那天在該列標出來', /報價異常/.test(dayLine('2026-07-22')),
    dayLine('2026-07-22') || '(沒有這一列)');
  check('正常交易日不加註（否則整片都是雜訊）',
    dayLine('2026-07-20') !== '' && !/（/.test(dayLine('2026-07-20')),
    dayLine('2026-07-20') || '(沒有這一列)');
  check('有整段的異常天數統計（中間被省略也算得到）',
    /1 天休市/.test(hist) && /1 天報價異常/.test(hist),
    hist.split('\n').filter(l => l.indexOf('⚠️') >= 0).join(' ｜ ') || '(沒有統計)');
  check('明講那幾天不可信、不是「沒有變動」',
    /不要當成「那天沒有變動」/.test(hist), '(沒有這句提醒)');

  // getHoldings 的時點
  const holdText = GoogleSheet.getHoldings();
  check('持倉開頭有【資料時點】', /【資料時點】/.test(holdText),
    holdText.split('\n')[0]);
  check('講明股數成本來自上一次重算', /上一次重算/.test(holdText), '');
  check('講明市價是活公式、不保證是此刻', /不保證是此刻的價/.test(holdText), '');
  check('講明當日漲跌有延遲', /延遲約 20 分鐘/.test(holdText), '');

  // 指標的待修正警告（備援補價就寫在這裡）要跟著持倉一起出去
  // `_metrics` 是掃全表挑開頭是 ⚠️ 的列，不綁列號，所以接在最後面就行
  const metricSheet = target.getSheetByName('指標');
  const mAt = metricSheet.getLastRow() + 1;
  metricSheet.getRange(mAt, 1, 1, 3).setValues([['⚠️ 待修正', '', 'T29 假的備援補價警告']]);
  const holdText2 = GoogleSheet.getHoldings();
  check('指標的待修正警告會出現在持倉輸出裡',
    /T29 假的備援補價警告/.test(holdText2),
    holdText2.split('\n').filter(l => l.indexOf('待修正') >= 0)[0] || '(沒帶出來)');
  metricSheet.deleteRow(mAt);

  // 收乾淨，不影響後面（目前沒有後續測試，但別留給未來的人踩）
  const extra = snapSheet.getLastRow() - rowsBefore;
  if (extra > 0) snapSheet.deleteRows(rowsBefore + 1, extra);
}

// ─── T30  注入 prompt 的事實區塊 ─────────────────────────────────
//
// 這個區塊會進**每一則**訊息的 prompt，所以它有兩個非功能性的硬要求：
// 不准丟例外（丟了就整則回覆沒了），也不准無限長（每則訊息都要付那個 token）。
console.log('\nT30  事實區塊');
{
  load('Facts.gs');
  const block = Facts.build(target);

  check('有組出東西來', block.length > 0, block.slice(0, 40));
  check('開頭是給模型看的標記', block.indexOf('[系統計算的事實]') === 0, block.split('\n')[0]);
  check('明講必須原樣引用', /必須原樣引用/.test(block), '');
  check('明講不要自己算百分比', /不要自己算/.test(block), '');

  // 數字要與指標表一致 —— 這個區塊的全部價值就在「不會算錯」
  const m = Snapshot._metrics(target);
  check('總資產與 Snapshot 對得上',
    block.indexOf(Math.round(Snapshot._totals(target).today).toLocaleString()) >= 0,
    block.split('\n').filter(l => l.indexOf('總資產') >= 0)[0] || '(沒有總資產)');
  check('未實現損益與指標對得上',
    block.indexOf(Math.round(m.unrealized).toLocaleString()) >= 0,
    block.split('\n').filter(l => l.indexOf('未實現') >= 0)[0] || '(沒有未實現損益)');

  // XIRR 算不出來時要講原因，不能只給一個空白或 0
  check('XIRR 沒有值時講得出原因', /XIRR/.test(block) &&
    (/XIRR（年化）：\d|尚無法計算/.test(block)),
    block.split('\n').filter(l => l.indexOf('XIRR') >= 0)[0] || '(沒有 XIRR)');

  // 長度：進每一則 prompt，不能無限長
  check('長度控制在 1200 字以內', block.length <= 1200, block.length + ' 字');

  // ⚠️ 真正的限制是「不准打外部 API」，不是「不准出現代號」——「待修正」的警告
  //    本來就會點名是哪一檔，那是該有的。所以直接盯呼叫，不要用文字內容當代理指標。
  const savedSP30 = global.StockPrice;
  let twseCalls = 0;
  global.StockPrice = { getRawPrices: () => { twseCalls++; return []; } };
  Facts.build(target);
  global.StockPrice = savedSP30;
  check('組事實區塊不打 TWSE（每則訊息都要付的成本）',
    twseCalls === 0, twseCalls + ' 次呼叫');

  // 最重要的一條：壞掉也不能炸，只能安靜地不提供
  const brokenSS = { getSheetByName: () => { throw new Error('T30 故意炸的'); } };
  let threw = false, out = null;
  try { out = Facts.build(brokenSS); } catch (e) { threw = true; }
  check('讀不到資料時回空字串而不是丟例外', !threw && out === '',
    threw ? '丟了例外' : JSON.stringify(out));
}

// ─── T31  工具回傳的信封 ─────────────────────────────────────────
//
// execute() 以前一律回字串，「查到了」「參數不齊」「工具壞了」在型別上一模一樣，
// 於是模型可以把「讀取持倉時發生錯誤」當成一段資料拿去總結。
console.log('\nT31  工具回傳分得出成功與失敗');
{
  load('Tools.gs');
  global.WebSearch = { search: () => '假的搜尋結果' };

  const okRes = Tools.execute('getHoldings', {});
  check('成功時 ok=true / status=ok',
    okRes.ok === true && okRes.status === 'ok', JSON.stringify(okRes.status));
  check('成功時 text 是實際內容', okRes.text.length > 0 && /【資料時點】/.test(okRes.text),
    okRes.text.slice(0, 30));

  const missing = Tools.execute('recordTrade', {});
  check('參數不齊 → ok=false / status=invalid_args',
    missing.ok === false && missing.status === 'invalid_args', JSON.stringify(missing.status));
  check('參數不齊仍然回得出可讀訊息', /缺少必要參數/.test(missing.text), missing.text);

  const unknown = Tools.execute('noSuchTool', {});
  check('未知工具 → ok=false / status=error',
    unknown.ok === false && unknown.status === 'error', JSON.stringify(unknown.status));

  // 底層丟例外時不能讓它逃出去，但也不能假裝成功
  const savedGS = global.GoogleSheet;
  global.GoogleSheet = { getHoldings: () => { throw new Error('T31 故意炸的'); } };
  const boom = Tools.execute('getHoldings', {});
  global.GoogleSheet = savedGS;
  check('底層丟例外 → 接住而且 ok=false',
    boom.ok === false && boom.status === 'error', JSON.stringify(boom));
  check('例外訊息有帶出來（Logger 那個坑：例外 stringify 只剩 name）',
    /T31 故意炸的/.test(boom.text), boom.text);

  // 業務規則擋下**不是**工具失敗：工具正常執行、正常回話，只是答案是「不行」。
  // 這兩件事混在一起的話，模型會把「賣超被擋」當成系統故障去道歉，而不是轉述原因。
  const held31 = AssetSchema.readObjects(target.getSheetByName('持倉'))
    .filter(p => num(p['股數']) > 0);
  const blocked = Tools.execute('recordTrade', {
    action: '賣出', symbol: String(held31[0]['代號']),
    shares: num(held31[0]['股數']) + 999999, price: 50,
    account: '國泰證券戶', date: '2026-08-03'
  });
  check('業務規則擋下算 ok=true（工具正常運作，答案是「不行」）',
    blocked.ok === true && blocked.status === 'ok', JSON.stringify(blocked.status));
}

// ─── T32  建議紀錄與回饋閉環 ──────────────────────────────────────
console.log('\nT32  Iris 記得自己說過什麼');
{
  load('AdviceLog.gs');

  // 分頁不存在時要自己建，不能安靜地什麼都不做
  check('一開始沒有 advice_log 分頁', !target.getSheetByName('advice_log'));
  const wrote = AdviceLog.record({
    source: 'chat', topic: '00878', advice: '佔比偏高，建議先不要加碼', totalAssets: 1000000
  });
  check('第一次記錄會自己把分頁建出來',
    wrote === true && !!target.getSheetByName('advice_log'));

  const before = Utils.ledgerWriteCount();
  AdviceLog.record({ source: 'chat', topic: '現金水位', advice: '現金偏低，先留著', totalAssets: 1000000 });
  check('記建議算一次帳本寫入（模型會說「我記下來了」）',
    Utils.ledgerWriteCount() > before, before + ' → ' + Utils.ledgerWriteCount());

  check('空建議不寫', AdviceLog.record({ topic: 'X', advice: '  ' }) === false);

  const recent = AdviceLog.getRecent(30);
  // ⚠️ 不比對順序：測試把時間凍住，兩筆的 timestamp 一模一樣，排序本來就不保證。
  //    真正要釘的是**代號的前導零沒掉** —— 主題欄若不是純文字格式，Sheets 會把
  //    '00878' 存成 878，於是「同一個 topic 串得起來」會默默失效。
  check('讀得回來，而且代號的前導零沒被 Sheets 吃掉',
    recent.length === 2 && recent.some(r => r.topic === '00878') &&
    recent.some(r => r.topic === '現金水位'),
    recent.map(r => r.topic).join(','));

  // 「後來如何」是現算的，不是存在表裡的死值
  const grown = AdviceLog.formatForPrompt(30, 1100000, 5);
  check('有帶出當時總資產與至今變化', /當時總資產/.test(grown) && /\+10\.00%/.test(grown),
    grown.split('\n')[1] || '');
  const shrunk = AdviceLog.formatForPrompt(30, 900000, 5);
  check('同一筆建議、換一個現在的總資產，算出來就不同（沒有把結果存死）',
    /-10\.00%/.test(shrunk), shrunk.split('\n')[1] || '');
  check('沒給現在的總資產就不硬算', !/至今/.test(AdviceLog.formatForPrompt(30, 0, 5)), '');

  check('明講這些是自己說過的話、要認帳', /要認帳/.test(grown), grown.split('\n')[0]);

  // 會進每一則 prompt，所以要有上限
  for (let i = 0; i < 20; i++) {
    AdviceLog.record({ source: 'chat', topic: 'T' + i, advice: '第 ' + i + ' 筆測試建議', totalAssets: 1000000 });
  }
  const capped = AdviceLog.formatForPrompt(30, 1000000, 5);
  check('筆數有上限（標題 + 5 筆）', capped.split('\n').length === 6,
    capped.split('\n').length + ' 行');

  // 走 Tools 這條路（模型實際用的介面）
  const viaTool = Tools.execute('logAdvice', { topic: '0056', advice: '殖利率轉弱，建議觀察' });
  check('logAdvice 工具走得通', viaTool.ok === true && /已登記建議/.test(viaTool.text),
    JSON.stringify(viaTool).slice(0, 80));
  check('logAdvice 缺參數 → invalid_args',
    Tools.execute('logAdvice', { topic: '0056' }).status === 'invalid_args', '');
  const logged = AdviceLog.getRecent(30).find(r => r.topic === '0056');
  check('總資產由程式讀，不是模型傳進來的',
    !!logged && logged.totalAssets > 0, JSON.stringify(logged && logged.totalAssets));

  // 沒有紀錄時回空字串，呼叫端才好整段略過
  target.sheets = target.sheets.filter(s => s.getName() !== 'advice_log');
  check('沒有分頁時回空字串而不是一句廢話', AdviceLog.formatForPrompt(30, 1000000, 5) === '', '');
}

// ─── T33  人設：行為準則優先，排版退到最後 ────────────────────────
console.log('\nT33  人設寫的是行為準則，不是排版規範');
{
  load('Prompt.gs');
  const sys = Prompt.SYSTEM_PROMPT;
  const adv = Prompt.ADVISOR_PROMPT;

  // ⚠️ 這條是真正會回歸的：提示詞一邊禁止 Markdown，一邊自己用 **強調**。
  //    模型會模仿它讀到的格式，而 Utils.stripMarkdown 的存在正說明它真的會輸出星號。
  check('SYSTEM_PROMPT 自己不用 Markdown 粗體（它才剛禁止這件事）',
    sys.indexOf('**') < 0, (sys.match(/\*\*[^*\n]+\*\*/g) || []).slice(0, 3).join(' | '));
  check('ADVISOR_PROMPT 同理', adv.indexOf('**') < 0,
    (adv.match(/\*\*[^*\n]+\*\*/g) || []).slice(0, 3).join(' | '));

  // 排版規範退到最後，行為準則放前面
  const posBehaviour = sys.indexOf('[怎麼回答');
  const posTools     = sys.indexOf('[工具選用]');
  const posFormat    = sys.indexOf('[排版]');
  check('行為準則在工具說明之前', posBehaviour > 0 && posBehaviour < posTools,
    posBehaviour + ' vs ' + posTools);
  check('排版規範退到最後', posFormat > posTools, posFormat + ' vs ' + posTools);

  // D10 點名缺的那幾種顧問行為
  [['先講結論', /先講結論/], ['區分事實與判斷', /分清楚「事實」與「判斷」/],
   ['承認不確定', /不確定就說不確定/], ['比對目標', /\[目標\] 要主動比對/],
   ['情緒應對', /焦慮或抱怨虧損/]].forEach(([label, re]) => {
    check('有寫進' + label, re.test(sys), '');
  });

  // 這段每則訊息都要送，長度要看得住
  check('SYSTEM_PROMPT 長度在 6000 字以內', sys.length <= 6000, sys.length + ' 字');

  // systemContext 把事實與建議接在最後（離問題最近）
  const ctx = Prompt.systemContext({ scope: '回覆', facts: 'FACTS_HERE', advice: 'ADVICE_HERE' });
  check('事實與建議接在 systemContext 最後',
    ctx.indexOf('FACTS_HERE') > ctx.indexOf('[重要：日期與年份規則]') &&
    ctx.indexOf('ADVICE_HERE') > ctx.indexOf('FACTS_HERE'), '');
  check('沒傳就不留空段落', Prompt.systemContext({ scope: '回覆' }).indexOf('undefined') < 0, '');
}

// ─── T34  consolelog 聚合成每日指標 ───────────────────────────────
//
// 這些數字本來每 10 天就被 dailyCleanUp 清掉。聚合的重點不只是「有數字看」，
// 而是改完迴圈或模型設定之後，有東西可以拿來驗證實際影響。
console.log('\nT34  每日指標聚合');
{
  load('Metrics.gs');

  // ⚠️ 要重用已有的分頁。mock 允許同名分頁共存（真的 Sheets 不行），
  //    直接 insertSheet 會冒出第二張，而 getSheetByName 拿到的是第一張 ——
  //    症狀是「測試寫了一堆資料，Metrics 卻說只有一列」。
  const logSheet = target.getSheetByName('consolelog') || target.insertSheet('consolelog');
  logSheet.clear();
  logSheet.getRange(1, 1, 1, 5).setValues([['時間', '層級', 'tag', '訊息', '細節']]);

  const today = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd');
  const put = (level, tag, msg, detail) =>
    logSheet.appendRow([today + ' 10:00:00', level, tag, msg, detail || '']);

  put('INFO', 'ChatBot.reply', 'ReAct 迴圈結束', JSON.stringify({ totalTurns: 2, elapsedMs: 12000, timedOut: false }));
  put('INFO', 'ChatBot.reply', 'ReAct 迴圈結束', JSON.stringify({ totalTurns: 4, elapsedMs: 30000, timedOut: true }));
  put('INFO', 'Tools.execute', '執行工具: getHoldings', '{}');
  put('INFO', 'Tools.execute', '執行工具: getHoldings', '{}');
  put('INFO', 'Tools.execute', '執行工具: searchWeb', '{}');
  put('WARNING', 'AIServiceFactory.callAPI', '備援模型接手成功', '');
  put('INFO', 'Utils.noteLedgerWrite', '帳本寫入 #1', '');
  put('WARNING', 'ChatBot.reply', '宣稱已完成但沒有呼叫寫入工具，打回重做', '');
  put('ERROR', 'StockPrice._fetch', '請求丟出例外', '');

  const rows = Metrics.rollupDaily(1);
  const r = rows[0];

  check('算出對話數', r.replies === 2, JSON.stringify(r.replies));
  check('平均輪數 = (2+4)/2', r.avgTurns === 3, JSON.stringify(r.avgTurns));
  check('最多輪數取最大值', r.maxTurns === 4, JSON.stringify(r.maxTurns));
  check('耗時換算成秒', r.avgSec === 21 && r.maxSec === 30, r.avgSec + ' / ' + r.maxSec);
  check('逾時只算 timedOut=true 的', r.timeouts === 1, JSON.stringify(r.timeouts));
  check('工具呼叫總數', r.toolCalls === 3, JSON.stringify(r.toolCalls));
  check('最常用工具帶次數', r.topTool === 'getHoldings(2)', r.topTool);
  check('備援接手次數', r.fallback === 1, JSON.stringify(r.fallback));
  check('假宣稱攔截有被數到（最值得盯的一條）', r.falseClaim === 1, JSON.stringify(r.falseClaim));
  check('帳本寫入次數', r.ledgerWrites === 1, JSON.stringify(r.ledgerWrites));
  check('錯誤數只算 ERROR', r.errors === 1, JSON.stringify(r.errors));

  // 同一天重跑要覆蓋，不能疊加 —— 排程補跑與手動執行都會發生
  const metricSheet2 = target.getSheetByName('metrics');
  const rowsAfterFirst = metricSheet2.getLastRow();
  Metrics.rollupDaily(1);
  check('同一天重跑覆蓋而不是疊加',
    target.getSheetByName('metrics').getLastRow() === rowsAfterFirst,
    rowsAfterFirst + ' → ' + target.getSheetByName('metrics').getLastRow());

  target.sheets = target.sheets.filter(s =>
    s.getName() !== 'consolelog' && s.getName() !== 'metrics');
}

// ─── T35  ChatBot 的 ReAct 迴圈 ──────────────────────────────────
//
// 這支到今天為止完全沒有測試替身，而假宣稱攔截、工具信封、輪數上限全都住在裡面。
// 替身只要兩個：把 LLM 換成一個可以排隊的假回應，把訊息推送換成一個記事本。
// 其餘（Tools / Facts / AdviceLog / Utils / Prompt / GoogleSheet）都用真的。
console.log('\nT35  ReAct 迴圈');
{
  const AI_QUEUE = [];   // 依序回給 ChatBot 的假 LLM 回應
  const AI_CALLS = [];   // 每次呼叫的 contents 與 options，用來驗「最後一輪不帶工具」
  const MSGS     = [];   // 送出去的訊息

  global.AIServiceFactory = {
    callAPI(contents, options) {
      AI_CALLS.push({ turns: contents.length, hasTools: !!(options && options.tools) });
      return AI_QUEUE.length ? AI_QUEUE.shift() : null;
    }
  };
  global.MessagingServiceFactory = {
    reply: (e, m) => MSGS.push(['reply', m]),
    push:  (u, m) => MSGS.push(['push', m]),
    indicateTyping: () => {}
  };
  global.WebSearch = { search: () => '假的搜尋結果' };
  Config.TOOL_MAX_ITERATIONS = 3;   // 固定成已知值；正式值在 Config.gs

  load('ChatBot.gs');

  const say  = (text) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });
  const call = (...names) => ({ candidates: [{ content: { parts:
    names.map(n => ({ functionCall: { name: typeof n === 'string' ? n : n.name,
                                      args: typeof n === 'string' ? {} : n.args } })) } }] });
  const ev = (text) => ({ platform: 'TELEGRAM', replyToken: '1', sourceId: '1',
    source: { type: 'user', userId: 'TELEGRAM:1' }, message: { type: 'text', text }, isMaster: true });

  const reset = () => { AI_QUEUE.length = 0; AI_CALLS.length = 0; MSGS.length = 0; };

  // ① 一輪就給文字：不該碰任何工具
  reset(); AI_QUEUE.push(say('總資產是 100 萬。'));
  let out = ChatBot.reply(ev('我總資產多少'));
  check('一輪就回文字', /總資產是 100 萬/.test(out), out);
  check('只呼叫一次 LLM', AI_CALLS.length === 1, AI_CALLS.length + ' 次');

  // ② 工具呼叫 → 結果回灌 → 第二輪回文字
  reset(); AI_QUEUE.push(call('getHoldings'), say('你有三檔。'));
  out = ChatBot.reply(ev('我有哪些持倉'));
  check('工具結果回灌後第二輪作答', /你有三檔/.test(out), out);
  check('第二輪的 contents 比第一輪長（結果有回灌）',
    AI_CALLS[1].turns > AI_CALLS[0].turns, JSON.stringify(AI_CALLS.map(c => c.turns)));

  // ③ 同一輪多個工具全部執行（舊版只取第一個，模型得多花一輪重問）
  //    ⚠️ 要數**實際執行了幾個工具**，不是數 LLM 呼叫幾次 —— 只取第一個工具的話
  //       LLM 呼叫次數一模一樣，用它當指標抓不到這個回歸。
  reset(); AI_QUEUE.push(call('getHoldings', 'listAccounts'), say('好了。'));
  const realExec = Tools.execute;
  const execed = [];
  Tools.execute = (n, a) => { execed.push(n); return realExec(n, a); };
  const before35 = Utils.ledgerWriteCount();
  out = ChatBot.reply(ev('持倉跟帳戶各給我一份'));
  Tools.execute = realExec;
  check('同一輪的兩個工具都真的執行了',
    execed.length === 2 && execed.indexOf('getHoldings') >= 0 && execed.indexOf('listAccounts') >= 0,
    execed.join(','));
  check('讀取類工具不會動到帳本', Utils.ledgerWriteCount() === before35, '');

  // ③-b 同一輪相同參數重複呼叫走快取，只真的執行一次
  reset(); AI_QUEUE.push(call('getHoldings', 'getHoldings'), say('好了。'));
  const execed2 = [];
  Tools.execute = (n, a) => { execed2.push(n); return realExec(n, a); };
  ChatBot.reply(ev('查兩次一樣的'));
  Tools.execute = realExec;
  check('相同參數的重複呼叫只執行一次', execed2.length === 1, execed2.join(','));

  // ④ 最後一輪不帶工具定義 —— 否則模型會在沒有機會用結果的那一輪還在叫工具
  reset();
  AI_QUEUE.push(call('getHoldings'), call('getHoldings'), say('最後回答。'));
  out = ChatBot.reply(ev('一直查'));
  check('輪數不超過上限', AI_CALLS.length <= 3, AI_CALLS.length + ' 輪');
  check('最後一輪沒有帶工具定義', AI_CALLS[AI_CALLS.length - 1].hasTools === false,
    JSON.stringify(AI_CALLS.map(c => c.hasTools)));

  // ⑤ 宣稱寫入但帳本沒動 → 打回重做一次，那一輪才是真的寫進去的地方
  reset();
  AI_QUEUE.push(say('好的，已校正。'),
                call({ name: 'rememberShortTerm', args: { key: 'T35', content: '測試' } }),
                say('已記錄完成。'));
  out = ChatBot.reply(ev('把郵局改成 12000'));
  check('假宣稱被打回，補叫了工具之後才作答', AI_CALLS.length === 3,
    AI_CALLS.length + ' 輪');
  check('真的寫了就不加警語', out.indexOf('沒有真的寫進帳本') < 0, out.slice(0, 60));

  // ⑥ 打回之後還是那樣講 → 回覆前面加警語（不是把話刪掉）
  reset();
  AI_QUEUE.push(say('好的，已校正。'), say('已經校正好了。'), say('已經校正好了。'));
  out = ChatBot.reply(ev('把郵局改成 9000'));
  check('屢勸不聽就加警語', /沒有真的寫進帳本/.test(out), out.slice(0, 60));
  check('原本的內容還留著（誤判時不會把話吃掉）', /已經校正好了/.test(out), out.slice(-40));

  // ⑦ 工具失敗要讓模型知道是失敗，不是資料
  reset(); AI_QUEUE.push(call({ name: 'recordTrade', args: {} }), say('參數不齊，請補。'));
  out = ChatBot.reply(ev('記一筆'));
  check('工具回 invalid_args 時迴圈照常往下走', /參數不齊/.test(out), out);

  // ⑧ 時間預算才是真正的守門員（輪數上限放寬到 5 的前提）
  reset();
  const realElapsed = Utils.execElapsedMs;
  Utils.execElapsedMs = () => 250000;          // 超過 200s 的開新輪門檻
  AI_QUEUE.push(say('不該被用到'));
  out = ChatBot.reply(ev('現在很晚了'));
  Utils.execElapsedMs = realElapsed;
  check('超過時間門檻就一輪都不開', AI_CALLS.length === 0, AI_CALLS.length + ' 輪');
  check('而且會講清楚是逾時，不是裝沒事', /超過我的處理上限/.test(out), out.slice(0, 40));

  delete global.AIServiceFactory;
  delete global.MessagingServiceFactory;
}

// ─── T36  知識檢索：中文查得到，規矩一律帶上 ──────────────────────
console.log('\nT36  知識檢索');
{
  const kn = target.getSheetByName('knowledge') || target.insertSheet('knowledge');
  kn.clear();
  kn.getRange(1, 1, 1, 3).setValues([['tags', 'content', 'timestamp']]);
  kn.appendRow(['[偏好] 投資工具限制', '我不持有單一個股，只買 ETF', '2026/01/01 00:00:00']);
  kn.appendRow(['[目標] 現金比例-2026年底', '年底前把現金比例降到 20%', '2026/01/01 00:00:00']);
  kn.appendRow(['[決策] 00631L-加倉條件', '單日跌超過 5% 想加倉', '2026/01/01 00:00:00']);
  kn.appendRow(['筆記,雜項', '喜歡看晨星的報告', '2026/01/01 00:00:00']);
  kn.appendRow(['筆記,券商', '主要用富邦證券下單', '2026/01/01 00:00:00']);

  // ① 這是舊版真正壞掉的地方：中文整句當一個詞，只有原文完全出現才算命中
  const r1 = GoogleSheet.searchKnowledge('現金比例太高了嗎');
  check('中文整句查詢撈得到（舊版整句當一個詞，一定落空）',
    /現金比例/.test(r1), r1.slice(0, 60));

  // ①-b 同義詞仍然連不起來，這是 bigram 的天花板，不是 bug。
  //     「加碼」與知識庫裡的「加倉」沒有共用字，怎麼切都對不上。
  //     刻意不做同義詞表：那種表沒人維護就會過期，而且真正重要的那類知識
  //     （決策／目標／偏好）已經由 knowledgeForPrompt 無條件帶上，不靠用字碰運氣。
  check('同義詞查不到 —— 已知限制，由「規矩一律帶上」那層兜底',
    !/加倉/.test(GoogleSheet.searchKnowledge('可以加碼嗎')), '');
  check('而注入層照樣看得到那條決策',
    /加倉/.test(GoogleSheet.knowledgeForPrompt('可以加碼嗎')), '');

  // ② 標籤命中要贏過內文命中
  const r2 = GoogleSheet.searchKnowledge('券商');
  check('標籤命中排在前面', r2.split('\n')[0].indexOf('券商') >= 0, r2.split('\n')[0]);

  // ③ 代號、英文照樣查得到
  check('代號查得到', /00631L-加倉條件/.test(GoogleSheet.searchKnowledge('00631L')), '');
  check('英文縮寫查得到', /ETF/.test(GoogleSheet.searchKnowledge('ETF 好嗎')), '');

  // ④ 真的無關就要說沒找到，不能因為 bigram 亂撈而永遠有結果
  check('無關的查詢仍然回沒找到',
    /沒有找到/.test(GoogleSheet.searchKnowledge('鮭魚壽司')),
    GoogleSheet.searchKnowledge('鮭魚壽司').slice(0, 40));

  // ⑤ 注入用的區塊：決策／目標／偏好一律帶上，不看用字
  const inj = GoogleSheet.knowledgeForPrompt('今天天氣真好');
  check('與問題無關時，主人立的規矩照樣帶上', /目標/.test(inj) && /偏好/.test(inj) && /決策/.test(inj),
    inj.replace(/\n/g, ' ｜ ').slice(0, 80));
  check('無關的一般筆記不會被硬塞進來', inj.indexOf('晨星') < 0, inj);

  // ⑥ 相關的一般知識還是撈得進來
  const inj2 = GoogleSheet.knowledgeForPrompt('我都用哪一家券商下單');
  check('相關的一般知識會補進來', /富邦證券/.test(inj2), inj2.replace(/\n/g, ' ｜ '));

  // ⑦ 空知識庫不要炸，也不要回一句會被當成內容的廢話
  kn.clear();
  kn.getRange(1, 1, 1, 3).setValues([['tags', 'content', 'timestamp']]);
  check('空知識庫回空字串（呼叫端才好整段略過）',
    GoogleSheet.knowledgeForPrompt('隨便問') === '', '');
  target.sheets = target.sheets.filter(s => s.getName() !== 'knowledge');
}

//   REALIZED_CSV=path/to.csv node test_asset.cjs
if (process.env.REALIZED_CSV && fs.existsSync(process.env.REALIZED_CSV)) {
  console.log('\n[真實檔案解析預覽] ' + process.env.REALIZED_CSV);
  const real = AssetImport.parseRealized(fs.readFileSync(process.env.REALIZED_CSV, 'utf8'));
  const g = {};
  real.rows.forEach(r => {
    if (!g[r.code]) g[r.code] = { name: r.name, shares: 0, net: 0, pnl: 0, n: 0 };
    g[r.code].shares += r.shares; g[r.code].net += r.net;
    g[r.code].pnl += r.brokerPnl; g[r.code].n++;
  });
  console.log('  解析 ' + real.rows.length + ' 列，錯誤 ' + real.errors.length + ' 項');
  Object.keys(g).sort().forEach(c => console.log('  ' + c + ' ' + g[c].name +
    '：' + g[c].n + ' 筆，共 ' + g[c].shares.toLocaleString() + ' 股，入帳 ' +
    Math.round(g[c].net).toLocaleString() + '，券商損益 ' + Math.round(g[c].pnl).toLocaleString()));
  real.errors.forEach(e => console.log('  ⚠️ ' + e));
}

console.log('\n' + (fail === 0 ? '全部通過' : fail + ' 項失敗') + '（' + pass + '/' + (pass + fail) + '）');
if (fail > 0 && process.env.SHOW_LOGS) console.log(JSON.stringify(LOGS, null, 1));
process.exit(fail === 0 ? 0 : 1);
