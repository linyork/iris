/**
 * AssetImport
 * @description 匯入券商匯出的 CSV 到「資產管理」表
 *
 * 支援兩種券商匯出檔，靠標題列自動判斷：
 *
 *   **證券對帳單**（有「委託書號」）—— 買賣都記，是首選來源
 *   **已實現損益**（有「賣出日期」）—— 只記賣出，見下
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

  // 儲存格／CSV 取值走 AssetSchema.str / .num —— 後者會剃掉 CSV 殘留的引號
  var _str = (v) => AssetSchema.str(v);
  var _num = (v) => AssetSchema.num(v);
  var _money = (n) => Math.round(_num(n)).toLocaleString();

  /** 這份報表必須有的欄位；缺任何一個就不是這種檔案 */
  var NEEDED = ['股票名稱', '股數', '賣出日期', '賣出單價', '手續費', '交易稅', '賣出價金'];

  /**
   * 券商報表用簡稱，「標的」表用正式名稱，對不上就整列被跳過。
   * 這裡把已知的寫法統一過去。發現新的簡稱就在這裡加一行 —— 刻意用明列而不是
   * 模糊比對：猜錯標的會把交易記到別檔頭上，寧可漏掉讓它回報，也不要猜。
   */
  var NAME_FIXES = {
    '富邦台50': '富邦台灣50'
  };

  /** 名稱 → 代號，查表前先套用上面的正規化 */
  var _nameIndex = (ss) => {
    var map = {};
    AssetSchema.readObjects(ss.getSheetByName('標的')).forEach(x => {
      var n = _str(x['名稱']);
      if (n) map[n] = _str(x['代號']);
    });
    return (raw) => {
      var name = _str(raw);
      return map[NAME_FIXES[name] || name] || '';
    };
  };

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
    var lookup = _nameIndex(ss);

    var rows = [], errors = [];
    for (var i = 1; i < table.length; i++) {
      var line = table[i];
      var name = _str(line[at('股票名稱')]);
      if (!name) continue;

      var code = lookup(name);
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
      // 去重要兩層，而且**必須和對帳單那邊對稱** —— 同一批賣出可能先從對帳單
      // 進來過（拆法不同，內容雜湊對不上），這時只能靠數量比對認出來。
      // 作廢的列**內容鍵仍然算數，數量不算**：作廢是刻意的動作，重送同一個檔案
      // 不該讓它悄悄復活；但它已經不是真實部位了，不能再抵掉新資料的股數。
      var existing = {}, recorded = {};
      AssetSchema.readTrades(ss, { includeVoid: true }).forEach(t => {
        var note = _str(t['備註']);
        var k = note.match(/imp:[^\s|]+/);
        if (k) existing[k[0]] = true;
        if (AssetSchema.isVoid(t)) return;

        if (_str(t['動作']) !== '賣出') return;
        var d = t['日期'] instanceof Date
          ? Utilities.formatDate(t['日期'], tz, 'yyyy-MM-dd')
          : _normDate(t['日期'], tz);
        var qk = d + '|' + _str(t['代號']);
        recorded[qk] = (recorded[qk] || 0) + _num(t['股數']);
      });

      var fresh = [], dupQty = 0;
      parsed.rows.forEach(r => {
        if (existing[r.key]) return;
        var qk = r.date + '|' + r.code;
        var left = recorded[qk] || 0;
        if (left >= r.shares) { recorded[qk] = left - r.shares; dupQty++; return; }
        recorded[qk] = 0;
        fresh.push(r);
      });
      var dup = parsed.rows.length - fresh.length;

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

  // ─── 對帳單（買賣都有）────────────────────────────────────────

  var NEEDED_STM = ['股名', '日期', '成交股數', '淨收付', '成交價金', '手續費', '交易稅', '委託書號'];

  /**
   * 券商對帳單：一列一筆成交，買賣都在裡面。
   *
   * 買賣是靠**淨收付的正負**判斷的，不是靠哪個欄位寫著買或賣 ——
   * 錢進來就是賣出，錢出去就是買進，這是對帳單裡最不會騙人的訊號。
   *
   * 單價一律用 成交價金 ÷ 股數 反推，不用「成交單價」那一欄（它是四捨五入過的）。
   * 這樣算出來的現金流才會剛好等於淨收付。
   */
  m.parseStatement = (text, ss) => {
    ss = ss || AssetSchema.open();
    var tz = ss.getSpreadsheetTimeZone();

    var table = m.parseCsv(text);
    if (table.length < 2) return { rows: [], errors: ['檔案是空的，或不是 CSV'], header: [] };

    var header = table[0].map(_str);
    var missing = NEEDED_STM.filter(h => header.indexOf(h) < 0);
    if (missing.length) {
      return {
        rows: [], header: header,
        errors: ['這不像是證券對帳單，缺少欄位：' + missing.join('、')]
      };
    }
    var at = (name) => header.indexOf(name);

    var lookup = _nameIndex(ss);

    var rows = [], errors = [], unknown = {};
    for (var i = 1; i < table.length; i++) {
      var line = table[i];
      var name = _str(line[at('股名')]);
      if (!name) continue;

      var code = lookup(name);
      if (!code) { unknown[name] = (unknown[name] || 0) + 1; continue; }

      var shares = _num(line[at('成交股數')]);
      var date   = _normDate(line[at('日期')], tz);
      var net    = _num(line[at('淨收付')]);
      var gross  = _num(line[at('成交價金')]);
      var fee    = _num(line[at('手續費')]);
      var tax    = _num(line[at('交易稅')]);
      var order  = _str(line[at('委託書號')]);

      if (!(shares > 0) || !date || net === 0 || !(gross > 0)) {
        errors.push('第 ' + (i + 1) + ' 列：股數／日期／淨收付／成交價金 有缺或不合理，跳過');
        continue;
      }

      rows.push({
        code: code, name: name, date: date, shares: shares,
        action: net > 0 ? '賣出' : '買進',
        price: Math.round((gross / shares) * 10000) / 10000,
        fee: fee, tax: tax, net: net, order: order,
        shownPrice: _num(line[at('成交單價')]),
        // 同一張委託可能分批成交（同一個書號兩列），所以股數要放進鍵裡
        key: 'stm:' + date + ':' + (order || 'NA') + ':' + shares
      });
    }

    Object.keys(unknown).forEach(n => {
      errors.push('「標的」表裡找不到名稱「' + n + '」（' + unknown[n] + ' 列）—— ' +
                  '請先在標的表補上代號，再傳一次這份檔案');
    });

    return { rows: rows, errors: errors, header: header };
  };

  /**
   * 匯入對帳單。
   *
   * 去重有兩層，因為同一筆成交可能已經從**別的格式**進來過了：
   *
   *  1. 委託書號＋日期＋股數 —— 同一份對帳單重傳，或下個月的對帳單又含到這幾天
   *  2. **數量比對** —— 昨天從「已實現損益」匯入的賣出，拆法跟對帳單不同
   *     （四筆 vs 兩筆），內容雜湊永遠對不上。所以改看同一天、同一檔、同一動作
   *     在交易表裡已經記了多少股；已經記滿的就不再記。
   *
   * 第 2 層才是這裡真正的難處：光靠鍵值去重會讓同一批賣出被記兩次。
   */
  m.importStatement = (text, options) => {
    options = options || {};
    try {
      var ss = AssetSchema.open();
      var tz = ss.getSpreadsheetTimeZone();
      var parsed = m.parseStatement(text, ss);

      if (parsed.rows.length === 0) {
        return '沒有可匯入的資料。\n' + (parsed.errors.join('\n') || '');
      }

      var account = _str(options.account);
      var accounts = AssetSchema.readObjects(ss.getSheetByName('帳戶'))
        .filter(x => _str(x['帳戶']) && _str(x['狀態']) !== '停用');
      if (account) {
        if (!accounts.some(x => _str(x['帳戶']) === account)) {
          return '沒有這個帳戶：' + account;
        }
      } else {
        var brokers = accounts.filter(x => _str(x['類型']) === '證券').map(x => _str(x['帳戶']));
        if (brokers.length !== 1) {
          return '有 ' + brokers.length + ' 個證券戶，請指定要記在哪一個：' + brokers.join('、');
        }
        account = brokers[0];
      }

      // ── 既有資料：鍵值 + 每（日期,代號,動作）已記錄的股數 ──
      // 與已實現損益那邊對稱：作廢的列留著鍵（不復活），但不再抵扣數量
      var seenKeys = {}, recorded = {};
      AssetSchema.readTrades(ss, { includeVoid: true }).forEach(t => {
        var note = _str(t['備註']);
        var k = note.match(/stm:[^\s|]+/);
        if (k) seenKeys[k[0]] = true;
        if (AssetSchema.isVoid(t)) return;

        var act = _str(t['動作']);
        if (act !== '買進' && act !== '賣出') return;
        var d = t['日期'] instanceof Date
          ? Utilities.formatDate(t['日期'], tz, 'yyyy-MM-dd')
          : _normDate(t['日期'], tz);
        var key = d + '|' + _str(t['代號']) + '|' + act;
        recorded[key] = (recorded[key] || 0) + _num(t['股數']);
      });

      var fresh = [], dupKey = 0, dupQty = [];
      parsed.rows.forEach(r => {
        if (seenKeys[r.key]) { dupKey++; return; }
        var k = r.date + '|' + r.code + '|' + r.action;
        var left = recorded[k] || 0;
        if (left >= r.shares) {          // 這批已經從別的來源記過了
          recorded[k] = left - r.shares;
          dupQty.push(r.date + ' ' + r.code + ' ' + r.action + ' ' + _money(r.shares) + ' 股');
          return;
        }
        recorded[k] = 0;
        fresh.push(r);
      });

      var lines = [];
      lines.push('【證券對帳單匯入' + (options.dryRun ? '（預覽，未寫入）' : '') + '】');
      lines.push('來源共 ' + parsed.rows.length + ' 列，可匯入 ' + fresh.length + ' 列' +
        (dupKey ? '，重複略過 ' + dupKey + ' 列' : '') +
        (dupQty.length ? '，已從其他來源登錄過略過 ' + dupQty.length + ' 列' : ''));
      lines.push('記入帳戶：' + account);
      lines.push('');

      var byCode = {};
      fresh.forEach(r => {
        var k = r.code + '|' + r.action;
        if (!byCode[k]) byCode[k] = { name: r.name, action: r.action, code: r.code, shares: 0, net: 0, n: 0 };
        byCode[k].shares += r.shares; byCode[k].net += Math.abs(r.net); byCode[k].n++;
      });
      Object.keys(byCode).sort().forEach(k => {
        var g = byCode[k];
        lines.push('▸ ' + g.code + ' ' + g.name + ' ' + g.action + ' ' +
          _money(g.shares) + ' 股（' + g.n + ' 筆），金額 ' + _money(g.net));
      });
      if (dupQty.length) {
        lines.push('');
        lines.push('已登錄過（不重複記）：');
        dupQty.forEach(d => lines.push('  ' + d));
      }
      if (parsed.errors.length) {
        lines.push('');
        parsed.errors.forEach(e => lines.push('⚠️ ' + e));
      }

      if (options.dryRun) return lines.join('\n');
      if (fresh.length === 0) return lines.join('\n') + '\n\n沒有新資料，未寫入。';

      var stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
      fresh.forEach(r => {
        AssetSchema.appendTrade({
          '日期': r.date, '動作': r.action, '代號': r.code,
          '股數': r.shares, '單價': r.price,
          '手續費': r.fee, '交易稅': r.tax,
          '幣別': 'TWD', '帳戶': account, '分類': '投資',
          '備註': '對帳單匯入｜委託書號 ' + (r.order || '—') +
                  '｜報表單價 ' + r.shownPrice + '｜淨收付 ' + _money(r.net) + '｜' + r.key,
          '來源': 'csv', '建立時間': stamp
        }, ss);
      });

      var rebuilt = Position.rebuild();
      lines.push('');
      if (rebuilt && rebuilt.ok) {
        var pos = AssetSchema.readObjects(ss.getSheetByName('持倉'));
        Object.keys(byCode).map(k => byCode[k].code).filter((v, i, a) => a.indexOf(v) === i)
          .sort().forEach(code => {
            var p = pos.filter(x => _str(x['代號']) === code)[0];
            if (p) lines.push('▸ ' + code + ' 現在 ' + _money(p['股數']) + ' 股' +
              (_num(p['已實現損益']) ? '，已實現損益 ' + _money(p['已實現損益']) : ''));
          });
        if (rebuilt.warnings && rebuilt.warnings.length) {
          lines.push('⚠️ ' + rebuilt.warnings.join('；'));
        }
      } else {
        lines.push('⚠️ 已寫入但重算失敗：' + (rebuilt && rebuilt.reason ? rebuilt.reason : '未知'));
      }

      Logger.info('AssetImport.importStatement', '對帳單匯入完成', {
        total: parsed.rows.length, imported: fresh.length,
        dupKey: dupKey, dupQty: dupQty.length, account: account
      });
      return lines.join('\n');

    } catch (ex) {
      Logger.error('AssetImport.importStatement', '匯入失敗', ex);
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

      // 看標題列決定是哪一種報表；兩種都不像就講清楚，不要硬解析
      var header = (m.parseCsv(text)[0] || []).map(_str);
      var kind = header.indexOf('委託書號') >= 0 ? 'statement'
               : header.indexOf('賣出日期') >= 0 ? 'realized'
               : '';

      Logger.info('AssetImport.fromUpload', '收到檔案', {
        name: doc.fileName, size: doc.fileSize, dryRun: dryRun, kind: kind || '未知'
      });

      if (kind === 'statement') return m.importStatement(text, { dryRun: dryRun });
      if (kind === 'realized')  return m.importRealized(text, { dryRun: dryRun });

      return '看不懂這份 CSV 的格式。目前認得兩種：\n' +
             '▸ 證券對帳單（有「委託書號」欄）—— 買賣都會記\n' +
             '▸ 已實現損益（有「賣出日期」欄）—— 只記賣出\n' +
             '收到的標題列是：' + header.join('、');

    } catch (ex) {
      Logger.error('AssetImport.fromUpload', '處理上傳檔案失敗', ex);
      return '讀取檔案時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  return m;
})();
