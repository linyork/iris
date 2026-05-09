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
 *   所有股票          — row1: header, row2: 0000 合計列, row3+: 個別持股
 *   面板              — B1:B8 摘要, C1:D4 淨值, E1:F8 各帳戶現金
 *   配置              — row2-10: 各 ETF, row11-21: 配置比例
 *   @所有股票紀錄      — A:日期, B:總價值, C-J:各 ETF 股價, K+:現金
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
            return '已更新「' + key + '」的記憶（時效 ' + durationHours + ' 小時）';
          }
        }
      }
      sheet.appendRow([key, contentWithTime, expireStr, category || '']);
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
            return '已更新知識點「' + tags + '」';
          }
        }
      }
      sheet.appendRow([tags, content, timestamp]);
      return '已記錄知識點「' + tags + '」';
    } catch (ex) {
      Logger.error('GoogleSheet.addKnowledge', '新增知識失敗', ex);
      return '記錄知識點時發生錯誤：' + ex.message;
    }
  };

  /**
   * 關鍵字搜尋知識庫（回傳最多 5 筆）
   * @param {string} query - 查詢關鍵字
   * @returns {string} 匹配結果文字
   */
  gs.searchKnowledge = (query) => {
    try {
      var sheet = getSheet().getSheetByName('knowledge');
      if (!sheet) return '（找不到 knowledge 工作表）';
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return '（知識庫尚無資料）';

      var data     = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
      var keywords = query.split(/\s+/).filter(k => k.length > 0);
      var hits     = [];

      data.forEach(row => {
        var haystack   = (String(row[0]) + ' ' + String(row[1])).toLowerCase();
        var matchCount = keywords.filter(k => haystack.includes(k.toLowerCase())).length;
        if (matchCount > 0) hits.push({ text: '[' + row[0] + ']: ' + row[1], score: matchCount });
      });

      if (hits.length === 0) return '沒有找到與「' + query + '」相關的知識';
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, 5).map(h => h.text).join('\n');
    } catch (ex) {
      Logger.error('GoogleSheet.searchKnowledge', '搜尋知識失敗', ex);
      return '搜尋時發生錯誤：' + ex.message;
    }
  };

  // ─── Portfolio Tools ──────────────────────────────────────────

  /**
   * 取得完整持倉明細（所有股票 tab）
   * row2 = 0000 合計列，row3+ = 個別 ETF
   * @returns {string} 格式化文字
   */
  gs.getHoldings = () => {
    try {
      var sheet = getSheet().getSheetByName('所有股票');
      if (!sheet) return '（找不到「所有股票」工作表）';
      var lastRow = sheet.getLastRow();
      var lastCol = sheet.getLastColumn();
      if (lastRow < 2) return '（尚無持倉資料）';

      var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
      var data    = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

      var lines = data
        .filter(row => row[0] !== '' && row[0] !== null)
        .map(row => {
          var label = row[0] === '0000' ? '【合計】' : row[0] + ' ' + (row[1] || '');
          var pairs = headers
            .map((h, i) => {
              var v = row[i];
              if (h === '' || v === '' || v === null || v === '#' || (typeof v === 'string' && v.startsWith('#'))) return null;
              return h + ': ' + v;
            })
            .filter(p => p !== null)
            .join(' | ');
          return label + '\n  ' + pairs;
        });

      return lines.join('\n\n');
    } catch (ex) {
      Logger.error('GoogleSheet.getHoldings', '讀取持倉失敗', ex);
      return '讀取持倉時發生錯誤：' + ex.message;
    }
  };

  /**
   * 取得總覽儀表板（面板 + 配置 tab）
   * @returns {string} 格式化文字
   */
  gs.getDashboard = () => {
    try {
      var ss = getSheet();
      var lines = [];

      // ── 面板：摘要數字 ──────────────────────────────────────
      var panel = ss.getSheetByName('面板');
      if (panel) {
        // 左側摘要 A1:B8
        var leftLabels = panel.getRange('A1:A8').getValues();
        var leftVals   = panel.getRange('B1:B8').getValues();
        // 右側淨值 C1:D4
        var rightLabels = panel.getRange('C1:C4').getValues();
        var rightVals   = panel.getRange('D1:D4').getValues();
        // 現金帳戶 E1:F8
        var cashLabels  = panel.getRange('E1:E8').getValues();
        var cashVals    = panel.getRange('F1:F8').getValues();

        lines.push('【投資組合摘要】');
        for (var i = 0; i < 8; i++) {
          if (leftLabels[i][0]) lines.push('  ' + leftLabels[i][0] + ': ' + leftVals[i][0]);
        }
        lines.push('【淨值（扣除現金）】');
        for (var i = 0; i < 4; i++) {
          if (rightLabels[i][0]) lines.push('  ' + rightLabels[i][0] + ': ' + rightVals[i][0]);
        }
        lines.push('【各帳戶現金】');
        for (var i = 0; i < 8; i++) {
          if (cashLabels[i][0]) lines.push('  ' + cashLabels[i][0] + ': ' + cashVals[i][0]);
        }
      }

      // ── 配置：ETF 列表與比例 ────────────────────────────────
      var alloc = ss.getSheetByName('配置');
      if (alloc) {
        var lastRow = alloc.getLastRow();
        var lastCol = alloc.getLastColumn();
        var headers = alloc.getRange(1, 1, 1, lastCol).getValues()[0];
        var data    = alloc.getRange(2, 1, lastRow - 1, lastCol).getValues();

        lines.push('【資產配置】');
        data.forEach(row => {
          if (!row[0] && !row[1]) return; // 空列跳過
          var pairs = headers
            .map((h, i) => {
              if (!h || row[i] === '' || row[i] === null) return null;
              return h + ': ' + row[i];
            })
            .filter(p => p !== null)
            .join(' | ');
          if (pairs) lines.push('  ' + pairs);
        });
      }

      return lines.join('\n') || '（無資料）';
    } catch (ex) {
      Logger.error('GoogleSheet.getDashboard', '讀取儀表板失敗', ex);
      return '讀取儀表板時發生錯誤：' + ex.message;
    }
  };

  /**
   * 取得最近 N 天的每日資產快照（@所有股票紀錄 tab）
   * @param {number} days - 最近幾天（預設 30，最多 365）
   * @returns {string} 格式化文字
   */
  gs.getHistory = (days) => {
    try {
      days = Math.min(days || 30, 365);
      var sheet = getSheet().getSheetByName('@所有股票紀錄');
      if (!sheet) return '（找不到「@所有股票紀錄」工作表）';
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return '（尚無歷史紀錄）';

      var lastCol  = sheet.getLastColumn();
      var headers  = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
      var startRow = Math.max(2, lastRow - days + 1);
      var data     = sheet.getRange(startRow, 1, lastRow - startRow + 1, lastCol).getValues();

      var lines = data.map(row => {
        return headers
          .map((h, i) => {
            if (!h || row[i] === '' || row[i] === null) return null;
            return h + ': ' + row[i];
          })
          .filter(p => p !== null)
          .join(' | ');
      }).filter(l => l);

      var result = '最近 ' + lines.length + ' 筆紀錄：\n' + lines.join('\n');
      if (result.length > 4000) {
        var half = Math.floor(lines.length / 2);
        var trimmed = lines.slice(0, 5).concat(['... (中間省略) ...']).concat(lines.slice(-5));
        result = '最近 ' + lines.length + ' 筆紀錄（已截斷，顯示首尾各 5 筆）：\n' + trimmed.join('\n');
      }
      return result;
    } catch (ex) {
      Logger.error('GoogleSheet.getHistory', '讀取歷史紀錄失敗', ex);
      return '讀取歷史紀錄時發生錯誤：' + ex.message;
    }
  };

  return gs;
})();
