/**
 * WebSearch
 * @description Google Custom Search API 封裝，供 Iris 查詢即時國際財經與時事資訊
 */
var WebSearch = (() => {
  var ws = {};

  /**
   * 搜尋網路，回傳前 5 筆結果摘要
   * @param {string} query - 搜尋關鍵字
   * @returns {string} 格式化結果文字
   */
  ws.search = (query) => {
    try {
      var apiKey = Config.GOOGLE_SEARCH_KEY;
      var cx     = Config.GOOGLE_SEARCH_CX;

      Logger.info('WebSearch.search', '執行搜尋', { query: query });

      if (!apiKey || !cx) {
        Logger.error('WebSearch.search', 'API Key 或 CX 未設定', { hasKey: !!apiKey, hasCx: !!cx });
        return '（searchWeb 未設定，請在 Script Properties 加入 GOOGLE_SEARCH_KEY 與 GOOGLE_SEARCH_CX）';
      }

      var url = Config.GOOGLE_SEARCH_API_BASE +
        '?key='      + encodeURIComponent(apiKey) +
        '&cx='       + encodeURIComponent(cx) +
        '&q='        + encodeURIComponent(query) +
        '&num=5' +
        '&dateRestrict=m1';

      var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      var code     = response.getResponseCode();

      if (code !== 200) {
        Logger.error('WebSearch.search', 'HTTP ' + code, response.getContentText().slice(0, 200));
        return '搜尋失敗（HTTP ' + code + '）';
      }

      var data = JSON.parse(response.getContentText());
      if (!data.items || data.items.length === 0) {
        Logger.warning('WebSearch.search', '查無結果', { query: query });
        return '沒有找到與「' + query + '」相關的結果';
      }

      Logger.info('WebSearch.search', '搜尋完成', { query: query, results: data.items.length });

      var lines = data.items.map((item, i) =>
        (i + 1) + '. ' + item.title + '\n   ' + (item.snippet || '') + '\n   來源：' + item.link
      );

      return '搜尋「' + query + '」的結果：\n\n' + lines.join('\n\n');
    } catch (ex) {
      Logger.error('WebSearch.search', '搜尋失敗', ex);
      return '搜尋時發生錯誤：' + ex.message;
    }
  };

  return ws;
})();
