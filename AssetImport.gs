/**
 * AssetImport
 * @description 匯入券商匯出的 CSV 到「資產管理」表
 *
 * 目前支援：**證券已實現損益**（國泰證券的「證券已實現YYYYMMDD……csv」）
 *
 * ⚠️ **只匯入賣出那一邊，不匯入買進。**
 *
 * 已實現報表的每一列都是一組配對好的買賣，看起來兩邊都該記，但不行：
 * 買進成本已經在「期初」那列裡了（遷移時用舊表的總成本建倉），再記一次買進
 * 就會憑空多出一份部位與成本。賣出之後買回的部位則是用 recordTrade 記的，
 * 同樣不需要從這裡補。所以規則很單純 —— **買進由別的途徑進來，這裡只記賣出。**
 *
 * ⚠️ **已實現損益的數字會和券商對不起來，這是預期內的。**
 *
 * 券商用逐筆配對（哪一批買的配哪一批賣的），這張表用加權平均法 —— 台灣券商
 * 對帳單的成本認列也是加權平均，但「這一筆賣出賺多少」的拆法本來就不同。
 * 券商自己算的損益會原樣寫進備註，需要核對時看得到。
 *
 * 單價取的是 (賣出價金 + 手續費 + 交易稅) ÷ 股數，不是報表上顯示的「賣出單價」。
 * 顯示的單價是四捨五入過的，用它算出來的現金流會和實際入帳差幾十元，一列一列
 * 累積下去帳就永遠對不平。報表上的單價一併寫進備註。
 */
var AssetImport = (() => {
  var m = {};

  var _str = (v) => String(v === null || v === undefined ? '' : v).trim();
  var _num = (v) => {
    var s = _str(v).replace(/[",$%]/g, '');
    if (!s) return 0;
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  };
  var _money = (n) => Math.round(_num(n)).toLocaleString();

  /** 這份報表必須有的欄位；缺任何一個就不是這種檔案 */
  var NEEDED = ['股票名稱', '股數', '賣出日期', '賣出單價', '手續費', '交易稅', '賣出價金'];

  // ─── CSV ──────────────────────────────────────────────────────

  /** 支援引號內含逗號（"1,000"）與 BOM */
  m.parseCsv = (text) => {
    var s = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var rows = [], row = [], cell = '', quoted = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (quoted) {
        if (c === '"') {
          if (s.charAt(i + 1) === '"') { cell += '"'; i++; }
          else quoted = false;
        } else cell += c;
      } else if (c === '"') {
        quoted = true;
      } else if (c === ',') {
        row.push(cell); cell = '';
      } else if (c === '\n') {
        row.push(cell); cell = '';
        if (row.some(x => _str(x) !== '')) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some(x => _str(x) !== '')) rows.push(row);
    return rows;
  };

  var _normDate = (v, tz) => {
    var s = _str(v);
    var mm = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    if (!mm) return '';
    var pad = (x) => (x.length === 1 ? '0' + x : x);
    return mm[1] + '-' + pad(mm[2]) + '-' + pad(mm[3]);
  };

  /** 去重用的鍵：同一份檔案重匯不會重複記帳 */
  var _key = (r) => 'imp:' + r.date + ':' + r.code + ':' + r.shares + ':' + Math.round(r.net);

  // ─── 解析 ─────────────────────────────────────────────────────

  /**
   * 把 CSV 文字解析成待匯入的賣出列。
   * @returns {{rows: Array, errors: string[], header: string[]}}
   */
  m.parseRealized = (text, ss) => {
    ss = ss || AssetSchema.open();
    var tz = ss.getSpreadsheetTimeZone();

    var table = m.parseCsv(text);
    if (table.length < 2) return { rows: [], errors: ['檔案是空的，或不是 CSV'], header: [] };

    var header = table[0].map(_str);
    var missing = NEEDED.filter(h => header.indexOf(h) < 0);
    if (missing.length) {
      return {
        rows: [], header: header,
        errors: ['這不像是證券已實現損益報表，缺少欄位：' + missing.join('、') +
                 '。實際的標題列是：' + header.join('、')]
      };
    }
    var at = (name) => header.indexOf(name);

    // 名稱 → 代號。券商報表只給名稱，代號要靠「標的」表對照。
    var byName = {};
    AssetSchema.readObjects(ss.getSheetByName('標的')).forEach(x => {
      var n = _str(x['名稱']);
      if (n) byName[n] = _str(x['代號']);
    });

    var rows = [], errors = [];
    for (var i = 1; i < table.length; i++) {
      var line = table[i];
      var name = _str(line[at('股票名稱')]);
      if (!name) continue;

      var code = byName[name];
      if (!code) {
        errors.push('第 ' + (i + 1) + ' 列：「標的」表裡找不到名稱「' + name + '」，這一列跳過');
        continue;
      }

      var shares = _num(line[at('股數')]);
      var date   = _normDate(line[at('賣出日期')], tz);
      var net    = _num(line[at('賣出價金')]);
      var fee    = _num(line[at('手續費')]);
      var tax    = _num(line[at('交易稅')]);

      if (!(shares > 0) || !date || !(net > 0)) {
        errors.push('第 ' + (i + 1) + ' 列：股數／賣出日期／賣出價金 有缺或不合理，跳過');
        continue;
      }

      // 反推真實均價，讓現金流剛好等於券商的賣出價金
      var price = Math.round(((net + fee + tax) / shares) * 10000) / 10000;

      rows.push({
        code: code, name: name, date: date, shares: shares,
        price: price, fee: fee, tax: tax, net: net,
        shownPrice: _num(line[at('賣出單價')]),
        buyDate:  at('買進日期') >= 0 ? _normDate(line[at('買進日期')], tz) : '',
        buyPrice: at('買進單價') >= 0 ? _num(line[at('買進單價')]) : 0,
        brokerPnl: at('損益') >= 0 ? _num(line[at('損益')]) : 0
      });
    }
    rows.forEach(r => { r.key = _key(r); });
    return { rows: rows, errors: errors, header: header };
  };

  // ─── 匯入 ─────────────────────────────────────────────────────

  /**
   * @param {string} text CSV 全文
   * @param {object} [options]
   * @param {boolean} [options.dryRun] 只回報會發生什麼，不寫入
   * @param {string}  [options.account] 指定帳戶；省略時取唯一的證券戶
   * @returns {string} 給人看的摘要
   */
  m.importRealized = (text, options) => {
    options = options || {};
    try {
      var ss = AssetSchema.open();
      var tz = ss.getSpreadsheetTimeZone();
      var parsed = m.parseRealized(text, ss);

      if (parsed.rows.length === 0) {
        return '沒有可匯入的資料。\n' + (parsed.errors.join('\n') || '');
      }

      // ── 帳戶 ──
      var accounts = AssetSchema.readObjects(ss.getSheetByName('帳戶'))
        .filter(x => _str(x['帳戶']) && _str(x['狀態']) !== '停用');
      var account = _str(options.account);
      if (account) {
        if (!accounts.some(x => _str(x['帳戶']) === account)) {
          return '沒有這個帳戶：' + account + '。目前有：' + accounts.map(x => x['帳戶']).join('、');
        }
      } else {
        var brokers = accounts.filter(x => _str(x['類型']) === '證券').map(x => _str(x['帳戶']));
        if (brokers.length !== 1) {
          return '有 ' + brokers.length + ' 個證券戶，請指定要記在哪一個：' + brokers.join('、');
        }
        account = brokers[0];
      }

      // ── 去重 ──
      var existing = {};
      AssetSchema.readObjects(ss.getSheetByName('交易')).forEach(t => {
        var note = _str(t['備註']);
        var k = note.match(/imp:[^\s|]+/);
        if (k) existing[k[0]] = true;
      });

      var fresh = parsed.rows.filter(r => !existing[r.key]);
      var dup   = parsed.rows.length - fresh.length;

      // ── 摘要（預覽與實際匯入共用）──
      var byCode = {};
      fresh.forEach(r => {
        if (!byCode[r.code]) byCode[r.code] = { name: r.name, shares: 0, net: 0, pnl: 0, n: 0 };
        var g = byCode[r.code];
        g.shares += r.shares; g.net += r.net; g.pnl += r.brokerPnl; g.n++;
      });

      var lines = [];
      lines.push('【券商已實現損益匯入' + (options.dryRun ? '（預覽，未寫入）' : '') + '】');
      lines.push('來源共 ' + parsed.rows.length + ' 列，可匯入 ' + fresh.length + ' 列' +
                 (dup ? '，已存在略過 ' + dup + ' 列' : ''));
      lines.push('記入帳戶：' + account);
      lines.push('');
      Object.keys(byCode).sort().forEach(code => {
        var g = byCode[code];
        lines.push('▸ ' + code + ' ' + g.name + '：賣出 ' + _money(g.shares) + ' 股（' + g.n + ' 筆），' +
                   '入帳 ' + _money(g.net) + '，券商計算損益 ' + _money(g.pnl));
      });
      if (parsed.errors.length) {
        lines.push('');
        parsed.errors.forEach(e => lines.push('⚠️ ' + e));
      }

      if (options.dryRun) {
        lines.push('');
        lines.push('確認無誤後執行 importRealizedCsv() 正式寫入。');
        return lines.join('\n');
      }
      if (fresh.length === 0) return lines.join('\n') + '\n\n沒有新資料，未寫入。';

      // ── 寫入 ──
      var stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
      fresh.forEach(r => {
        AssetSchema.appendTrade({
          '日期': r.date,
          '動作': '賣出',
          '代號': r.code,
          '股數': r.shares,
          '單價': r.price,
          '手續費': r.fee,
          '交易稅': r.tax,
          '幣別': 'TWD',
          '帳戶': account,
          '分類': '投資',
          '備註': '券商已實現匯入｜買進 ' + (r.buyDate || '?') + ' @' + r.buyPrice +
                  '｜報表賣出單價 ' + r.shownPrice +
                  '｜券商損益 ' + _money(r.brokerPnl) + '｜' + r.key,
          '來源': 'csv',
          '建立時間': stamp
        }, ss);
      });

      var rebuilt = Position.rebuild();

      lines.push('');
      if (rebuilt && rebuilt.ok) {
        var pos = AssetSchema.readObjects(ss.getSheetByName('持倉'));
        Object.keys(byCode).sort().forEach(code => {
          var p = pos.filter(x => _str(x['代號']) === code)[0];
          if (p) {
            lines.push('▸ ' + code + ' 剩 ' + _money(p['股數']) + ' 股' +
              '，本表計算的已實現損益 ' + _money(p['已實現損益']));
          }
        });
        lines.push('');
        lines.push('※ 已實現損益與券商數字不同是正常的：券商逐筆配對，本表用加權平均。' +
                   '券商自己的數字已寫進每列備註。');
        lines.push('※ 舊表沒有跟著動；查詢已改讀新表，所以之後問我持倉會是更新後的數字。');
        if (rebuilt.warnings && rebuilt.warnings.length) {
          lines.push('⚠️ ' + rebuilt.warnings.join('；'));
        }
      } else {
        lines.push('⚠️ 交易已寫入，但重算失敗：' + (rebuilt && rebuilt.reason ? rebuilt.reason : '未知'));
      }

      Logger.info('AssetImport.importRealized', '匯入完成', {
        total: parsed.rows.length, imported: fresh.length, skipped: dup, account: account
      });
      return lines.join('\n');

    } catch (ex) {
      Logger.error('AssetImport.importRealized', '匯入失敗', ex);
      return '匯入時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  // ─── 從聊天室收檔案 ───────────────────────────────────────────

  /** 檔案大小上限：券商月報表也就幾十 KB，超過這個量級一定不是它 */
  var MAX_BYTES = 1024 * 1024;

  /**
   * 主人在 Telegram 丟一個 .csv 上來時的進入點（由 doPost 分流過來）。
   *
   * 直接匯入不先問，因為去重是靠內容算出來的鍵：同一份檔案重傳幾次都只會
   * 記一次帳。想先看不寫，在附加訊息裡寫「預覽」。
   *
   * @param {object} event doPost 正規化後的事件
   * @returns {string} 要回給主人的訊息
   */
  m.fromUpload = (event) => {
    try {
      var doc = event && event.message && event.message.document;
      if (!doc) return '沒有收到檔案。';

      if (event.platform !== 'TELEGRAM') {
        return '目前只有 Telegram 收得到檔案。';
      }
      if (!/\.csv$/i.test(_str(doc.fileName))) {
        return '我只看得懂 .csv：收到的是「' + _str(doc.fileName) + '」。' +
               '券商的已實現損益報表請用 CSV 格式匯出。';
      }
      if (doc.fileSize > MAX_BYTES) {
        return '檔案太大了（' + Math.round(doc.fileSize / 1024) + ' KB）。' +
               '券商的已實現損益報表通常只有幾十 KB，確認一下是不是傳錯檔案。';
      }

      var text = Telegram.fetchFileText(doc.fileId);
      var dryRun = /預覽|preview|試/.test(_str(event.message.text));

      Logger.info('AssetImport.fromUpload', '收到檔案', {
        name: doc.fileName, size: doc.fileSize, dryRun: dryRun
      });
      return m.importRealized(text, { dryRun: dryRun });

    } catch (ex) {
      Logger.error('AssetImport.fromUpload', '處理上傳檔案失敗', ex);
      return '讀取檔案時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  return m;
})();
