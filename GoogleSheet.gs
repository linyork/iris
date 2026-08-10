/**
 * GoogleSheet
 * @description Google Sheets 資料存取層
 *
 * 預期試算表結構：
 *   env              — B2: DEBUG_MODE (true/false)、B3: AI_PROVIDER
 *   consolelog       — [timestamp, level, tag, message, details]
 *   chat             — [userId, role, message, timestamp]
 *   short_term_memory— [key, content, expire_at, category]
 *   knowledge        — [tags, content, timestamp]
 *
 * ⚠️ 本檔直接讀寫的只有上面那幾張系統分頁。資產類的讀取
 *    （getHoldings / getDashboard / getHistory / getDividendHistory）是格式化層：
 *    資料一律向 Snapshot 與 AssetSchema 拿，不自己讀資產分頁。
 */
var GoogleSheet = (() => {
  var gs = {};

  var _ssCache = null;
  var getSheet = () => {
    if (_ssCache) return _ssCache;
    _ssCache = SpreadsheetApp.openById(Config.SHEET_ID);
    return _ssCache;
  };

  // ─── Logging ───────────────────────────────────────────────────

  gs.setLog = (level, tag, message, details) => {
    try {
      var sheet = getSheet().getSheetByName('consolelog');
      if (!sheet) return;
      var timestamp = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm:ss');
      sheet.appendRow([timestamp, level, tag, String(message), String(details || '')]);
    } catch (e) { /* 靜默失敗 */ }
  };

  // ─── Chat History ──────────────────────────────────────────────

  /**
   * 取得指定使用者的對話歷史（最新 N 筆）
   * @returns {Array<{userId, role, message, timestamp}>}
   */
  gs.getChatHistory = (userId, limit) => {
    try {
      var sheet = getSheet().getSheetByName('chat');
      if (!sheet) return [];
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return [];

      var data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
      var rows = data.filter(r => r[0] === userId);
      return rows.slice(-limit).map(r => ({
        userId:    r[0],
        role:      r[1],
        message:   r[2],
        timestamp: r[3]
      }));
    } catch (ex) {
      Logger.error('GoogleSheet.getChatHistory', '讀取對話歷史失敗', ex);
      return [];
    }
  };

  /**
   * 儲存一筆對話訊息
   * @param {string} userId
   * @param {string} role   - 'user' | 'assistant'
   * @param {string} message
   */
  gs.saveChatMessage = (userId, role, message) => {
    try {
      var sheet = getSheet().getSheetByName('chat');
      if (!sheet) return;
      var timestamp = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm:ss');
      sheet.appendRow([userId, role, message, timestamp]);
    } catch (ex) {
      Logger.error('GoogleSheet.saveChatMessage', '儲存訊息失敗', ex);
    }
  };

  // ─── Short-Term Memory ────────────────────────────────────────

  /**
   * 新增或更新短期記憶
   * Sheet 結構: [key, content, expire_at, category]
   * @param {string} key           - 記憶鍵值（主題標識）
   * @param {string} content       - 記憶內容
   * @param {number} durationHours - 有效時數
   * @param {string} [category]    - 分類 (fact/task/context)
   */
  gs.addShortTermMemory = (key, content, durationHours, category) => {
    try {
      var sheet = getSheet().getSheetByName('short_term_memory');
      if (!sheet) return '（找不到 short_term_memory 工作表）';

      var now        = new Date();
      var expireTime = new Date(now.getTime() + durationHours * 3600000);
      var expireStr  = Utilities.formatDate(expireTime, 'GMT+8', 'yyyy/MM/dd HH:mm:ss');
      var createStr  = Utilities.formatDate(now, 'GMT+8', 'MM/dd HH:mm');
      var contentWithTime = content + ' (記於 ' + createStr + ')';

      // 找現有同 key 的列
      var lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
        for (var i = 0; i < data.length; i++) {
          if (data[i][0] === key) {
            var row = i + 2;
            sheet.getRange(row, 2, 1, 3).setValues([[contentWithTime, expireStr, category || '']]);
            Utils.noteLedgerWrite('短期記憶 更新 ' + key);
            return '已更新「' + key + '」的記憶（時效 ' + durationHours + ' 小時）';
          }
        }
      }
      sheet.appendRow([key, contentWithTime, expireStr, category || '']);
      Utils.noteLedgerWrite('短期記憶 新增 ' + key);
      return '已記住「' + key + '」（時效 ' + durationHours + ' 小時）';
    } catch (ex) {
      Logger.error('GoogleSheet.addShortTermMemory', '寫入短期記憶失敗', ex);
      return '短期記憶寫入失敗：' + ex.message;
    }
  };

  /**
   * 取得目前有效的短期記憶（過期的自動跳過）
   * @returns {string} 格式化文字
   */
  gs.getValidShortTermMemories = () => {
    try {
      var sheet = getSheet().getSheetByName('short_term_memory');
      if (!sheet) return '';
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return '';

      var now  = new Date();
      var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
      var lines = [];
      data.forEach(row => {
        if (!row[0]) return;
        var expireAt = new Date(row[2]);
        if (expireAt > now) lines.push('[' + row[0] + ']: ' + row[1]);
      });
      return lines.join('\n');
    } catch (ex) {
      Logger.error('GoogleSheet.getValidShortTermMemories', '讀取短期記憶失敗', ex);
      return '';
    }
  };

  /**
   * 清理已過期的短期記憶（每日排程呼叫）
   */
  gs.cleanExpiredShortTermMemories = () => {
    try {
      var sheet = getSheet().getSheetByName('short_term_memory');
      if (!sheet) return;
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return;

      var now  = new Date();
      var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
      var toDelete = [];
      data.forEach((row, i) => {
        if (row[2] && new Date(row[2]) <= now) toDelete.push(i + 2);
      });
      toDelete.reverse().forEach(r => sheet.deleteRow(r));
      if (toDelete.length > 0) {
        Logger.info('GoogleSheet.cleanExpiredShortTermMemories', '清理過期記憶 ' + toDelete.length + ' 筆');
      }
    } catch (ex) {
      Logger.error('GoogleSheet.cleanExpiredShortTermMemories', '清理失敗', ex);
    }
  };

  // ─── Knowledge ────────────────────────────────────────────────

  /**
   * 新增或更新長期知識點（關鍵字搜尋，無向量）
   * Sheet 結構: [tags, content, timestamp]
   * @param {string} tags    - 標籤（逗號分隔）
   * @param {string} content - 知識內容
   */
  gs.addKnowledge = (tags, content) => {
    try {
      var sheet = getSheet().getSheetByName('knowledge');
      if (!sheet) return '（找不到 knowledge 工作表）';

      var timestamp = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm:ss');
      var normalTags = String(tags).split(',').map(t => t.trim()).sort().join(',');

      // 若已存在相同 tags 則覆蓋
      var lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
        for (var i = 0; i < data.length; i++) {
          var existTags = String(data[i][0]).split(',').map(t => t.trim()).sort().join(',');
          if (existTags === normalTags) {
            sheet.getRange(i + 2, 2, 1, 2).setValues([[content, timestamp]]);
            Utils.noteLedgerWrite('知識 更新 ' + tags);
            return '已更新知識點「' + tags + '」';
          }
        }
      }
      sheet.appendRow([tags, content, timestamp]);
      Utils.noteLedgerWrite('知識 新增 ' + tags);
      return '已記錄知識點「' + tags + '」';
    } catch (ex) {
      Logger.error('GoogleSheet.addKnowledge', '新增知識失敗', ex);
      return '記錄知識點時發生錯誤：' + ex.message;
    }
  };

  /**
   * 把查詢切成可以比對的詞：CJK 切 bigram，英數字與代號整段保留。
   * ⚠️ 不可只用 split(/\s+/)：中文沒有空白，整句會變成一個詞，
   *    只有原文完全出現才算命中，而且會安靜地回「沒有找到」。
   *    bigram 會製造雜訊，靠標籤加權與取前 N 名壓下去。
   */
  var _tokens = (s) => {
    var out = [];
    String(s || '').toLowerCase().split(/[\s，。、？！,.?!；;：:「」（）()]+/).forEach(part => {
      if (!part) return;
      (part.match(/[a-z0-9]{2,}/g) || []).forEach(t => out.push(t));   // 代號、英文縮寫
      var cjk = part.replace(/[^一-鿿]/g, '');
      if (cjk.length === 1) out.push(cjk);
      for (var i = 0; i + 1 < cjk.length; i++) out.push(cjk.substr(i, 2));
    });
    return out.filter((v, i, a) => a.indexOf(v) === i);
  };

  /** `[決策]` / `[目標]` / `[偏好]` 是主人立的規矩，不是一般知識 */
  var STANDING_RE = /^\s*\[(決策|目標|偏好)\]/;

  /** 逐筆算分：標籤命中比內文命中重要得多（標籤是人為下的主題） */
  var _scored = (query) => {
    var sheet = getSheet().getSheetByName('knowledge');
    if (!sheet) return null;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    var data   = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    var tokens = _tokens(query);

    return data.filter(r => r[0] || r[1]).map(row => {
      var tags = String(row[0] || '').toLowerCase();
      var body = String(row[1] || '').toLowerCase();
      var score = 0;
      tokens.forEach(t => {
        if (tags.indexOf(t) >= 0) score += 3;
        else if (body.indexOf(t) >= 0) score += 1;
      });
      return {
        text: '[' + row[0] + ']: ' + row[1],
        standing: STANDING_RE.test(String(row[0] || '')),
        score: score
      };
    });
  };

  /**
   * 關鍵字搜尋知識庫（工具用，回傳最多 5 筆）
   * @param {string} query - 查詢關鍵字
   * @returns {string} 匹配結果文字
   */
  gs.searchKnowledge = (query) => {
    try {
      var rows = _scored(query);
      if (rows === null) return '（找不到 knowledge 工作表）';
      if (rows.length === 0) return '（知識庫尚無資料）';

      var hits = rows.filter(r => r.score > 0).sort((a, b) => b.score - a.score);
      if (hits.length === 0) return '沒有找到與「' + query + '」相關的知識';
      return hits.slice(0, 5).map(h => h.text).join('\n');
    } catch (ex) {
      Logger.error('GoogleSheet.searchKnowledge', '搜尋知識失敗', ex);
      return '搜尋時發生錯誤：' + ex.message;
    }
  };

  /**
   * 注入 prompt 用的知識：[決策]／[目標]／[偏好] 一律帶上，其餘才靠關鍵字撈。
   *
   * ⚠️ 分兩層是必要的。人設要求「主人設過的 [目標] 要主動比對」，
   *    而那條規則只有在目標真的出現在 prompt 裡才成立。純靠關鍵字的話，
   *    問「現金太多了嗎」而目標寫成「年底前現金比例降到 20%」就撈不到，
   *    規則等於失效且沒有人會發現。這類規矩數量少，每次都帶得起。
   *
   * @param {string} message 這一輪使用者說的話
   * @returns {string} 空字串代表沒有東西可帶
   */
  gs.knowledgeForPrompt = (message) => {
    try {
      var rows = _scored(message);
      if (!rows || rows.length === 0) return '';

      var standing = rows.filter(r => r.standing).slice(0, 10);
      var picked   = standing.slice();

      rows.filter(r => !r.standing && r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .forEach(r => picked.push(r));

      return picked.map(r => r.text).join('\n');
    } catch (ex) {
      Logger.warning('GoogleSheet.knowledgeForPrompt', '組知識區塊失敗（已略過）',
        ex && ex.message ? ex.message : String(ex));
      return '';
    }
  };

  // ─── Dividend ─────────────────────────────────────────────────

  /**
   * 讀取股利歷史紀錄
   * @param {number} [year] - 指定年份（可選，預設全部）
   * @returns {string} 格式化統計文字
   */
  gs.getDividendHistory = (year) => {
    try {
      var ss = Snapshot._open();
      var rows = AssetSchema.readTrades(ss)
        .filter(r => String(r['動作'] || '').trim() === '股利')
        .map(r => ({
          date: r['日期'] instanceof Date ? r['日期'] : new Date(String(r['日期'])),
          code: String(r['代號'] || '').trim(),
          amount: Number(String(r['金額']).replace(/[,$]/g, '')) || 0
        }))
        .filter(r => r.date && !isNaN(r.date.getTime()) && r.amount > 0);

      if (rows.length === 0) return '（尚無股利紀錄）';
      if (year) rows = rows.filter(r => r.date.getFullYear() === Number(year));
      if (rows.length === 0) return '（' + year + ' 年沒有股利紀錄）';

      var byYear = {}, byCode = {};
      rows.forEach(r => {
        var y = r.date.getFullYear();
        byYear[y] = (byYear[y] || 0) + r.amount;
        byCode[r.code] = (byCode[r.code] || 0) + r.amount;
      });

      var out = [];
      var total = rows.reduce((s, r) => s + r.amount, 0);
      out.push('股利合計 ' + Math.round(total).toLocaleString() + '（' + rows.length + ' 筆）');

      out.push('【依年度】');
      Object.keys(byYear).sort().forEach(y => {
        out.push('  ' + y + ': ' + Math.round(byYear[y]).toLocaleString());
      });

      out.push('【依標的】');
      Object.keys(byCode)
        .sort((a, b) => byCode[b] - byCode[a])
        .forEach(c => out.push('  ' + c + ': ' + Math.round(byCode[c]).toLocaleString()));

      out.push('【最近 5 筆】');
      rows.sort((a, b) => a.date - b.date).slice(-5).reverse().forEach(r => {
        out.push('  ' + Utilities.formatDate(r.date, 'GMT+8', 'yyyy-MM-dd') +
          ' ' + r.code + ' ' + Math.round(r.amount).toLocaleString());
      });

      return out.join('\n');
    } catch (ex) {
      Logger.error('GoogleSheet.getDividendHistory', '讀取股利紀錄失敗', ex);
      return '讀取股利紀錄時發生錯誤：' + ex.message;
    }
  };


  gs.listMemories = () => {
    try {
      var lines = [];
      var now = new Date();

      var stmSheet = getSheet().getSheetByName('short_term_memory');
      lines.push('【短期記憶】');
      if (stmSheet && stmSheet.getLastRow() >= 2) {
        var stmData = stmSheet.getRange(2, 1, stmSheet.getLastRow() - 1, 3).getValues();
        var valid   = stmData.filter(r => r[0] && new Date(r[2]) > now);
        if (valid.length > 0) {
          valid.forEach(r => lines.push('▸ ' + r[0] + '：' + r[1]));
        } else {
          lines.push('（目前無有效記憶）');
        }
      } else {
        lines.push('（目前無有效記憶）');
      }

      lines.push('');
      lines.push('【長期知識】');
      var knSheet = getSheet().getSheetByName('knowledge');
      if (knSheet && knSheet.getLastRow() >= 2) {
        var knData = knSheet.getRange(2, 1, knSheet.getLastRow() - 1, 2).getValues();
        var knValid = knData.filter(r => r[0]);
        if (knValid.length > 0) {
          knValid.forEach(r => lines.push('▸ [' + r[0] + ']：' + r[1]));
        } else {
          lines.push('（目前無資料）');
        }
      } else {
        lines.push('（目前無資料）');
      }

      return lines.join('\n');
    } catch (ex) {
      Logger.error('GoogleSheet.listMemories', '列出記憶失敗', ex);
      return '列出記憶時發生錯誤：' + ex.message;
    }
  };

  /**
   * 刪除指定的短期記憶或長期知識
   * @param {string} type - 'stm' 或 'knowledge'
   * @param {string} key  - STM 的 key 或 knowledge 的 tags
   */
  gs.deleteMemory = (type, key) => {
    try {
      var sheetName = type === 'stm' ? 'short_term_memory' : 'knowledge';
      var sheet = getSheet().getSheetByName(sheetName);
      if (!sheet) return '找不到工作表：' + sheetName;
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return '記憶庫為空';

      var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = data.length - 1; i >= 0; i--) {
        if (String(data[i][0]).trim() === String(key).trim()) {
          sheet.deleteRow(i + 2);
          Utils.noteLedgerWrite(sheetName + ' 刪除 ' + key);
          return '已刪除「' + key + '」';
        }
      }
      return '找不到「' + key + '」，請用 listMemories 確認正確名稱';
    } catch (ex) {
      Logger.error('GoogleSheet.deleteMemory', '刪除失敗', ex);
      return '刪除失敗：' + ex.message;
    }
  };

  // ─── Portfolio Tools ──────────────────────────────────────────

  /**
   * 持倉明細（給 LLM 讀的文字）。走 Snapshot._holdings，不自己讀表。
   *
   * ⚠️ 開頭必須有【資料時點】。這裡的數字時效各不相同：股數與成本凍結於上次重算、
   *    市價是試算表活公式、當日漲跌來自 TWSE 延遲報價，其中有些價可能是備援補的死值。
   *    不標明的話模型只能當成同一時刻的快照來讀。
   *    時點來自 _metrics().lastRebuild 與 .warnings，不是新算的。
   */
  gs.getHoldings = () => {
    try {
      var ss = Snapshot._open();
      var rows = Snapshot._holdings(ss);
      if (!rows || rows.length === 0) return '（尚無持倉資料）';

      var metrics = Snapshot._metrics(ss) || {};

      var fmt = (n) => (n === null || n === undefined) ? '—' : Math.round(n).toLocaleString();
      var pct = (n) => (n === null || n === undefined) ? '—' : (n * 100).toFixed(2) + '%';

      var totalValue = rows.reduce((s, r) => s + (r.marketValue || 0), 0);
      var totalCost  = rows.reduce((s, r) => s + (r.costBasis || 0), 0);
      var totalDiv   = rows.reduce((s, r) => s + (r.totalDividendReceived || 0), 0);

      var lines = rows.map(r => {
        var parts = [
          '股數: ' + fmt(r.shares),
          '市價: ' + r.price,
          '市值: ' + fmt(r.marketValue),
          '成本: ' + fmt(r.costBasis),
          '損益: ' + fmt(r.pnl) + '（' + pct(r.pnlPct) + '）',
          '累計股利: ' + fmt(r.totalDividendReceived),
          // ⚠️ 分母要寫出來。這個比例是「佔股票市值」，不是「佔總資產」——
          //    只寫「佔比」的話，模型會拿它跟事實區塊裡的「股票／現金／實體佔總資產」
          //    放在一起講，兩個不同分母的百分比並排，讀的人無從察覺。
          //    2026-08-09 實測：009826 被講成「32.22%」，那是佔股票市值，
          //    佔總資產其實是 20.6%。
          '佔股票市值: ' + pct(r.ratioOfPortfolio)
        ];
        // 「今天漲跌」只有在真的拿得到當日成交價時才講。取不到就明講取不到 ——
        // 舊版會印「今日: 0.00%」，那個 0 是昨收減昨收算出來的，模型無從分辨
        // 它是「今天平盤」還是「沒有資料」，於是每到盤後就會告訴主人全部平盤。
        if (r.dayChangePct !== null && r.dayChangePct !== undefined) {
          parts.push('今日: ' + pct(r.dayChangePct));
        } else if (r.isClosed) {
          parts.push('今日: 取不到當日成交價（非交易時段或該檔今日無成交），不是平盤');
        }
        if (r.realizedPnl) parts.push('已實現損益: ' + fmt(r.realizedPnl));
        if (r.priceMissing) parts.push('⚠️ 市價抓不到，市值不可信');
        return r.code + ' ' + r.name + '\n  ' + parts.join(' | ');
      });

      lines.push('【合計】\n  市值: ' + fmt(totalValue) +
        ' | 成本: ' + fmt(totalCost) +
        ' | 未實現損益: ' + fmt(totalValue - totalCost) +
        '（' + (totalCost > 0 ? pct((totalValue - totalCost) / totalCost) : '—') + '）' +
        ' | 累計股利: ' + fmt(totalDiv));

      // 時點放最前面，讓模型在讀到任何數字之前就知道它們各是什麼時候的
      var asOf = ['【資料時點】'];
      asOf.push('  股數／成本／累計股利：上一次重算' +
        (metrics.lastRebuild ? '（' + metrics.lastRebuild + '）' : '（時間不詳）'));
      asOf.push('  市價／市值：試算表的 GOOGLEFINANCE 公式，更新時機不固定，不保證是此刻的價');
      asOf.push('  當日漲跌：TWSE 即時報價，延遲約 20 分鐘；非交易時段取不到，會標明');
      if (metrics.warnings && metrics.warnings.length) {
        // 備援補價、懸空的賣出都寫在這裡。`getDashboard` 印得出來，以前這支印不出來，
        // 於是「這個價是補的死值」這件事只有問總覽的人看得到。
        asOf.push('  ⚠️ 待修正：' + metrics.warnings.join('；'));
      }

      return asOf.join('\n') + '\n\n' + lines.join('\n\n');
    } catch (ex) {
      Logger.error('GoogleSheet.getHoldings', '讀取持倉失敗', ex);
      return '讀取持倉時發生錯誤：' + ex.message;
    }
  };

  /**
   * 總覽儀表板：指標（直式 key-value）＋ 各帳戶現金 ＋ 配置三個維度
   */
  gs.getDashboard = () => {
    try {
      var ss = Snapshot._open();
      var out = [];

      var panel = AssetSchema.readObjects(ss.getSheetByName('指標'));
      if (panel.length) {
        out.push('【資產總覽】');
        panel.forEach(r => {
          var k = String(r['指標'] || '').trim();
          if (!k) return;
          // 指標表用「—— 標題 ——」當分隔列，值是空的
          if (/^——/.test(k)) { out.push(k); return; }
          var v = r['數值'];
          if (v === '' || v === null || v === undefined) return;
          var note = String(r['說明'] || '').trim();
          out.push('  ' + k + ': ' + v + (note ? '（' + note + '）' : ''));
        });
      }

      var cash = Snapshot._cash(ss);
      if (cash) {
        out.push('【各帳戶現金（已換算台幣）】');
        cash.accounts.forEach(a => out.push('  ' + a.account + ': ' + a.amount.toLocaleString()));
        out.push('  合計: ' + cash.total.toLocaleString());
      }

      var alloc = AssetSchema.readObjects(ss.getSheetByName('配置'));
      if (alloc.length) {
        out.push('【資產配置】');
        alloc.forEach(r => {
          var pairs = Object.keys(r)
            .filter(k => r[k] !== '' && r[k] !== null && r[k] !== undefined)
            .map(k => k + ': ' + r[k])
            .join(' | ');
          if (pairs) out.push('  ' + pairs);
        });
      }

      return out.join('\n') || '（無資料）';
    } catch (ex) {
      Logger.error('GoogleSheet.getDashboard', '讀取儀表板失敗', ex);
      return '讀取儀表板時發生錯誤：' + ex.message;
    }
  };

  /**
   * 最近 N 天的總資產走勢（每日快照的合計列）
   *
   * 舊版把每一檔的當日股價都塞進回覆，動輒上百行；這裡只給總資產與股票市值，
   * 單一標的的歷史價格不是 LLM 回答「最近漲跌」需要的東西。
   */
  gs.getHistory = (days) => {
    try {
      days = Math.min(days || 30, 365);
      var ss = Snapshot._open();
      var series = Snapshot.totalSeries(days, ss);
      if (!series.length) return '（尚無歷史紀錄）';

      var first = series[0], last = series[series.length - 1];
      var head = '最近 ' + series.length + ' 筆總資產紀錄（' +
        first.date + ' → ' + last.date + '）：';

      // ⚠️ `status` 只在**不是正常交易日**時才有值（休市／資料未更新／報價異常）。
      //    以前這裡只印日期與金額，把它丟掉了 —— 於是一段平掉的曲線，模型無從分辨
      //    是放假、是抓價失敗、還是真的沒有變動，只能猜，而猜出來的講得跟事實一樣。
      //    這與「拿不到當日成交價卻回 0%」是同一種病：資訊在下層算好了，排版時掉了。
      var body = series.map(r =>
        r.date + ': ' + Math.round(r.total).toLocaleString() + (r.status ? '（' + r.status + '）' : ''));
      if (body.length > 40) {
        body = body.slice(0, 10).concat(['... 中間省略 ' + (body.length - 20) + ' 筆 ...'])
                   .concat(body.slice(-10));
      }

      var change = last.total - first.total;
      var pct = first.total > 0 ? (change / first.total * 100).toFixed(2) + '%' : '—';
      var out = head + '\n' + body.join('\n') +
        '\n區間變化: ' + Math.round(change).toLocaleString() + '（' + pct + '）';

      // 中間被省略的那段也可能有異常日，所以統計要算**整個序列**，不能只看印出來的行
      var abnormal = {};
      series.forEach(r => { if (r.status) abnormal[r.status] = (abnormal[r.status] || 0) + 1; });
      var kinds = Object.keys(abnormal);
      if (kinds.length) {
        out += '\n⚠️ 其中 ' + kinds.map(k => abnormal[k] + ' 天' + k).join('、') +
          '。「資料未更新」與「報價異常」那幾天的數字不可信，' +
          '計算波動或漲跌統計前要先排除，不要當成「那天沒有變動」。';
      }
      // 端點本身就是異常日的話，區間變化是拿一個不可信的數字當基準算出來的
      if (first.status || last.status) {
        out += '\n⚠️ 區間' + (first.status ? '起點（' + first.date + '：' + first.status + '）' : '') +
          (first.status && last.status ? '與' : '') +
          (last.status ? '終點（' + last.date + '：' + last.status + '）' : '') +
          '不是正常交易日，上面的「區間變化」以此為基準，請一併說明。';
      }
      return out;
    } catch (ex) {
      Logger.error('GoogleSheet.getHistory', '讀取歷史紀錄失敗', ex);
      return '讀取歷史紀錄時發生錯誤：' + ex.message;
    }
  };


  return gs;
})();
