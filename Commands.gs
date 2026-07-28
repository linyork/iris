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
      description: '開啟資產儀表板',
      handler: (event) => handleDashboard(event)
    },
    {
      name: 'report',
      description: '立即產生今日財經早報（需 1~2 分鐘）',
      handler: (event) => handleReport(event)
    }
  ];

  // ─── 各指令實作 ────────────────────────────────────────────

  /**
   * Mini App 網址 = webhook 的 /exec 加上 ?view=tg
   *
   * 這個能自動推導，不像 DASHBOARD_URL 得放 Script Property：Mini App 就掛在
   * webhook 自己那支部署上，而 getService().getUrl() 從 doPost 執行時回傳的正是它。
   * （從編輯器執行時會拿到 /dev，所以下面驗一下才用。）
   */
  var miniAppUrl = () => {
    try {
      var base = ScriptApp.getService().getUrl();
      if (!base || base.indexOf('/exec') < 0) {
        Logger.warning('Commands.miniAppUrl', '取得的網址不是 /exec，略過 Mini App 按鈕', base);
        return '';
      }
      return base + '?view=tg';
    } catch (ex) {
      Logger.warning('Commands.miniAppUrl', '無法取得部署網址', ex.message);
      return '';
    }
  };

  var handleDashboard = (event) => {
    var webUrl  = Config.DASHBOARD_URL;
    var miniUrl = (event.platform === 'TELEGRAM') ? miniAppUrl() : '';

    // Telegram 且拿得到網址時，改送一則帶 Mini App 按鈕的訊息：點按鈕就地滑出面板，
    // 不必離開 App、不必 Google 登入。訊息由這裡自己送出，所以回傳空字串
    // 告訴 doPost「已處理完畢、不用再 push」（回 null 才是「不是指令」）。
    if (miniUrl) {
      var body = '【資產儀表板】\n點下方按鈕就地開啟。';
      if (webUrl) body += '\n\n完整版（瀏覽器，需 Google 登入）：\n' + webUrl;
      Telegram.pushWithMiniAppButton(event.replyToken, body, '📊 開啟儀表板', miniUrl);
      return '';
    }

    if (!webUrl) {
      Logger.warning('Commands.handleDashboard', 'DASHBOARD_URL 未設定');
      return '尚未設定儀表板網址。\n\n' +
             '請到 GAS 專案設定 → 指令碼屬性，新增 DASHBOARD_URL，' +
             '值填 HEAD 部署的 /dev 網址。';
    }
    return '【資產儀表板】\n' + webUrl + '\n\n' +
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
