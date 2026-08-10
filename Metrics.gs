/**
 * Metrics
 * @description 把 consolelog 聚合成每日一列，讓「這週跑得怎麼樣」變成看得到的數字
 *
 * 回答「平均幾輪收斂」「哪個工具最常被叫」「備援接手幾次」「假宣稱攔截觸發過嗎」。
 *
 * ⚠️ 必須排在 dailyCleanUp 清 consolelog **之前**，否則等於丟掉資料再去算它。
 * ⚠️ 同一天重跑會覆蓋不會疊加。每次回算 3 天而非只算昨天，漏跑的那天會自己補上。
 */
var Metrics = (() => {
  var m = {};

  var SHEET_NAME = 'metrics';
  var HEADERS = [
    '日期', '對話數', '平均輪數', '最多輪數', '平均耗時秒', '最長耗時秒',
    '逾時次數', '工具呼叫', '最常用工具', '備援接手', '假宣稱攔截', '帳本寫入', '錯誤數'
  ];

  var _sheet = (create) => {
    var ss = SpreadsheetApp.openById(Config.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (sheet || !create) return sheet;
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    Logger.info('Metrics._sheet', '建立 metrics 分頁');
    return sheet;
  };

  var _ymd = (d) => Utilities.formatDate(d, 'GMT+8', 'yyyy-MM-dd');

  /**
   * consolelog 那一格的日期部分。
   * ⚠️ 不要把字串再解析成 Date：setLog 寫進去的已經是 GMT+8 的字串，
   *    重新解析再格式化回來，兩次時區換算不對消時整天會偏移一格，
   *    症狀是「昨天的資料算不到」且不報錯。直接切前 10 個字。
   * Sheets 有時會把那格轉成 Date 物件，所以兩種都要接。
   */
  var _dayOf = (cell) => {
    if (cell instanceof Date) return _ymd(cell);
    var s = String(cell || '').trim();
    if (s.length < 10) return '';
    return s.slice(0, 10).replace(/\//g, '-');
  };

  /** consolelog 的 details 是 Logger._detail 寫進去的 JSON 字串，解不開就當空物件 */
  var _detail = (s) => {
    try {
      var o = JSON.parse(String(s || '{}'));
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  };

  /**
   * 把某幾天的 consolelog 聚合起來
   * @param {number} [days] 回頭算幾天（含今天），預設 3
   * @returns {Array<object>} 每天一個統計物件（也回傳給 DevTools 直接印）
   */
  m.rollupDaily = (days) => {
    try {
      days = days || 3;
      var ss = SpreadsheetApp.openById(Config.SHEET_ID);
      var log = ss.getSheetByName('consolelog');
      if (!log) { Logger.warning('Metrics.rollupDaily', '找不到 consolelog'); return []; }

      var lastRow = log.getLastRow();
      if (lastRow < 2) return [];

      // 只要算得到的那幾天。往回抓一段就好，不要整張讀 —— consolelog 很長。
      var wanted = {};
      for (var i = 0; i < days; i++) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        wanted[_ymd(d)] = true;
      }

      var span = Math.min(lastRow - 1, 20000);
      var data = log.getRange(lastRow - span + 1, 1, span, 5).getValues();

      var byDay = {};
      var bucket = (day) => {
        if (!byDay[day]) {
          byDay[day] = {
            date: day, replies: 0, turns: 0, maxTurns: 0, ms: 0, maxMs: 0,
            timeouts: 0, toolCalls: 0, tools: {}, fallback: 0, falseClaim: 0,
            ledgerWrites: 0, errors: 0
          };
        }
        return byDay[day];
      };

      data.forEach(r => {
        if (!r[0]) return;
        var day = _dayOf(r[0]);
        if (!day || !wanted[day]) return;

        var level = String(r[1] || '');
        var tag   = String(r[2] || '');
        var msg   = String(r[3] || '');
        var b     = bucket(day);

        if (level === 'ERROR') b.errors++;

        if (tag === 'ChatBot.reply' && msg === 'ReAct 迴圈結束') {
          var d = _detail(r[4]);
          b.replies++;
          var t = Number(d.totalTurns) || 0;
          var e = Number(d.elapsedMs) || 0;
          b.turns += t;
          b.ms    += e;
          if (t > b.maxTurns) b.maxTurns = t;
          if (e > b.maxMs)    b.maxMs = e;
          if (d.timedOut === true) b.timeouts++;
        }

        if (tag === 'Tools.execute' && msg.indexOf('執行工具: ') === 0) {
          var name = msg.slice('執行工具: '.length).trim();
          b.toolCalls++;
          b.tools[name] = (b.tools[name] || 0) + 1;
        }

        if (tag === 'AIServiceFactory.callAPI' && msg.indexOf('備援模型接手成功') >= 0) b.fallback++;
        if (tag === 'Utils.noteLedgerWrite') b.ledgerWrites++;

        // 這一條是最值得盯的：假宣稱攔截有沒有真的在擋東西
        if (tag === 'ChatBot.reply' && msg.indexOf('宣稱已完成') >= 0) b.falseClaim++;
      });

      var out = Object.keys(byDay).sort().map(day => {
        var b = byDay[day];
        var top = Object.keys(b.tools).sort((x, y) => b.tools[y] - b.tools[x])[0] || '';
        return {
          date:         day,
          replies:      b.replies,
          avgTurns:     b.replies ? Math.round(b.turns / b.replies * 10) / 10 : 0,
          maxTurns:     b.maxTurns,
          avgSec:       b.replies ? Math.round(b.ms / b.replies / 100) / 10 : 0,
          maxSec:       Math.round(b.maxMs / 100) / 10,
          timeouts:     b.timeouts,
          toolCalls:    b.toolCalls,
          topTool:      top ? top + '(' + b.tools[top] + ')' : '',
          fallback:     b.fallback,
          falseClaim:   b.falseClaim,
          ledgerWrites: b.ledgerWrites,
          errors:       b.errors
        };
      });

      if (out.length) m._write(out);
      Logger.info('Metrics.rollupDaily', '聚合完成', { days: days, rows: out.length });
      return out;
    } catch (ex) {
      Logger.error('Metrics.rollupDaily', '聚合失敗', ex);
      return [];
    }
  };

  /** 寫入（同日覆蓋）。這是唯一會動 metrics 分頁的地方。 */
  m._write = (rows) => {
    var sheet = _sheet(true);
    if (!sheet) return;

    var lastRow = sheet.getLastRow();
    var existing = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues() : [];
    var rowOf = {};
    existing.forEach((r, i) => {
      var v = r[0];
      var key = (v instanceof Date) ? _ymd(v) : String(v || '').trim();
      if (key) rowOf[key] = i + 2;
    });

    rows.forEach(o => {
      var values = [[
        o.date, o.replies, o.avgTurns, o.maxTurns, o.avgSec, o.maxSec,
        o.timeouts, o.toolCalls, o.topTool, o.fallback, o.falseClaim,
        o.ledgerWrites, o.errors
      ]];
      var at = rowOf[o.date] || (sheet.getLastRow() + 1);
      sheet.getRange(at, 1, 1, HEADERS.length).setValues(values);
    });
  };

  return m;
})();
