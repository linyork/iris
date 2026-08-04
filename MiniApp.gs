/**
 * MiniApp
 * @description Telegram Mini App 的驗證層與後端進入點
 *
 * 為什麼需要獨立的驗證：Mini App 的頁面掛在 /exec（ANYONE_ANONYMOUS）底下，
 * 任何人都打得到，而 Google 登入那套（Dashboard.isAuthorized）在 Telegram 的
 * 內嵌 webview 裡走不通。改用 Telegram 自己的機制 —— 開啟 Mini App 時它會帶一份
 * 用 bot token 簽章的 initData，驗簽通過就能確定「這確實由 Telegram 發出，且開啟者是誰」。
 *
 * ⚠️ doGet 回的頁面本身不含任何資料，資料一律要先過 verifyInitData 才發。
 */
var MiniApp = (() => {
  var mini = {};

  // initData 逾時：超過這個秒數就拒絕，避免有人把舊的 initData 存下來重放
  var MAX_AGE_SECONDS = 86400; // 24 小時

  /**
   * 解析 initData 查詢字串
   * GAS 沒有 URLSearchParams，手動拆。值必須是解碼後的原文，
   * 因為 Telegram 的 data_check_string 是用解碼後的值組出來的。
   */
  var parseInitData = (initData) => {
    var out = {};
    String(initData || '').split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      if (i < 0) return;
      out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
    });
    return out;
  };

  var toHex = (bytes) => bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');

  /**
   * 驗證 Telegram initData 簽章
   *
   * 演算法（Telegram 官方）：
   *   data_check_string = 除 hash 外所有欄位，依 key 字母排序，以 "key=value" 用 \n 串接
   *   secret_key        = HMAC_SHA256(訊息 = bot_token, 金鑰 = "WebAppData")
   *   expected_hash     = hex(HMAC_SHA256(訊息 = data_check_string, 金鑰 = secret_key))
   *
   * @param {string} initData - window.Telegram.WebApp.initData 原字串
   * @returns {{ok: boolean, userId: string, chatId: string, error: string}}
   */
  mini.verifyInitData = (initData) => {
    var fail = (msg) => {
      Logger.warning('MiniApp.verifyInitData', '驗證失敗', msg);
      return { ok: false, userId: '', chatId: '', error: msg };
    };

    try {
      var token = Config.TELEGRAM_API_KEY;
      if (!token) return fail('TELEGRAM_API_KEY 未設定');

      var data = parseInitData(initData);
      var hash = data.hash;
      if (!hash) {
        // 這個分支幾乎都是前端把 hash 片段拆錯造成的，把實際收到的欄位名記下來才查得動
        Logger.warning('MiniApp.verifyInitData', '收到的 initData 沒有 hash 欄位', {
          keys:   Object.keys(data).join(','),
          length: String(initData || '').length,
          head:   String(initData || '').slice(0, 120)
        });
        return fail('缺少 hash');
      }

      var checkString = Object.keys(data)
        .filter(k => k !== 'hash')
        .sort()
        .map(k => k + '=' + data[k])
        .join('\n');

      var secretKey = Utilities.computeHmacSha256Signature(token, 'WebAppData');
      var expected  = toHex(Utilities.computeHmacSha256Signature(
        Utilities.newBlob(checkString).getBytes(), secretKey
      ));

      if (expected !== hash) return fail('簽章不符');

      // 重放保護：initData 本身不會過期，只能靠 auth_date 自己把關
      var authDate = parseInt(data.auth_date, 10);
      if (!authDate) return fail('缺少 auth_date');
      var age = Math.floor(Date.now() / 1000) - authDate;
      if (age > MAX_AGE_SECONDS) return fail('initData 已逾時（' + age + ' 秒）');

      var user = JSON.parse(data.user || '{}');
      if (!user.id) return fail('缺少 user.id');

      // 驗簽只證明「是 Telegram 發的、開啟者是誰」，不代表這個人有權限。
      // 權限仍走既有的 ADMIN_STRING 允許清單。
      var userId = 'TELEGRAM:' + user.id;
      if (!Utils.checkMaster(userId)) return fail('非主人：' + userId);

      return {
        ok:     true,
        userId: userId,
        chatId: String(user.id),
        error:  ''
      };
    } catch (ex) {
      Logger.error('MiniApp.verifyInitData', '驗證時發生例外', ex);
      return { ok: false, userId: '', chatId: '', error: ex.message };
    }
  };

  return mini;
})();

/**
 * Mini App 取資料（前端 google.script.run 呼叫）
 * @param {string} initData
 * @param {boolean} [noCache] 下拉重整時帶 true，強制略過快取重讀
 * @returns {object} Dashboard payload
 */
function miniAppData(initData, noCache) {
  var auth = MiniApp.verifyInitData(initData);
  if (!auth.ok) throw new Error('驗證失敗：' + auth.error);
  return Dashboard.getPayload(!!noCache);
}

/**
 * Mini App 送問題給 Iris（前端 google.script.run 呼叫）
 *
 * 組一個與 doPost 相同形狀的中立事件交給 ChatBot，等於使用者在對話裡打了這句話，
 * 因此工具、記憶、對話歷史全部沿用同一條路徑，不需要另一套邏輯。
 *
 * 前端送出後會關閉面板不等回呼，答案由 push 送進對話。
 *
 * @param {string} initData
 * @param {string} question
 * @returns {string} 狀態字串（前端通常不會等到）
 */
function miniAppAsk(initData, question) {
  var auth = MiniApp.verifyInitData(initData);
  if (!auth.ok) throw new Error('驗證失敗：' + auth.error);

  var text = String(question || '').trim();
  if (!text) return '空問題，已忽略';

  var event = {
    platform:   'TELEGRAM',
    replyToken: auth.chatId,
    sourceId:   auth.chatId,
    source:     { type: 'user', userId: auth.userId },
    message:    { type: 'text', text: text, id: 'miniapp' },
    isMaster:   true
  };

  Logger.info('miniAppAsk', '來自 Mini App 的提問', { userId: auth.userId, text: text });

  // 先把問題本身回顯到對話裡。使用者是在面板上點的，對話裡不會有這句話，
  // 少了它 Iris 的回答會像沒頭沒尾地自己冒出來。
  MessagingServiceFactory.push(auth.userId, '❓ ' + text);

  var reply = ChatBot.reply(event);
  if (reply) MessagingServiceFactory.push(auth.userId, reply);

  return 'ok';
}
