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
const FX = { USDTWD: +L_PANEL[2][7], JPYTWD: +L_PANEL[3][7], XAUTWD: +L_PANEL[7][7] * 31.1035 };

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
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) self.rows[a + i - 1][b + j - 1] = vals[i][j];
        EVAL.reset();
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
  // 先把字串常值抽走，否則 "CURRENCY:XAUTWD" 會被當成 A:B 範圍
  const lits = [];
  let js = src.replace(/"([^"]*)"/g, m => { lits.push(m); return '' + (lits.length - 1) + ''; });

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
  js = js.replace(/\b(IFERROR|IFS|IF|OR|AND|SUMIF|SUM|VLOOKUP|GOOGLEFINANCE|N)\(/g, 'F.$1(');
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
load('AssetSchema.gs');
load('Position.gs');
load('AssetMigrate.gs');

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
check('建立 16 個分頁', r3.created.length === 16, r3.created.length);
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
  const i646 = inst.find(x => x['代號'] === '00646');
  check('00646 分類帶入 區域=美 / 類型=指', i646['區域'] === '美' && i646['類型'] === '指', i646['區域'] + '/' + i646['類型']);

  const trades = AssetSchema.readObjects(target.getSheetByName('交易'));
  const seed = trades.filter(t => t['動作'] === '期初');
  const s56 = seed.find(t => t['代號'] === '0056');
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

  const p56 = pos.find(x => x['代號'] === H0.code);
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
  const panel = AssetSchema.readObjects(target.getSheetByName('面板'));
  const get = k => num((panel.find(x => x['指標'] === k) || {})['數值']);
  check('面板總資產 = 舊表面板 D4', near(get('總資產'), EXP.totalAssets, 3), money(get('總資產')));
  check('面板股票市值 = 舊表面板 B3', near(get('股票市值'), EXP.stockValue, 2), money(get('股票市值')));
  check('面板未實現損益 = 舊表收益', near(get('未實現損益'), EXP.unrealized, 2), money(get('未實現損益')));
  // 舊表的「總股利」只 SUMIF 到還在持股表裡的持股，已出清標的領過的息從沒被算進去。
  // 新表把整本股利帳都算回來，所以會比舊表大 —— 這是修正不是 bug。
  check('面板累計股利 = 整本股利帳（含已出清標的）',
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

  const panel = AssetSchema.readObjects(target.getSheetByName('面板'));
  const get = k => num((panel.find(x => x['指標'] === k) || {})['數值']);
  check('面板已實現損益跟著出現', near(get('已實現損益'), NET - OUT, 1), money(get('已實現損益')));
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

// ─── T8  標題列契約 ──────────────────────────────────────────────
// 寫入是位置對應（公式裡的欄位字母也寫死），所以標題列一旦錯位就必須擋下來，
// 不能像舊 sheet 那樣把缺的欄補在最後面然後繼續寫。
console.log('\nT8  標題列與寫入位置必須一致');
{
  const panelSheet = target.getSheetByName('面板');
  panelSheet.getRange(1, 1).setValue('亂改的欄名');
  let threw = false;
  try { Position.rebuild(); } catch (e) { threw = /面板.*第 1 欄/.test(e.message); }
  check('generated 分頁標題錯位 → 寫入被擋下', threw);

  const r8 = AssetSchema.build();
  check('build() 把 generated 分頁的標題列修回來',
    panelSheet.getRange(1, 1).getValue() === '指標', String(panelSheet.getRange(1, 1).getValue()));
  check('修復動作有回報', r8.patched.some(x => /面板/.test(x)), JSON.stringify(r8.patched));

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
// 兩邊會對不起來，所以這件事必須浮到面板，不能只寫進 consolelog。
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

  const panel = AssetSchema.readObjects(target.getSheetByName('面板'));
  check('面板最上面出現待修正列', /待修正/.test(String(panel[0]['指標'])), String(panel[0]['指標']));
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

console.log('\n' + (fail === 0 ? '全部通過' : fail + ' 項失敗') + '（' + pass + '/' + (pass + fail) + '）');
if (fail > 0 && process.env.SHOW_LOGS) console.log(JSON.stringify(LOGS, null, 1));
process.exit(fail === 0 ? 0 : 1);
