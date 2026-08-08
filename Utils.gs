/**
 * Utils
 * @description 通用工具函式庫
 */
var Utils = (() => {
  var utils = {};

  // ─── 執行時間預算 ────────────────────────────────────────────────
  //
  // GAS 每次執行的硬上限是 6 分鐘，超過會被直接砍掉 —— 而那是一個**攔不到**的終止：
  // catch 進不去、finally 不會跑、Logger 寫不出最後一行。從 consolelog 看起來就是
  // 「做到一半突然沒聲音」，2026-08-07 早報消失時留下的正是這個形狀。
  //
  // 時間戳在**檔案載入時**取得：GAS 每次執行都重新載入全部 .gs，所以它等同「本次執行
  // 的起點」，不必由每個進入點自己傳一個 startTime 下來 —— 真正需要看錶的地方
  // （NvidiaService 的重試迴圈）離進入點有三層遠，傳參數等於要求每一層都記得轉交。
  var EXEC_START = Date.now();

  utils.EXEC_LIMIT_MS  = 360000;
  utils.execElapsedMs  = () => Date.now() - EXEC_START;
  utils.execTimeLeftMs = () => utils.EXEC_LIMIT_MS - utils.execElapsedMs();

  // ─── 帳本寫入計數 ────────────────────────────────────────────────
  //
  // 「模型說已記錄，到底有沒有寫」的唯一證據。以前 `ChatBot.reply` 是看
  // **模型叫了哪些工具**（`Tools.isWrite` 名單）—— 但旗子掀在 `Tools.execute` 之前，
  // 所以工具被業務規則擋下（賣出股數不足）、參數不齊、或整支丟例外時，帳本一個字
  // 沒改，攔截器卻已經放行。那正好是這道防線最該作聲的場合。
  //
  // 所以證據改成取自**寫入本身**：真的動到試算表的地方各叫一次 `noteLedgerWrite`，
  // `ChatBot` 比對這次回覆前後的數字。字串怎麼寫、模型說了什麼，都不影響它。
  //
  // ⚠️ **不可以改成攔截所有試算表寫入。** `Logger` 每一則都往 consolelog 寫、
  //    `ChatBot` 每次回覆都往 chat 寫兩列 —— 全域計數會恆為真，等於把防線關掉，
  //    而且看起來像修好了。呼叫點必須是明確的那幾個動作邊界。
  //
  // ⚠️ 漏加一個呼叫點的後果是**誤報**（寫成功了卻被加警語），不是漏報。
  //    誤報看得見、會被抱怨；漏報看不見。這個方向是刻意選的。
  //
  // 計數器放模組層級即可：GAS 每次執行都重載全部 .gs，所以它每次執行自動歸零，
  // 與上面 EXEC_START 同一個道理。
  var _ledgerWrites = 0;

  utils.noteLedgerWrite = (tag) => {
    _ledgerWrites++;
    Logger.info('Utils.noteLedgerWrite', '帳本寫入 #' + _ledgerWrites, tag);
  };

  utils.ledgerWriteCount = () => _ledgerWrites;

  utils.isJsonString = (str) => {
    if (typeof str !== 'string') return false;
    try { JSON.parse(str); return true; } catch (e) { return false; }
  };

  utils.checkMaster = (userId) => {
    try {
      return Config.ADMIN_STRING.split(',').includes(userId);
    } catch (ex) {
      return false;
    }
  };

  utils.extractText = (response) => {
    try {
      if (!response || !response.candidates || !response.candidates[0]) return '';
      var content = response.candidates[0].content;
      if (!content || !content.parts) return '';
      var textPart = content.parts.find(p => p.text);
      return textPart ? textPart.text : '';
    } catch (e) { return ''; }
  };

  var TIMESTAMP_RE = /^\[\d{4}[\/\-]\d{2}[\/\-]\d{2}\s+\d{2}:\d{2}:\d{2}\]\s*/;
  utils.stripTimestampPrefix = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(TIMESTAMP_RE, '');
  };

  // 剝除 Markdown 標記 — Telegram 未設 parse_mode 時 ** 會顯示成字面星號
  utils.stripMarkdown = (str) => {
    if (typeof str !== 'string') return str;
    return str
      .replace(/\*\*([^*]+)\*\*/g, '$1')   // **粗體**
      .replace(/\*([^*\n]+)\*/g, '$1')     // *斜體*
      .replace(/__([^_\n]+)__/g, '$1')     // __底線粗體__
      .replace(/`([^`\n]+)`/g, '$1');      // `行內程式碼`
  };

  // ─── 「說已經做完了」的偵測 ──────────────────────────────────────
  //
  // 2026-08-07：主人要把某個帳戶校正成一個絕對值，模型先反問一句確認，主人答「是的」，
  // 模型接著回「好的，已校正。」—— 而那一輪 toolCallCount 是 0。帳本沒有任何改動，
  // 主人卻以為記好了，於是不會再記。編一句成功回覆比拒絕嚴重得多，正是這個形狀。
  //
  // 系統提示詞早就寫了「收到工具結果前不准說已完成」，但提示詞擋不住的東西要用結構擋：
  // 這句話是自由文字，沒有任何欄位擔保它為真，**唯一的證據是帳本有沒有真的被寫過**
  // （見上面的 noteLedgerWrite）。所以偵測放在這裡，判定與補救放在 `ChatBot.reply`。
  //
  // ⚠️ 先把「第 N 列」開頭的列丟掉再比對：`listTrades` 的輸出本來就會印出
  //    「…（已作廢）」，那是查詢結果的轉述，不是宣稱自己做了什麼。
  // ⚠️ 「完成」後面接查詢類的詞不算 —— 「已完成查詢」是講查完了，不是講寫進去了，
  //    而 ChatBot 自己的收尾字串就長這樣。
  var DONE_CLAIM_RE = new RegExp([
    '(已經?|都)\\s*(記錄|記下|登錄|登記|記上|寫入|建立|新增|開好|開立|校正|調整|更新|修改|作廢|刪除|存好|記好|設好|處理好)',
    '(已經?|都)\\s*完成(?!查詢|搜尋|查看|分析|計算|比對|整理)',
    '(幫|替|為)\\s*(你|您|主人)\\s*(記|寫|建|開|加|改|存|設|校正|調整|作廢)(?:[好上下]?來?)?了',
    '(記|寫|建|開|加|改|存|設定|處理|校正|調整|作廢)(好|完)了'
  ].join('|'));

  utils.claimsWriteDone = (str) => {
    if (typeof str !== 'string' || !str) return false;
    var body = str.split('\n').filter(l => !/第\s*\d+\s*列/.test(l)).join('\n');
    return DONE_CLAIM_RE.test(body);
  };

  // 清除模型誤輸出的 <tool_call>...</tool_call> XML 殘留
  utils.stripToolCallXml = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim();
  };

  // 強制在段落符號前插入換行，防止模型輸出密集連續文字
  utils.formatForLine = (str) => {
    if (typeof str !== 'string') return str;
    var result = str;
    // 在 ▸ ◆ 【 前確保有換行（若前一個字元不是換行則插入 \n\n）
    result = result.replace(/([^\n])(▸|◆|【)/g, '$1\n\n$2');
    // 在句號/問號/！後若直接接著文字（非換行），插入換行
    result = result.replace(/([。？！])([^\n」』）\s])/g, '$1\n$2');
    // 清理超過兩個連續空行
    result = result.replace(/\n{3,}/g, '\n\n');
    return result.trim();
  };

  // 將長訊息依換行點切成 ≤ limit 字元的陣列，供 pushMsg 分段發送
  utils.splitForLine = (str, limit) => {
    limit = limit || 4900;
    if (typeof str !== 'string' || str.length <= limit) return [str];
    var chunks = [];
    var remaining = str;
    while (remaining.length > limit) {
      var cut = remaining.lastIndexOf('\n', limit);
      if (cut <= 0) cut = limit;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).replace(/^\n/, '');
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  };

  return utils;
})();
