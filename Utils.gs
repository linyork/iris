/**
 * Utils
 * @description 通用工具函式庫
 */
var Utils = (() => {
  var utils = {};

  // ─── 執行時間預算 ────────────────────────────────────────────────
  // GAS 單次執行硬上限 6 分鐘，超過會被直接砍掉，而且攔不到：catch 進不去、
  // finally 不會跑、Logger 寫不出最後一行，log 看起來就是做到一半沒聲音。
  //
  // 時間戳在檔案載入時取得（GAS 每次執行都重載全部 .gs），等同本次執行的起點，
  // 不必由進入點層層傳 startTime 下來。
  var EXEC_START = Date.now();

  utils.EXEC_LIMIT_MS  = 360000;
  utils.execElapsedMs  = () => Date.now() - EXEC_START;
  utils.execTimeLeftMs = () => utils.EXEC_LIMIT_MS - utils.execElapsedMs();

  // ─── 帳本寫入計數 ────────────────────────────────────────────────
  // 「模型說已記錄，到底有沒有寫」的唯一證據：真的動到試算表的地方各叫一次
  // noteLedgerWrite，ChatBot 比對這次回覆前後的數字。
  //
  // ⚠️ 不可改用「模型叫了哪些寫入工具」判斷：那個旗子掀在 Tools.execute 之前，
  //    工具被業務規則擋下、參數不齊、丟例外時帳本沒動卻會放行。
  // ⚠️ 不可改成攔截所有試算表寫入：Logger 每則都寫 consolelog、ChatBot 每次回覆
  //    都寫兩列 chat，全域計數會恆為真，等於關掉防線又看起來像修好了。
  // ⚠️ 漏加呼叫點的後果是誤報（寫成功卻被加警語）而非漏報，這個方向是刻意選的。
  //
  // 計數器放模組層級即可：GAS 每次執行都重載 .gs，自動歸零。
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

  // ─── 主人允許清單 ────────────────────────────────────────────────
  //
  // ⚠️ 拆解 ADMIN_STRING 的地方只能有一個。以前這裡是裸的 `split(',')`，而
  //    `MessagingServiceFactory.pushToMasters` 有 `.map(trim)` —— 兩份抄本差一個
  //    字元，方向卻剛好相反：ADMIN_STRING 寫成 "a, b" 時，第二個人**收得到早報、
  //    講話卻沒人理**。推播那條路認得他，驗身分這條不認得。
  //
  //    而且它不會報錯。`doPost` 對非主人是靜默 continue（不回覆、不寫 chat、
  //    不花配額），consolelog 只留一行「忽略非主人事件」—— 那正是這條路正常
  //    運作時該有的樣子。症狀只剩下「bot 不理我」。
  //
  //    這就是 CLAUDE.md〈Shared seams〉在講的第五個縫：誰是主人，不該取決於是
  //    哪支程式在問。
  utils.masterList = () => String((typeof Config !== 'undefined' && Config.ADMIN_STRING) || '')
    .split(',').map(s => s.trim()).filter(s => s);

  utils.checkMaster = (userId) => {
    try {
      var id = String(userId === null || userId === undefined ? '' : userId).trim();
      if (!id) return false;
      return utils.masterList().indexOf(id) >= 0;
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
  //
  // ⚠️ 刻意不碰 `- ` 開頭的項目符號：一行 `- 500` 到底是項目還是負數，這裡分不出來，
  //    而項目符號在純文字裡本來就讀得通。標題與分隔線沒有這個歧義，所以剝掉。
  utils.stripMarkdown = (str) => {
    if (typeof str !== 'string') return str;
    return str
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')          // # 標題（只吃後面有空白的，不誤傷 #1）
      .replace(/^[ \t]*(?:\*{3,}|-{3,}|_{3,})[ \t]*$/gm, '')  // --- 分隔線
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

  // ─── 過期列清理 ──────────────────────────────────────────────────
  //
  // consolelog 與 chat 只由 appendRow 寫入，所以過期的列必定是**開頭連續的一整段**。
  // 舊版一列一次 deleteRow()，n 列就是 n 次 API round-trip —— 而 n 跟著日誌量成長，
  // 等於清理的成本被寫入量推著走。這裡把要刪的列併成連續區段整段刪：
  // 正常情況只有一段，就是一次呼叫。
  //
  // ⚠️ 由後往前刪。先刪小的列號，後面每一段的位置都會整片往上位移。
  // ⚠️ 日期讀不出來的列一律**保留**（沿用舊行為）。標題錯位、有人手動插了一列時，
  //    寧可留著讓人看見，也不要安靜地刪掉 —— 這支的工作是清過期，不是清不認得的東西。
  //
  // @param {Sheet}  sheet
  // @param {number} dateCol 1-based 的日期欄
  // @param {Date}   cutoff  早於這個時間的列要刪
  // @returns {number} 實際刪掉幾列
  utils.purgeRowsBefore = (sheet, dateCol, cutoff) => {
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return 0;

    var values = sheet.getRange(2, dateCol, lastRow - 1, 1).getValues();
    var ranges = [];   // 每項是 [起始列, 列數]
    values.forEach((r, i) => {
      var v = r[0];
      if (!v || !(new Date(v) < cutoff)) return;   // 讀不出日期 → Invalid Date → 比較為 false
      var row  = i + 2;
      var tail = ranges[ranges.length - 1];
      if (tail && tail[0] + tail[1] === row) tail[1]++;
      else ranges.push([row, 1]);
    });

    var removed = 0;
    for (var k = ranges.length - 1; k >= 0; k--) {
      sheet.deleteRows(ranges[k][0], ranges[k][1]);
      removed += ranges[k][1];
    }
    return removed;
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
