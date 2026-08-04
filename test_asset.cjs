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
global.Config = { SHEET_ID: 'legacy' };
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
// 舊表的股利同步：AssetTools 會呼叫它，這裡記下來供斷言
const DIVIDEND_MIRROR = [];
global.GoogleSheet = {
  recordDividend: (symbol, amount, date) => {
    DIVIDEND_MIRROR.push({ symbol: String(symbol), amount: Number(amount), date: String(date) });
    return 'ok';
  }
};

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
  // 期初、賣出、期末估值全在同一天 → 時間跨度 0，XIRR 無解，這是對的
  check('同日現金流的 XIRR 仍為空，且說明講清楚原因',
    String((panel.find(x => x['指標'] === 'XIRR（年化）') || {})['數值']) === '' &&
    /時間跨度不足/.test(String((panel.find(x => x['指標'] === 'XIRR（年化）') || {})['說明'])), '');
  // 賣價比評價用的市價高一點，所以總資產不是原地不動：
  // 股票市值 −股數×市價、現金 +股數×賣價−手續費
  check('總資產守恆：只差在賣價與市價的價差扣掉手續費',
    near(get('總資產'), EXP.totalAssets + SELL_QTY * (SELL_PRICE - H0.price) - SELL_FEE, 3),
    money(get('總資產')));
}

// ─── T7  對帳報告 ────────────────────────────────────────────────
console.log('\nT7  對帳報告（此時已多一筆賣出，應偵測到差異）');
{
  const report = AssetMigrate.verify();
  check('報告偵測到 0056 與舊表不符', /✗ 0056 股數/.test(report), '');
  check('其他 7 檔仍相符', (report.match(/✓ \d+ 股數/g) || []).length === 7,
    (report.match(/✓ \d+ 股數/g) || []).length);
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
  check('提醒舊表沒有跟著更新', /舊表/.test(r1), '');

  // 新標的自動登記，且代號必須是文字
  const instBefore = AssetSchema.readObjects(instSheet).length;
  const r2 = AssetTools.recordTrade({ action: '買進', symbol: '00929', shares: 500, price: 20 });
  const inst = AssetSchema.readObjects(instSheet);
  check('新標的自動加進標的表', inst.length === instBefore + 1, inst.length + ' vs ' + (instBefore + 1));
  check('新標的的代號保留前導零',
    inst.some(x => x['代號'] === '00929'), JSON.stringify(inst.map(x => x['代號']).slice(-2)));
  check('回覆有說明是自動建立的', /自動/.test(r2), r2);

  // 股利要同步回舊表
  const mirrorBefore = DIVIDEND_MIRROR.length;
  const r3 = AssetTools.recordTrade({ action: '股利', symbol: H0.code, amount: 12345, date: '2026-09-01' });
  check('股利有同步寫回舊表 @股利', DIVIDEND_MIRROR.length === mirrorBefore + 1,
    JSON.stringify(DIVIDEND_MIRROR.slice(-1)));
  check('同步的日期用舊表的斜線格式',
    /^2026\/09\/01$/.test((DIVIDEND_MIRROR[DIVIDEND_MIRROR.length - 1] || {}).date || ''),
    (DIVIDEND_MIRROR[DIVIDEND_MIRROR.length - 1] || {}).date);
  check('股利不會出現「舊表沒更新」的提醒', !/舊表的股數/.test(r3), r3);
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

// ─── T15  系統分頁搬移 ────────────────────────────────────────────
// 搬完才能把 SHEET_ID 指向新表；knowledge 沒搬過去 AdvisorCheck 就失明。
console.log('\nT15  系統分頁搬到新表');
{
  // 在舊表塞幾筆系統資料（合成的）
  // 要 seed 在 migrateSystem 實際會去讀的那張表（Config.SHEET_ID），不是 fixture 那張
  const sysSrc = SpreadsheetApp.openById(Config.SHEET_ID);
  const seed = (name, rows) => {
    let s = sysSrc.getSheetByName(name);
    if (!s) s = sysSrc.insertSheet(name);
    rows.forEach((r, i) => s.getRange(i + 1, 1, 1, r.length).setValues([r]));
    return s;
  };
  seed('env', [['name', 'value'], ['DEBUG_MODE', false], ['AI_PROVIDER', 'NVIDIA']]);
  seed('knowledge', [['tags', 'content', 'timestamp'],
    ['[偏好] 投資工具限制', '只買 ETF，不碰個股', '2026-01-01'],
    ['[決策] 再平衡', '單一標的超過三成就通知我', '2026-02-01']]);
  seed('short_term_memory', [['key', 'content', 'expire_at', 'category'],
    ['本週計畫', '觀察歐洲部位', '2099-01-01 00:00:00', 'context']]);
  seed('alert_log', [['timestamp', 'trigger_source', 'decision_ref', 'message', 'snapshot_summary']]);
  seed('chat', [['userId', 'role', 'message', 'timestamp'],
    ['TELEGRAM:1', 'user', '你好', '2026-08-01 10:00:00']]);

  const preview = AssetMigrate.migrateSystem({ dryRun: true });
  check('預覽不寫入', preview.dryRun === true &&
    AssetSchema.readObjects(target.getSheetByName('knowledge')).length === 0,
    JSON.stringify(preview.counts));
  check('預覽有算出每張表的筆數', preview.counts.knowledge === 2, JSON.stringify(preview.counts));

  const r = AssetMigrate.migrateSystem();
  check('搬移成功', r.ok === true, JSON.stringify(r.counts));

  const kn = AssetSchema.readObjects(target.getSheetByName('knowledge'));
  check('knowledge 搬過去了', kn.length === 2, kn.length);
  check('決策清單的內容完整',
    kn.some(x => /再平衡/.test(String(x['tags'])) && /三成/.test(String(x['content']))),
    JSON.stringify(kn.map(x => x['tags'])));

  // Config 讀的是 env!B2 / env!B3 這兩個固定位置，搬完必須還在原位
  const envSheet = target.getSheetByName('env');
  check('env!B2 是 DEBUG_MODE 的值', envSheet.getRange('B2').getValue() === false,
    String(envSheet.getRange('B2').getValue()));
  check('env!B3 是 AI_PROVIDER 的值', envSheet.getRange('B3').getValue() === 'NVIDIA',
    String(envSheet.getRange('B3').getValue()));

  const stm = AssetSchema.readObjects(target.getSheetByName('short_term_memory'));
  check('短期記憶搬過去了', stm.length === 1, stm.length);

  // 重跑是覆蓋不是疊加
  AssetMigrate.migrateSystem();
  check('重跑不會疊加',
    AssetSchema.readObjects(target.getSheetByName('knowledge')).length === 2,
    AssetSchema.readObjects(target.getSheetByName('knowledge')).length);
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

// 選用：拿真實的券商匯出檔跑一次解析，只印不斷言（檔案不進版控）
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
