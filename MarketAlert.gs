/**
 * MarketAlert
 * @description 盤中異動警報：持倉 ETF 單日跌幅超過閾值時主動 push 通知
 * 每日 10:00 與 14:00 由 Trigger 執行
 */

function marketAlert() {
  try {
    // 週六日跳過（非交易日）
    var today = new Date();
    var dow   = today.getDay();
    if (dow === 0 || dow === 6) return;

    var dateStr = Utilities.formatDate(today, 'GMT+8', 'yyyyMMdd');
    var timeStr = Utilities.formatDate(today, 'GMT+8', 'HH:mm');

    // 讀取目前仍持有的標的（新表「持倉」，股數 0 的已出清標的不必警報）
    var ss    = Snapshot._open();
    var sheet = ss.getSheetByName('持倉');
    if (!sheet) return;

    var codes = AssetSchema.readObjects(sheet)
      .filter(function(r) { return Number(String(r['股數']).replace(/,/g, '')) > 0; })
      .map(function(r) { return String(r['代號']).trim(); })
      .filter(function(c) { return c !== ''; });

    if (codes.length === 0) return;

    // 取得即時股價（結構化）
    var prices = StockPrice.getRawPrices(codes);
    if (!prices || prices.length === 0) {
      Logger.info('marketAlert', '無法取得股價，可能為非交易時段');
      return;
    }

    // 比對閾值，過濾出異常跌幅
    var cache     = CacheService.getScriptCache();
    var threshold = Config.ALERT_ETF_DROP;
    var alerts    = [];

    prices.forEach(function(p) {
      if (p.isClosed || !p.yesterday) return; // 收盤或無昨收資料，跳過
      if (p.changePct > -threshold) return;   // 未達跌幅閾值

      var cacheKey = 'alert_' + p.code + '_' + dateStr;
      if (cache.get(cacheKey)) return; // 今日此檔已警報過

      alerts.push(p);
      cache.put(cacheKey, '1', 8 * 3600); // 8 小時內不重複警報
    });

    if (alerts.length === 0) {
      Logger.info('marketAlert', '無異常', { time: timeStr });
      return;
    }

    // 組裝警報訊息
    var lines = ['⚠ 持倉異動警報（' + timeStr + '）\n'];
    alerts.forEach(function(p) {
      lines.push('▸ ' + p.name + '（' + p.code + '）');
      lines.push('  現價 ' + p.current + '　跌幅 ' + (p.changePct * 100).toFixed(2) + '%');
    });
    lines.push('\n可詢問 Iris 分析原因或影響。');

    var message = lines.join('\n');
    var masters = Config.ADMIN_STRING.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
    masters.forEach(function(userId) { MessagingServiceFactory.push(userId, message); });

    Logger.info('marketAlert', '警報發送', { count: alerts.length, time: timeStr });
  } catch (ex) {
    Logger.error('marketAlert', '警報失敗', ex);
  }
}
