/**
 * Commands
 * @description 斜線指令攔截層 —— 在進入 ChatBot 的 ReAct 迴圈之前處理固定指令
 *
 * 為什麼要攔截：Telegram 的指令選單只是 UI 提示，點下去送出的仍是一則普通文字訊息
 * （doPost 收到的就是 text: "/report"）。ChatBot 當然也能理解它，但要跑完整個
 * ReAct 迴圈才回得了答案。答案固定的指令直接在這裡處理掉，省下數十秒與一次 LLM 配額。
 *
 * 介面約定：tryHandle() 回傳 null 代表「這不是指令」，呼叫端應繼續交給 ChatBot；
 * 回傳字串代表已處理完畢，該字串就是要送出的回覆。
 */
var Commands = (() => {
  var commands = {};

  /**
   * 指令定義 —— 同時供 tryHandle 分派與 Telegram setMyCommands 註冊使用，
   * 兩邊共用一份，避免選單顯示的指令與實際支援的不同步。
   */
  var definitions = [
    {
      name: 'dashboard',
      description: '取得資產儀表板網址',
      handler: () => handleDashboard()
    },
    {
      name: 'report',
      description: '立即產生今日財經早報（需 1~2 分鐘）',
      handler: (event) => handleReport(event)
    }
  ];

  // ─── 各指令實作 ────────────────────────────────────────────

  var handleDashboard = () => {
    var url = Config.DASHBOARD_URL;
    if (!url) {
      Logger.warning('Commands.handleDashboard', 'DASHBOARD_URL 未設定');
      return '尚未設定儀表板網址。\n\n' +
             '請到 GAS 專案設定 → 指令碼屬性，新增 DASHBOARD_URL，' +
             '值填 HEAD 部署的 /dev 網址。';
    }
    return '【資產儀表板】\n' + url + '\n\n' +
           '（需以 Google 帳號登入，僅你本人開得起來）';
  };

  var handleReport = (event) => {
    // 早報走 SMART 檔次（開思考）且含一次 WebSearch，耗時以分鐘計，
    // 遠超過 typing 狀態的 5 秒。先送一則實體訊息出去，使用者才不會
    // 對著沒有動靜的畫面猜是不是當機了——與 ChatBot 逾時收尾的處理同理。
    MessagingServiceFactory.reply(event, '早報產生中，大約需要 1~2 分鐘，請稍候…');

    var result = buildDailyReport();
    if (!result) {
      return '早報產生失敗，請查看 consolelog 或稍後再試。';
    }
    return '【Iris 早報 ' + result.dateStr + '】\n\n' + result.body;
  };

  // ─── 對外介面 ──────────────────────────────────────────────

  /**
   * 嘗試以指令處理這則訊息
   * @param {object} event - 已正規化的中立事件物件
   * @returns {string|null} 回覆文字；null 表示不是指令，應交給 ChatBot
   */
  commands.tryHandle = (event) => {
    var text = (event.message && event.message.text || '').trim();
    if (text.charAt(0) !== '/') return null;

    // 群組中 Telegram 會送出 "/report@YourBotName"，需去掉 @ 之後的部分；
    // 參數（如未來的 /price 2330）先切開，目前的指令都不吃參數。
    var head = text.split(/\s+/)[0].slice(1).split('@')[0].toLowerCase();

    var def = definitions.find(d => d.name === head);
    if (!def) return null;

    Logger.info('Commands.tryHandle', '執行指令', { command: head });
    try {
      return def.handler(event);
    } catch (ex) {
      Logger.error('Commands.tryHandle', '指令執行失敗: ' + head, ex);
      return '指令執行時發生錯誤：' + ex.message;
    }
  };

  /**
   * 供 Telegram setMyCommands 註冊用的清單
   * @returns {Array<{command: string, description: string}>}
   */
  commands.getDefinitions = () =>
    definitions.map(d => ({ command: d.name, description: d.description }));

  return commands;
})();
