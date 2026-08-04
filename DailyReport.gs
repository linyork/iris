/**
 * DailyReport
 * @description 排程產生的三份報告：每日早報、每週週報、每月月報
 *
 * 三份報告的骨架完全相同 —— 蒐資料 → 組 system context → 三段式 contents →
 * SMART 檔次跑一趟 → 推給所有主人。以前三支函式各寫了一遍這個骨架，
 * 於是「日期與年份規則」那段被抄了三份，動一次要改三個地方。
 *
 * 現在骨架只有一份（`_generateReport`），三份報告各自只描述**自己不一樣的地方**：
 * 期間怎麼稱呼、要餵哪些資料、要問什麼。加第四份報告只要再寫一個 spec。
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
    if (!result) return;

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
    if (!body) return;

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
    if (!body) return;

    var n = MessagingServiceFactory.pushToMasters(
      '【Iris 月報 ' + label + '】\n\n' + body);
    Logger.info('monthlyReport', '月報發送完成', { recipients: n });
  } catch (ex) {
    Logger.error('monthlyReport', '月報發送失敗', ex);
  }
}
