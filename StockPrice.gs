/**
 * StockPrice
 * @description 查詢台灣上市 ETF / 股票即時（或最新）股價
 * 使用 TWSE 開放 API，免費無需 API Key，資料延遲約 20 分鐘
 * 注意：僅支援上市（TSE）股票，上櫃（OTC）不適用
 */
var StockPrice = (() => {
  var sp = {};

  var _fetch = (list) => {
    try {
      var codes    = list.map(s => 'tse_' + s + '.tw').join('|');
      var url      = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp' +
                     '?ex_ch=' + encodeURIComponent(codes) + '&_=' + Date.now();
      var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (response.getResponseCode() !== 200) return [];
      var data = JSON.parse(response.getContentText());
      return data.msgArray || [];
    } catch (ex) {
      Logger.error('StockPrice._fetch', '失敗', ex);
      return [];
    }
  };

  /**
   * 供內部使用：回傳結構化股價陣列
   * @returns {Array<{code, name, current, yesterday, changePct, isClosed}>}
   */
  sp.getRawPrices = (symbols) => {
    var list  = typeof symbols === 'string'
      ? symbols.split(/[,\s]+/).map(s => s.trim()).filter(s => s)
      : symbols;
    var items = _fetch(list);
    return items.map(item => {
      var isClosed  = !item.z || item.z === '-';
      var current   = parseFloat(isClosed ? item.y : item.z) || 0;
      var yesterday = parseFloat(item.y) || 0;
      var changePct = yesterday ? (current - yesterday) / yesterday : 0;
      return { code: item.c, name: item.n, current: current, yesterday: yesterday, changePct: changePct, isClosed: isClosed };
    });
  };

  /**
   * 查詢一或多檔股票的即時股價
   * @param {string} symbols - 股票代號，多檔用逗號或空白分隔，例如 "0056,2330"
   * @returns {string} 格式化價格資訊
   */
  sp.getPrice = (symbols) => {
    try {
      var list = String(symbols).split(/[,\s]+/).map(s => s.trim()).filter(s => s);
      if (list.length === 0) return '請提供股票代號';
      if (list.length > 10)  return '一次最多查詢 10 檔';

      Logger.info('StockPrice.getPrice', '查詢股價', { symbols: list });

      var items = _fetch(list);
      if (items.length === 0) return '查無資料，請確認代號是否正確（僅支援上市股票）';

      var lines = items.map(item => {
        var isClosed  = !item.z || item.z === '-';
        var price     = isClosed ? item.y : item.z;
        var yesterday = parseFloat(item.y) || 0;
        var current   = parseFloat(price)  || 0;
        var change    = yesterday ? (current - yesterday).toFixed(2) : 'N/A';
        var changePct = yesterday ? ((current - yesterday) / yesterday * 100).toFixed(2) + '%' : 'N/A';
        var status    = isClosed ? '收盤價' : '即時價';

        return '▸ ' + item.n + '（' + item.c + '）\n' +
               '  ' + status + '：' + price + '　昨收：' + item.y + '\n' +
               '  漲跌：' + change + '　幅度：' + changePct + '\n' +
               '  開盤：' + (item.o || '-') + '　最高：' + (item.h || '-') + '　最低：' + (item.l || '-');
      });

      Logger.info('StockPrice.getPrice', '查詢完成', { count: lines.length });
      return lines.join('\n\n');
    } catch (ex) {
      Logger.error('StockPrice.getPrice', '查詢失敗', ex);
      return '股價查詢時發生錯誤：' + ex.message;
    }
  };

  return sp;
})();
