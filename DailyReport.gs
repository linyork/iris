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
