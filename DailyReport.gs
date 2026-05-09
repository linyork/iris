/**
 * DailyReport
 * @description 每日早上 9:00 自動產生個人化財經早報，透過 LINE push 給主人
 */

function dailyReport() {
  try {
    var nowStr  = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm');
    var dateStr = Utilities.formatDate(new Date(), 'GMT+8', 'MM/dd');

    Logger.info('dailyReport', '開始產生早報', nowStr);

    // 1. 蒐集資料
    var dashboard = GoogleSheet.getDashboard();
    var holdings  = GoogleSheet.getHoldings();
    var news      = WebSearch.search('台股 美股 全球股市 今日財經新聞');

    // 2. 讀取長期知識（個人偏好）
    var knowledge = GoogleSheet.searchKnowledge('投資策略 風險 配置');
    var stm       = GoogleSheet.getValidShortTermMemories();

    // 3. 組裝 prompt
    var systemContext = Config.SYSTEM_PROMPT +
      '\n\n[System Info]\nCurrent Time: ' + nowStr + '\nUser: 主人 (Master)';
    if (knowledge && !knowledge.includes('沒有找到')) {
      systemContext += '\n\n[相關長期知識]:\n' + knowledge;
    }
    if (stm) {
      systemContext += '\n\n[短期記憶]:\n' + stm;
    }

    var userPrompt =
      '請根據以下資料，產生今日（' + dateStr + '）的個人化財經早報。\n' +
      '格式須適合 LINE 純文字閱讀，不使用 Markdown，以換行和符號（▸ ◆ 【】）排版。\n' +
      '內容請包含：\n' +
      '1. 今日市場概況（台股、美股、相關指數）\n' +
      '2. 與我持倉直接相關的重點新聞或風險\n' +
      '3. 今日值得關注的機會或操作提示\n' +
      '4. 一句話總結今日建議\n\n' +
      '【我的投資組合】\n' + dashboard + '\n\n' +
      '【持倉明細】\n' + holdings + '\n\n' +
      '【今日財經新聞】\n' + news;

    var contents = [
      { role: 'user',  parts: [{ text: systemContext }] },
      { role: 'model', parts: [{ text: Prompt.ACKNOWLEDGEMENT }] },
      { role: 'user',  parts: [{ text: userPrompt }] }
    ];

    // 4. 呼叫 AI
    var response = AIServiceFactory.callAPI(contents, { model: 'SMART', caller: 'dailyReport' });
    var report   = Utils.extractText(response);

    if (!report) {
      Logger.error('dailyReport', '早報產生失敗', 'AI 回傳空值');
      return;
    }

    // 5. 發送給所有主人
    var header  = '【Iris 早報 ' + dateStr + '】\n\n';
    var masters = Config.ADMIN_STRING.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
    masters.forEach(function(userId) {
      Line.pushMsg(userId, header + report);
    });

    Logger.info('dailyReport', '早報發送完成', { recipients: masters.length });
  } catch (ex) {
    Logger.error('dailyReport', '早報發送失敗', ex);
  }
}

/**
 * 每週六 09:00 發送週報
 */
function weeklyReport() {
  try {
    var nowStr  = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm');
    var dateStr = Utilities.formatDate(new Date(), 'GMT+8', 'MM/dd');
    Logger.info('weeklyReport', '開始產生週報', nowStr);

    var history  = GoogleSheet.getHistory(7);
    var holdings = GoogleSheet.getHoldings();
    var dividend = GoogleSheet.getDividendHistory(new Date().getFullYear());
    var news     = WebSearch.search('台股 美股 本週財經重點');
    var knowledge = GoogleSheet.searchKnowledge('投資策略 配置');

    var systemContext = Config.SYSTEM_PROMPT + '\n\n[System Info]\nCurrent Time: ' + nowStr + '\nUser: 主人 (Master)';
    if (knowledge && !knowledge.includes('沒有找到')) systemContext += '\n\n[相關長期知識]:\n' + knowledge;

    var userPrompt =
      '請根據以下資料，產生本週（截至 ' + dateStr + '）的投資週報。\n' +
      '格式適合 LINE 純文字，不使用 Markdown，用全形符號排版。\n' +
      '內容請包含：\n' +
      '1. 本週總資產變化與績效\n' +
      '2. 各 ETF 本週表現（漲跌幅）\n' +
      '3. 本週重要財經事件\n' +
      '4. 下週需關注的重點\n' +
      '5. 一句話操作建議\n\n' +
      '【本週歷史走勢】\n' + history + '\n\n' +
      '【持倉現況】\n' + holdings + '\n\n' +
      '【今年股利統計】\n' + dividend + '\n\n' +
      '【本週財經新聞】\n' + news;

    var contents = [
      { role: 'user',  parts: [{ text: systemContext }] },
      { role: 'model', parts: [{ text: Prompt.ACKNOWLEDGEMENT }] },
      { role: 'user',  parts: [{ text: userPrompt }] }
    ];

    var response = AIServiceFactory.callAPI(contents, { model: 'SMART', caller: 'weeklyReport' });
    var report   = Utils.extractText(response);
    if (!report) { Logger.error('weeklyReport', '產生失敗'); return; }

    var masters = Config.ADMIN_STRING.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
    masters.forEach(function(userId) {
      Line.pushMsg(userId, '【Iris 週報 ' + dateStr + '】\n\n' + report);
    });

    Logger.info('weeklyReport', '週報發送完成', { recipients: masters.length });
  } catch (ex) {
    Logger.error('weeklyReport', '週報發送失敗', ex);
  }
}

/**
 * 每月 1 日 09:00 發送上月月報
 */
function monthlyReport() {
  try {
    var now     = new Date();
    var nowStr  = Utilities.formatDate(now, 'GMT+8', 'yyyy/MM/dd HH:mm');
    var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var yearStr = Utilities.formatDate(lastMonth, 'GMT+8', 'yyyy');
    var monthStr = Utilities.formatDate(lastMonth, 'GMT+8', 'MM');
    Logger.info('monthlyReport', '開始產生月報', nowStr);

    var history   = GoogleSheet.getHistory(35);
    var dashboard = GoogleSheet.getDashboard();
    var dividend  = GoogleSheet.getDividendHistory(parseInt(yearStr));
    var news      = WebSearch.search('上個月 台股 總體經濟 回顧');
    var knowledge = GoogleSheet.searchKnowledge('投資策略 目標 配置');

    var systemContext = Config.SYSTEM_PROMPT + '\n\n[System Info]\nCurrent Time: ' + nowStr + '\nUser: 主人 (Master)';
    if (knowledge && !knowledge.includes('沒有找到')) systemContext += '\n\n[相關長期知識]:\n' + knowledge;

    var userPrompt =
      '請根據以下資料，產生 ' + yearStr + ' 年 ' + monthStr + ' 月的投資月報。\n' +
      '格式適合 LINE 純文字，不使用 Markdown，用全形符號排版。\n' +
      '內容請包含：\n' +
      '1. 上月整體績效（資產增減、收益率變化）\n' +
      '2. 上月股利收入\n' +
      '3. 配置與目標的偏差\n' +
      '4. 上月重大事件回顧\n' +
      '5. 本月操作建議\n\n' +
      '【近 35 天走勢】\n' + history + '\n\n' +
      '【資產總覽】\n' + dashboard + '\n\n' +
      '【' + yearStr + ' 年股利統計】\n' + dividend + '\n\n' +
      '【上月財經新聞】\n' + news;

    var contents = [
      { role: 'user',  parts: [{ text: systemContext }] },
      { role: 'model', parts: [{ text: Prompt.ACKNOWLEDGEMENT }] },
      { role: 'user',  parts: [{ text: userPrompt }] }
    ];

    var response = AIServiceFactory.callAPI(contents, { model: 'SMART', caller: 'monthlyReport' });
    var report   = Utils.extractText(response);
    if (!report) { Logger.error('monthlyReport', '產生失敗'); return; }

    var masters = Config.ADMIN_STRING.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
    masters.forEach(function(userId) {
      Line.pushMsg(userId, '【Iris 月報 ' + yearStr + '/' + monthStr + '】\n\n' + report);
    });

    Logger.info('monthlyReport', '月報發送完成', { recipients: masters.length });
  } catch (ex) {
    Logger.error('monthlyReport', '月報發送失敗', ex);
  }
}
