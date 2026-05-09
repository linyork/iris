/**
 * HistoryManager
 * @description 對話歷史管理 — 將 Sheet 資料轉換為 Gemini contents 格式
 */
var HistoryManager = (() => {
  var hm = {};

  /**
   * 取得使用者的對話歷史（Gemini contents 格式）
   * @param {string} userId
   * @param {number} maxTurns - 最多幾輪（一輪 = user + assistant 各一筆）
   * @returns {Array} Gemini contents 陣列
   */
  hm.getUserHistory = (userId, maxTurns) => {
    try {
      var rows = GoogleSheet.getChatHistory(userId, maxTurns * 2);
      Logger.info('HistoryManager.getUserHistory', '載入對話歷史', { rows: rows.length, maxTurns: maxTurns });
      return rows.map(r => ({
        role:  r.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: r.message }]
      }));
    } catch (ex) {
      Logger.error('HistoryManager.getUserHistory', '取得歷史失敗', ex);
      return [];
    }
  };

  /**
   * 儲存一筆訊息
   */
  hm.saveMessage = (userId, role, message) => {
    GoogleSheet.saveChatMessage(userId, role, message);
  };

  return hm;
})();
