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
        var haystack = (String(row[0]) + ' ' + String(row[1])).toLowerCase();
        var matched  = keywords.every(k => haystack.includes(k.toLowerCase()));
        if (matched) hits.push('[' + row[0] + ']: ' + row[1]);
      });

      if (hits.length === 0) return '沒有找到與「' + query + '」相關的知識';
      return hits.slice(0, 5).join('\n');
    } catch (ex) {
      Logger.error('GoogleSheet.searchKnowledge', '搜尋知識失敗', ex);
      return '搜尋時發生錯誤：' + ex.message;
    }
  };

  return gs;
})();
