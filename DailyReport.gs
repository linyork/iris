/**
 * DailyReport
 * @description 排程產生的三份報告：每日早報、每週週報、每月月報
 *
 * 骨架只有一份（_generateReport）：蒐資料 → 組 system context → 三段式 contents →
 * SMART 檔次跑一趟 → 推給所有主人。三份報告各自只描述自己不同的地方
 * （期間名稱、餵哪些資料、問什麼）。加第四份報告只要再寫一個 spec。
 *
 * ⚠️ `dailyReport` / `weeklyReport` / `monthlyReport` 是 Trigger 以**名稱**綁定的
 *    進入點（見 `Cron.SCHEDULE`），`buildDailyReport` 則被 `Commands.gs` 的
 *    `/report` 呼叫。這四個名字都不能改。
 */

/** 三份報告共用的排版要求 */
var REPORT_FORMAT =
  '格式須適合純文字閱讀，不使用 Markdown，以換行和全形符號（▸ ◆ 【】）排版。\n';

/**
 * 報告產生的共用骨架。
 *
 * @param {object} spec
 * @param {string} spec.scope    '早報' / '週報' / '月報'，會進日期規則那段
 * @param {string} [spec.period] 報告期間說明，接在 System Info 的 Today 後面
 * @param {string} spec.caller   記進 consolelog 的呼叫者名稱
 * @param {function(): object} spec.gather  蒐集資料，回傳 {標題: 內容} 的物件
 * @param {string} spec.ask      要模型做什麼（資料由 gather 附在後面）
 * @param {string} [spec.knowledgeQuery] 要搜什麼長期知識，預設 '投資策略 配置'
 * @returns {string|null} 報告內文；產生失敗回 null
 */
function _generateReport(spec) {
  try {
    Logger.info(spec.caller, '開始產生' + spec.scope,
      Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm'));

    // 排程的先後順序不保證（atHour 是一小時的窗口），所以自己先重算一次 ——
    // 指標與配置是重算當下寫死的值，不重算就會拿上一次寫交易時的舊數字當今天。
    Position.rebuild();

    var data = spec.gather();

    var systemContext = Prompt.systemContext({
      scope:     spec.scope,
      period:    spec.period,
      knowledge: GoogleSheet.searchKnowledge(spec.knowledgeQuery || '投資策略 配置')
    });

    var userPrompt = spec.ask + '\n\n' +
      Object.keys(data).map(k => '【' + k + '】\n' + data[k]).join('\n\n');

    var contents = [
      { role: 'user',  parts: [{ text: systemContext }] },
      { role: 'model', parts: [{ text: Prompt.ACKNOWLEDGEMENT }] },
      { role: 'user',  parts: [{ text: userPrompt }] }
    ];

    var report = Utils.extractText(
      AIServiceFactory.callAPI(contents, { model: 'SMART', caller: spec.caller })
    );

    if (!report) {
      Logger.error(spec.caller, spec.scope + '產生失敗', 'AI 回傳空值');
      return null;
    }
    return report;
  } catch (ex) {
    Logger.error(spec.caller, spec.scope + '產生失敗', ex);
    return null;
  }
}

// ─── 早報 ─────────────────────────────────────────────────────────

// ─── 失敗處理：排一次重試，並且說一聲 ─────────────────────────────

/** 一次性重試等待的分鐘數 —— NIM 的過載尖峰通常是分鐘級，退得掉 */
var REPORT_RETRY_MIN = 15;

/**
 * 「本次執行是不是重試」。
 *
 * ⚠️ 這件事不能用參數傳：GAS 呼叫 trigger handler 時會塞一個 event 物件當第一個
 *    引數，於是 `function dailyReport(isRetry)` 收到的永遠是 truthy 值，排程跑的
 *    那班會把自己誤認成重試、從此不再排重試 —— 而且完全不報錯。
 *
 * 用全域旗標是安全的：GAS 每次執行都重新載入全部 .gs，所以它在每一次新執行的
 * 起點都是 false，只有重試進入點會把它掀起來。
 */
var _isReportRetry = false;

/**
 * 排一個一次性重試 trigger。
 *
 * 為什麼是「開第二次執行」而不是「在這次多等一下」：GAS 單次執行封頂 6 分鐘，
 * 而失敗的原因正是一次呼叫就吃掉 300s（見 NvidiaService 的時間預算）。同一次
 * 執行裡再也擠不出時間，要買到更多 wall clock 只有另開一次執行這條路。
 *
 * ⚠️ 只重試一次。重試進入點會先掀起 `_isReportRetry`，那條路徑不會再排下一個 ——
 *    否則過載持續整個上午時，這裡會每 15 分鐘生一個 trigger，而 GAS 每個使用者
 *    每個腳本只有 20 個 trigger 的額度，塞爆之後連正規排程都建不起來。
 *
 * @returns {boolean} 有沒有真的排成功
 */
function _scheduleReportRetry(handlerName) {
  try {
    _deleteTriggersFor(handlerName); // 清掉可能殘留的上一輪，額度不該累積
    ScriptApp.newTrigger(handlerName).timeBased()
      .after(REPORT_RETRY_MIN * 60 * 1000).create();
    Logger.info('_scheduleReportRetry', '已排一次性重試',
      { handler: handlerName, afterMin: REPORT_RETRY_MIN });
    return true;
  } catch (ex) {
    Logger.error('_scheduleReportRetry', '排重試失敗', ex);
    return false;
  }
}

/**
 * 刪掉指向某個 handler 的所有 trigger。
 * 一次性 trigger 跑完不會自己消失，不清就會一路佔著 20 個的額度。
 */
function _deleteTriggersFor(handlerName) {
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === handlerName) ScriptApp.deleteTrigger(t);
    });
  } catch (ex) {
    Logger.error('_deleteTriggersFor', '清除 trigger 失敗', ex);
  }
}

/**
 * 排程報告失敗的統一出口：先排重試（如果還能排），再告訴主人現在是什麼狀況。
 *
 * 排程沒有人在等回覆，所以失敗的外觀就只是「今天沒有收到」—— 而那和「今天本來就
 * 不該有」（週末、假日）長得一模一樣。2026-08-07 早報被 GAS 砍掉那次，就是這樣過了
 * 一個上午才被發現。/report 走的是 Commands，失敗會直接回給發問的人；排程這條路
 * 以前沒有對應的出口。
 *
 * 通知分兩種寫法，因為「再等 15 分鐘」和「今天就這樣了」是兩件不同的事 ——
 * 寫成同一句話等於要人自己去猜還要不要等。
 *
 * ⚠️ 這已經是最後一段，push 自己失敗也不能再往上丟 —— 拋出去只會讓 trigger 記一筆
 *    紅字，對已經收不到訊息的人沒有任何幫助。
 *
 * @param {string} scope        報告名稱，如 '早報'
 * @param {string} retryHandler 重試進入點的函式名（見 Cron.ONESHOT）
 * @param {string} [hint]       不再重試時的補救建議
 */
function _handleReportFailure(scope, retryHandler, hint) {
  var scheduled = !_isReportRetry && _scheduleReportRetry(retryHandler);

  var msg = scheduled
    ? '⚠ ' + scope + '產生失敗（多半是 AI 服務過載）。\n' +
      '已排定 ' + REPORT_RETRY_MIN + ' 分鐘後自動重試一次。'
    : '⚠ ' + scope + '產生失敗，不再自動重試。\n' + (hint ? hint + '\n' : '');

  try {
    MessagingServiceFactory.pushToMasters(msg + '\n詳情見 consolelog。');
  } catch (ex) {
    Logger.error('_handleReportFailure', scope + '的失敗通知也送不出去', ex);
  }
}

/**
 * 產生今日早報內文（不發送）
 *
 * 與 dailyReport() 分開，讓排程推播與 /report 指令共用同一段邏輯：
 * 排程要「週末跳過 + 推給所有主人」，/report 要「隨時可跑 + 只回給發問的人」，
 * 差異全部留在呼叫端，這裡只負責產生內容。
 *
 * ⚠️ 走 SMART 檔次（開思考）且含一次 WebSearch，耗時以分鐘計。
 *    從 doPost 同步呼叫時務必先送出提示訊息，見 Commands.gs。
 *
 * @returns {{dateStr: string, body: string}|null} 產生失敗回 null
 */
function buildDailyReport() {
  var dateStr = Utilities.formatDate(new Date(), 'GMT+8', 'MM/dd');

  var body = _generateReport({
    scope:  '早報',
    caller: 'dailyReport',
    knowledgeQuery: '投資策略 風險 配置',
    gather: () => ({
      '我的投資組合': GoogleSheet.getDashboard(),
      '持倉明細':     GoogleSheet.getHoldings(),
      '今日財經新聞': WebSearch.search('台股 美股 全球股市 今日財經新聞')
    }),
    ask:
      '請根據以下資料，產生今日的個人化財經早報。\n' + REPORT_FORMAT +
      '內容請包含：\n' +
      '1. 今日市場概況（台股、美股、相關指數）\n' +
      '2. 與我持倉直接相關的重點新聞或風險\n' +
      '3. 今日值得關注的機會或操作提示\n' +
      '4. 一句話總結今日建議'
  });

  return body ? { dateStr: dateStr, body: body } : null;
}

/** 每日 09:00 排程：產生早報並推播給所有主人 */
function dailyReport() {
  try {
    var dow = new Date().getDay();
    if (dow === 0 || dow === 6) return; // 週六發週報、週日無報

    var result = buildDailyReport();
    if (!result) { _handleReportFailure('早報', 'dailyReportRetry', '可用 /report 手動重試。'); return; }

    var n = MessagingServiceFactory.pushToMasters(
      '【Iris 早報 ' + result.dateStr + '】\n\n' + result.body);
    Logger.info('dailyReport', '早報發送完成', { recipients: n });
  } catch (ex) {
    Logger.error('dailyReport', '早報發送失敗', ex);
  }
}

// ─── 週報 ─────────────────────────────────────────────────────────

/** 每週六 09:00 發送週報 */
function weeklyReport() {
  try {
    var now     = new Date();
    var dateStr = Utilities.formatDate(now, 'GMT+8', 'MM/dd');

    var body = _generateReport({
      scope:  '週報',
      period: '本週（截至 ' + Utilities.formatDate(now, 'GMT+8', 'yyyy-MM-dd') + '）',
      caller: 'weeklyReport',
      gather: () => ({
        '本週歷史走勢': GoogleSheet.getHistory(7),
        '持倉現況':     GoogleSheet.getHoldings(),
        '今年股利統計': GoogleSheet.getDividendHistory(new Date().getFullYear()),
        '本週財經新聞': WebSearch.search('台股 美股 本週財經重點')
      }),
      ask:
        '請根據以下資料，產生本週的投資週報。\n' + REPORT_FORMAT +
        '內容請包含：\n' +
        '1. 本週總資產變化與績效\n' +
        '2. 各 ETF 本週表現（漲跌幅）\n' +
        '3. 本週重要財經事件\n' +
        '4. 下週需關注的重點\n' +
        '5. 一句話操作建議'
    });
    if (!body) { _handleReportFailure('週報', 'weeklyReportRetry'); return; }

    var n = MessagingServiceFactory.pushToMasters(
      '【Iris 週報 ' + dateStr + '】\n\n' + body);
    Logger.info('weeklyReport', '週報發送完成', { recipients: n });
  } catch (ex) {
    Logger.error('weeklyReport', '週報發送失敗', ex);
  }
}

// ─── 月報 ─────────────────────────────────────────────────────────

/** 每月 1 日 10:00 發送上月月報 */
function monthlyReport() {
  try {
    var now       = new Date();
    var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var yearStr   = Utilities.formatDate(lastMonth, 'GMT+8', 'yyyy');
    var monthStr  = Utilities.formatDate(lastMonth, 'GMT+8', 'MM');
    var label     = yearStr + '/' + monthStr;

    var body = _generateReport({
      scope:  '月報',
      period: label + '（上月）—— 所有事件回顧須屬於該月',
      caller: 'monthlyReport',
      knowledgeQuery: '投資策略 目標 配置',
      gather: () => ({
        '近 35 天走勢': GoogleSheet.getHistory(35),
        '資產總覽':     GoogleSheet.getDashboard(),
        [yearStr + ' 年股利統計']: GoogleSheet.getDividendHistory(parseInt(yearStr, 10)),
        '上月財經新聞': WebSearch.search('上個月 台股 總體經濟 回顧')
      }),
      ask:
        '請根據以下資料，產生 ' + yearStr + ' 年 ' + monthStr + ' 月的投資月報。\n' +
        REPORT_FORMAT +
        '內容請包含：\n' +
        '1. 上月整體績效（資產增減、收益率變化）\n' +
        '2. 上月股利收入\n' +
        '3. 配置與目標的偏差\n' +
        '4. 上月重大事件回顧\n' +
        '5. 本月操作建議'
    });
    if (!body) { _handleReportFailure('月報', 'monthlyReportRetry'); return; }

    var n = MessagingServiceFactory.pushToMasters(
      '【Iris 月報 ' + label + '】\n\n' + body);
    Logger.info('monthlyReport', '月報發送完成', { recipients: n });
  } catch (ex) {
    Logger.error('monthlyReport', '月報發送失敗', ex);
  }
}

// ─── 一次性重試進入點 ─────────────────────────────────────────────
//
// 這三支不在 `Cron.SCHEDULE` 裡 —— 它們沒有固定時間，是報告失敗當下才被
// `_scheduleReportRetry()` 排出來的。但名字一樣是 GAS 以**字串**綁定的，
// 改名同樣會靜默失效，所以登記在 `Cron.ONESHOT`，讓 `Cron.list()` 認得。
//
// 每一支都做同樣三件事，順序不能換：
//   1. 先刪掉自己的 trigger —— 一次性 trigger 跑完不會自己消失，而且必須在
//      真正開工**之前**刪。萬一這次執行又被 GAS 砍掉（正是我們在防的事），
//      刪除動作放在後面就永遠跑不到，那個 trigger 會一直佔著額度。
//   2. 掀起重試旗標，讓失敗處理知道不要再排下一個。
//   3. 呼叫原本那支排程函式，走完全相同的路徑。

/** 早報的一次性重試 */
function dailyReportRetry() {
  _deleteTriggersFor('dailyReportRetry');
  _isReportRetry = true;
  Logger.info('dailyReportRetry', '早報自動重試開始');
  dailyReport();
}

/** 週報的一次性重試 */
function weeklyReportRetry() {
  _deleteTriggersFor('weeklyReportRetry');
  _isReportRetry = true;
  Logger.info('weeklyReportRetry', '週報自動重試開始');
  weeklyReport();
}

/** 月報的一次性重試 */
function monthlyReportRetry() {
  _deleteTriggersFor('monthlyReportRetry');
  _isReportRetry = true;
  Logger.info('monthlyReportRetry', '月報自動重試開始');
  monthlyReport();
}
