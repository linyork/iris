/**
 * Dashboard
 * @description 網頁儀表板的資料層與存取控制
 *
 * 資料完全重用 Snapshot 既有的結構化讀取器（_holdings / _cash / _allocation …），
 * 只補上圖表需要的時間序列，再包一層快取。這裡不做任何 LLM 呼叫。
 *
 * 存取控制見 isAuthorized()：webhook 用的那個 deployment 是「任何人、匿名」，
 * 若 doGet 不擋，資產數字等於掛在公開網址上。
 */
var Dashboard = (() => {
  var db = {};

  var CACHE_KEY = 'dashboard_payload_v1';

  // 15 分鐘。持倉的當日漲跌來自 TWSE 即時 API（本身就有約 20 分鐘延遲），
  // 而總資產快照一天只在 18:00 由 setData 寫一次，所以快取這個長度不會讓數字失真，
  // 卻能把重新整理的載入時間從數秒壓到幾乎瞬間。
  var CACHE_TTL = 900;

  // CacheService 單一 key 上限 100KB，超過會丟例外。留一點餘裕。
  var CACHE_MAX_BYTES = 90000;

  /**
   * 是否為試算表擁有者本人
   *
   * 「執行身分＝我、存取權＝任何人」的 webhook deployment 上，匿名訪客的
   * getActiveUser() 回空字串，於是被擋下；只有在「存取權＝只有我自己」的
   * deployment 以本人登入時，active 才會等於 effective。
   * 用兩者相等來判斷，就不必把 email 寫死在程式碼裡。
   */
  db.isAuthorized = () => {
    try {
      var active    = Session.getActiveUser().getEmail();
      var effective = Session.getEffectiveUser().getEmail();
      return !!active && !!effective && active === effective;
    } catch (e) {
      return false;
    }
  };

  /**
   * 組出儀表板所需的完整 payload
   * @param {boolean} [noCache] - true 則略過快取強制重讀
   * @returns {object}
   */
  db.getPayload = (noCache) => {
    var cache = CacheService.getScriptCache();

    if (!noCache) {
      try {
        var hit = cache.get(CACHE_KEY);
        if (hit) {
          var parsed = JSON.parse(hit);
          parsed.fromCache = true;
          return parsed;
        }
      } catch (e) {
        Logger.warning('Dashboard.getPayload', '快取讀取失敗，改為重算', e.message);
      }
    }

    var ss = SpreadsheetApp.openById(Config.SHEET_ID);

    var holdings = Snapshot._holdings(ss);
    var cash     = Snapshot._cash(ss);
    var series   = Snapshot.totalSeries(365, ss);

    var payload = {
      generatedAt: Utilities.formatDate(new Date(), 'GMT+8', 'yyyy-MM-dd HH:mm'),
      totals:      Snapshot._totals(ss),
      series:      series,
      holdings:    holdings,
      cash:        cash,
      dividends:   Snapshot._dividends(ss),
      dividendSeries: Snapshot.dividendSeries(ss),
      allocation:  Snapshot._allocation(ss),
      fromCache:   false
    };

    try {
      var json = JSON.stringify(payload);
      if (json.length <= CACHE_MAX_BYTES) {
        cache.put(CACHE_KEY, json, CACHE_TTL);
      } else {
        Logger.warning('Dashboard.getPayload', 'payload 超過快取上限，本次不快取', json.length + ' bytes');
      }
    } catch (e) {
      Logger.warning('Dashboard.getPayload', '快取寫入失敗', e.message);
    }

    return payload;
  };

  return db;
})();

/**
 * 供前端 google.script.run 呼叫的頂層進入點
 *
 * 頁面本身已由 doGet 擋過一次，這裡再擋一次是縱深防禦：
 * google.script.run 的呼叫不會重跑 doGet。
 *
 * @param {boolean} [noCache]
 * @returns {object} Dashboard payload
 */
function dashboardData(noCache) {
  if (!Dashboard.isAuthorized()) {
    throw new Error('未授權');
  }
  try {
    return Dashboard.getPayload(noCache === true);
  } catch (ex) {
    Logger.error('dashboardData', '取得儀表板資料失敗', ex);
    throw new Error('讀取資料失敗：' + ex.message);
  }
}
