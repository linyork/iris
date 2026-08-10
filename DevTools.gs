/**
 * DevTools
 * @description 所有「在 GAS 編輯器下拉選單手動執行」的進入點，一律集中在這裡
 *
 * 集中的原因：編輯器的函式下拉選單是扁平的，不顯示函式定義在哪個檔案。
 *
 * ⚠️ 兩類頂層函式不可搬進來，它們以名稱綁定，改名或搬走會靜默失效：
 *   Trigger 進入點   setData / dailyReport / weeklyReport / monthlyReport /
 *                    marketAlert / dailyCleanUp / advisorCheckEvening
 *   Web 進入點       doPost / doGet / dashboardData / miniAppData / miniAppAsk
 *
 * 這裡每支函式只做「呼叫模組 + 印結果」，邏輯留在各自的模組。
 */

// ─── 系統 ─────────────────────────────────────────────────────────

/** 列出實際註冊的 Trigger 並與 Cron.SCHEDULE 比對 */
function listTriggers() {
  var report = Cron.list();
  console.log(report);
  return report;
}

/**
 * 初始化系統（首次部署時執行）
 * - 確認試算表各工作表已建立
 * - 列印環境變數狀態
 */
function setup() {
  // advice_log 不在這裡：AdviceLog 找不到就自己建（見那裡的註解），
  // 列進來只會在第一次記建議之前一直顯示「缺少工作表」的假警報。
  var requiredSheets = ['env', 'consolelog', 'chat', 'short_term_memory', 'knowledge', 'alert_log'];
  var ss = SpreadsheetApp.openById(Config.SHEET_ID);

  requiredSheets.forEach(name => {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      console.log('⚠️  缺少工作表: ' + name + '，請手動建立。');
    } else {
      console.log('✅  工作表存在: ' + name);
    }
  });

  console.log('--- 環境變數 ---');
  console.log('LINE_CHANNEL_TOKEN:  ' + (Config.LINE_CHANNEL_TOKEN  ? '已設定' : '（選用）'));
  console.log('TELEGRAM_API_KEY:    ' + (Config.TELEGRAM_API_KEY    ? '已設定' : '（選用）'));
  console.log('SHEET_ID:            ' + (Config.SHEET_ID            ? '已設定' : '❌ 未設定'));
  console.log('ADMIN_STRING:        ' + (Config.ADMIN_STRING        ? '已設定' : '❌ 未設定'));
  console.log('GEMINI_API_KEY:      ' + (Config.GEMINI_API_KEY      ? '已設定' : '（選用）'));
  console.log('NVIDIA_API_KEY:      ' + (Config.NVIDIA_API_KEY      ? '已設定' : '（選用）'));
  console.log('AI_PROVIDER:         ' + Config.AI_PROVIDER + '  ← env!B3 控制（GEMINI 或 NVIDIA）');
  console.log('DEBUG_MODE:          ' + Config.DEBUG_MODE + '  ← env!B2 控制');
}

/** 依 Cron.SCHEDULE 重建所有 Trigger。⚠️ 會先清掉所有既有的，含手動建的 */
function setupAllTriggers() {
  var r = Cron.setup();
  console.log(JSON.stringify(r));
  console.log(Cron.list());
  return r;
}

/**
 * 註冊 Telegram webhook。
 * ⚠️ 網址寫死成固定部署的 /exec，不用 ScriptApp.getService().getUrl() ——
 * 後者從編輯器執行時會回傳 /dev，那個需要 Google 登入，Telegram 打不進來。
 */
function setupTelegramWebhook() {
  var WEB_APP_URL = 'https://script.google.com/macros/s/' +
    'AKfycbxN-6Yx2GEiLvyBIeZ9z0CyZPbUuBXMyoD6xtN3j_XOc38_S2OBrOonVPaxXM4NVRcI' + '/exec';
  console.log('註冊 webhook → ' + WEB_APP_URL);
  console.log(Telegram.setupWebhook(WEB_APP_URL));
}

/** 註冊 Telegram 斜線指令選單。**新增或改名指令後一定要跑這支一次。** */
function setupTelegramCommands() {
  console.log('註冊指令選單：' + JSON.stringify(Commands.getDefinitions()));
  console.log(Telegram.setupCommands());
}

// ─── 每日快照 ─────────────────────────────────────────────────────

/** 只檢查不寫入：今天的快照會寫幾列、狀態是什麼 */
function verifySnapshot() {
  var report = DataSync.verify();
  console.log(report);
  return report;
}

/** 預覽今天 setData 會寫的那一列，不寫入。 */
function dryRunSetData() {
  var result = DataSync.run({ dryRun: true });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ─── 資產管理表 ───────────────────────────────────────────────────
//
// 舊表 → 新表的遷移已經做完，SHEET_ID 也已經指向新表，所以那幾支
// 遷移／對帳的進入點都拿掉了 —— 留在下拉選單裡只會被誤觸，而誤觸的代價是
// 拿凍結的舊表重寫現行的期初列。遷移程式本身還在 `AssetMigrate.gs`，
// 現在的用途是測試的 fixture，要跑請從編輯器直接呼叫。

/** 在「資產管理」試算表建立／補齊所有分頁與公式。冪等，重跑不會疊加。 */
function setupAssetSheet() {
  var r = AssetSchema.build();
  console.log(JSON.stringify(r, null, 2));
  return r;
}

/** 從「交易」重算持倉、已實現損益、現金、配置、面板 */
function rebuildPositions() {
  var r = Position.rebuild();
  console.log(JSON.stringify(r, null, 2));
  return r;
}

// ─── 儀表板 / 顧問 ────────────────────────────────────────────────

/**
 * 看 doGet 的權限閘門實際拿到什麼身分。
 * 儀表板顯示 Not Found 時先跑這支：activeUser 是空字串代表 Google 沒把
 * 使用者身分交給這次執行 —— 通常是開了 /exec（匿名部署）而不是 /dev，
 * 或是新增 scope 之後還沒重新授權。
 */
function checkDashboardAuth() {
  var active    = '';
  var effective = '';
  try { active    = Session.getActiveUser().getEmail(); }    catch (e) { active    = '（拋錯：' + e.message + '）'; }
  try { effective = Session.getEffectiveUser().getEmail(); } catch (e) { effective = '（拋錯：' + e.message + '）'; }

  console.log('activeUser（存取者）  : ' + (active    || '（空字串）'));
  console.log('effectiveUser（執行者）: ' + (effective || '（空字串）'));
  console.log('isAuthorized          : ' + Dashboard.isAuthorized());
}

/**
 * AdvisorCheck 的手動測試入口：忽略週末跳過與短路檢查，跑完整流程但**不推播**。
 * 要真的推播請執行 advisorCheckEvening()。
 */
function testAdvisorCheck() {
  try {
    Logger.info('testAdvisorCheck', '─── 手動測試開始 ───');

    var snapshot = Snapshot.collectAll();
    console.log('【Snapshot】');
    console.log(JSON.stringify(snapshot, null, 2));

    var quiet = Snapshot.isQuiet(snapshot);
    console.log('\n【短路檢查】isQuiet = ' + quiet);

    var decisions = AdvisorCheck._loadDecisions();
    console.log('\n【決策清單】共 ' + decisions.length + ' 條');
    decisions.forEach((d, i) => console.log((i + 1) + '. [' + d.tags + '] ' + d.content));

    var recentAlerts = AlertLog.formatForPrompt(7);
    console.log('\n【最近通知】\n' + recentAlerts);

    var llmResult = AdvisorCheck._askLLM(snapshot, decisions, recentAlerts, 'manual-test');
    console.log('\n【LLM 判斷】');
    console.log(JSON.stringify(llmResult, null, 2));

    if (llmResult && llmResult.shouldAlert) {
      console.log('\n→ 如果是正式執行，會推送下列訊息：\n' + llmResult.message);
      console.log('\n（測試模式不實際推送）');
    }

    Logger.info('testAdvisorCheck', '─── 手動測試結束 ───');
  } catch (ex) {
    Logger.error('testAdvisorCheck', '測試失敗', ex);
    console.log('❌ 失敗：' + ex.message);
  }
}

/**
 * 手動聚合最近 N 天的 consolelog 成每日指標。
 * 改完 ChatBot 的迴圈或模型設定之後用這支看實際影響：平均輪數、耗時分佈、
 * 逾時次數、備援接手、假宣稱攔截有沒有觸發。冪等，同一天重跑會覆蓋不會疊加。
 */
function rollupMetrics() {
  var rows = Metrics.rollupDaily(7);
  console.log(JSON.stringify(rows, null, 2));
  return rows;
}

/**
 * 跑一批評估題（預設 3 題）。改完 `Prompt.gs` 之後用這支看逐題差異。
 *
 * ⚠️ **重複執行直到整組都有新的「最後執行」時間。** 一題可能跑完整個 ReAct 迴圈，
 *    GAS 只有 6 分鐘，所以一次只跑幾題；沒跑過的優先，其次最舊的。
 *    第一次執行會自己建 `eval_set` 並寫入預設題組。
 */
function runEval() {
  var r = Eval.runBatch(3);
  console.log(JSON.stringify(r, null, 2));
  console.log('未跑完的話再執行一次；結果與未通過的性質寫在 eval_set 分頁。');
  return r;
}

/** 只重畫「面板」的版面（不重算持倉）。改了 Panel.render() 之後用這支看結果。 */
function renderPanel() {
  var r = Panel.render();
  console.log(JSON.stringify(r, null, 2));
  return r;
}

// ─── NIM 模型測試 ─────────────────────────────────────────────────

/**
 * 關卡一：掃一整排 NIM 候選模型的可用性。只讀不寫，可重跑。
 *
 * ⚠️ /v1/models 列得出來不代表這個帳號打得到（目錄是全域的、可用性綁帳號，
 *    會回 404 Function not found for account）。所以第一關永遠是可用性。
 * ⚠️ 一律用 UrlFetchApp.fetchAll() 並行，不要串列迴圈：NIM 單顆冷啟動要
 *    36~46 秒，串列跑 10 顆會撞上 GAS 的 6 分鐘上限，而逾時會把整段 log 吃掉。
 */
function testNimCandidateModels() {
  var DEADLINE_MS = 4.5 * 60 * 1000;   // 6 分鐘上限留 1.5 分鐘餘裕收尾
  var startedAt   = Date.now();
  var timeLeft    = () => DEADLINE_MS - (Date.now() - startedAt);
  var elapsed     = () => Math.round((Date.now() - startedAt) / 1000) + 's';

  // ⚠️ 清單裡一定要有一顆現役模型當對照組（目前是 gpt-oss-20b）。
  //    它若也失敗，代表是 API key／網路／NIM 整體壅塞，不是候選的問題。
  // ⚠️ 已知會拖垮整批的不要放進來：mistral-medium-3.5-128b、z-ai/glm-5.2，
  //    單顆會吃滿 NIM 的 ~300s 閘道逾時，而 fetchAll 等整批。要測請單獨跑。
  var CANDIDATES = [
    'deepseek-ai/deepseek-v4-flash-0731',        // ★ 最可能的直接替代：同家族的日期版
    'openai/gpt-oss-20b',                        // 對照組（現役備援）
    'openai/gpt-oss-120b',
    'minimaxai/minimax-m3',
    'moonshotai/kimi-k2.6',
    'stepfun-ai/step-3.7-flash',
    'nvidia/nemotron-3-super-120b-a12b',
    'nvidia/nemotron-nano-3-30b-a3b',
    'meta/llama-3.3-70b-instruct',
    'google/gemma-4-31b-it'
  ];

  var url     = Config.NVIDIA_API_BASE + '/chat/completions';
  var headers = {
    'Content-Type':  'application/json',
    'Authorization': 'Bearer ' + Config.NVIDIA_API_KEY,
    'Accept':        'application/json'
  };

  /**
   * 組一個 fetchAll 用的 request。思考開關比照 NvidiaService 的分流 ——
   * DeepSeek V4 少了 chat_template_kwargs 會 hang 住不回應，這裡同樣不能省。
   */
  var buildRequest = (model, messages, maxTokens, tools) => {
    var payload = {
      model:      model,
      messages:   messages,
      max_tokens: maxTokens,
      temperature: 0.7
    };
    if (model.indexOf('deepseek-ai/deepseek-v4') === 0) {
      payload.chat_template_kwargs = { thinking: false };
    } else if (model.indexOf('z-ai/glm') === 0) {
      payload.chat_template_kwargs = { enable_thinking: false, clear_thinking: true };
    }
    if (tools) {
      payload.tools = tools;
      if (model.indexOf('gemma') === -1) payload.tool_choice = 'auto';
    }
    return {
      url:                url,
      method:             'post',
      headers:            headers,
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true
    };
  };

  /** fetchAll 包一層：整批丟例外時不要炸掉整支測試，回等長的 null 陣列 */
  var fetchAllSafe = (requests) => {
    try {
      return UrlFetchApp.fetchAll(requests);
    } catch (ex) {
      console.log('⚠️ 整批請求丟出例外：' + ex);
      return requests.map(() => null);
    }
  };

  // ── 關卡一：可用性探測（全部並行）──
  console.log('=== 關卡一：可用性探測（' + CANDIDATES.length + ' 顆，並行）===\n');

  var probeReqs = CANDIDATES.map(m =>
    buildRequest(m, [{ role: 'user', content: 'ping' }], 16, null));
  var probeResp = fetchAllSafe(probeReqs);

  var reachable = [];
  CANDIDATES.forEach((model, i) => {
    var resp = probeResp[i];
    if (!resp) { console.log('❌ ---  ' + model + '（無回應）'); return; }
    var code = resp.getResponseCode();
    console.log((code === 200 ? '✅' : '❌') + ' HTTP ' + code + '  ' + model);
    if (code !== 200) {
      console.log('      ' + resp.getContentText('UTF-8').slice(0, 160));
    } else {
      reachable.push(model);
    }
  });

  console.log('\n可用: ' + reachable.length + ' / ' + CANDIDATES.length + '（耗時 ' + elapsed() + '）');

  if (reachable.length === 0) {
    console.log('\n⚠️ 全部不可用 —— 對照組 deepseek 也失敗的話，先查 NVIDIA_API_KEY 或稍後再試');
    return;
  }

  console.log('\n→ 接著跑 testNimModelCapability()，把上面 ✅ 的清單填進它的 MODELS');
}

/**
 * 關卡二：對已知打得到的模型測 Function Calling 與中文。
 *
 * ⚠️ 必須與關卡一分成兩支函式：fetchAll 會等整批都回來，一顆卡住就綁死全部。
 *    這裡只放探測已通過的模型。
 * 先測工具呼叫再測中文：工具呼叫才是能不能接手的決定性條件。
 */
function testNimModelCapability() {
  // 填 testNimCandidateModels() 探測結果中通過的那些。
  // ⚠️ 探測過關不代表扛得住真實請求：帶工具 schema 的請求重得多，
  //    有模型在這一關才 504 並拖滿整批（已見過 z-ai/glm-5.2、llama-3.3-70b）。
  //    在這裡 504 的模型下次就別再放進批次。
  var MODELS = [
    'deepseek-ai/deepseek-v4-flash-0731',
    'openai/gpt-oss-20b',
    'openai/gpt-oss-120b',
    'minimaxai/minimax-m3',
    'nvidia/nemotron-3-super-120b-a12b',
    'meta/llama-3.3-70b-instruct'
  ];

  var DEADLINE_MS = 4.5 * 60 * 1000;
  var startedAt   = Date.now();
  var timeLeft    = () => DEADLINE_MS - (Date.now() - startedAt);
  var elapsed     = () => Math.round((Date.now() - startedAt) / 1000) + 's';

  var url     = Config.NVIDIA_API_BASE + '/chat/completions';
  var headers = {
    'Content-Type':  'application/json',
    'Authorization': 'Bearer ' + Config.NVIDIA_API_KEY,
    'Accept':        'application/json'
  };

  var buildRequest = (model, messages, maxTokens, tools) => {
    var payload = { model: model, messages: messages, max_tokens: maxTokens, temperature: 0.7 };
    if (model.indexOf('deepseek-ai/deepseek-v4') === 0) {
      payload.chat_template_kwargs = { thinking: false };
    } else if (model.indexOf('z-ai/glm') === 0) {
      payload.chat_template_kwargs = { enable_thinking: false, clear_thinking: true };
    }
    if (tools) {
      payload.tools = tools;
      if (model.indexOf('gemma') === -1) payload.tool_choice = 'auto';
    }
    return { url: url, method: 'post', headers: headers,
             payload: JSON.stringify(payload), muteHttpExceptions: true };
  };

  var fetchAllSafe = (requests) => {
    try { return UrlFetchApp.fetchAll(requests); }
    catch (ex) { console.log('⚠️ 整批請求丟出例外：' + ex); return requests.map(() => null); }
  };

  var pickMessage = (resp) => {
    if (!resp) return null;
    if (resp.getResponseCode() !== 200) {
      return { _err: 'HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText('UTF-8').slice(0, 120) };
    }
    try {
      var json = JSON.parse(resp.getContentText('UTF-8'));
      return (json.choices && json.choices[0]) ? json.choices[0].message : { _err: '回應缺少 choices' };
    } catch (ex) { return { _err: '解析失敗: ' + ex }; }
  };

  var toolDef     = Tools.getDefinitions().filter(d => d.name === 'getHistory');
  var openaiTools = AIAdapter.convertToolsToOpenAI(toolDef);

  console.log('=== Function Calling 測試（' + MODELS.length + ' 顆，並行）===');
  var fcResp = fetchAllSafe(MODELS.map(m => buildRequest(
    m, [{ role: 'user', content: '幫我查最近 7 天的資產走勢' }], 256, openaiTools)));
  console.log('整批完成，耗時 ' + elapsed() + '\n');

  MODELS.forEach((model, i) => {
    var msg = pickMessage(fcResp[i]);
    if (!msg || msg._err) {
      console.log('❌ ' + model + ' — ' + (msg ? msg._err : '無回應'));
    } else if (msg.tool_calls && msg.tool_calls.length > 0) {
      console.log('✅ ' + model);
      msg.tool_calls.forEach(tc =>
        console.log('     ' + tc.function.name + '(' + tc.function.arguments + ')'));
    } else {
      console.log('⚠️ ' + model + ' — 沒呼叫工具：' + String(msg.content).slice(0, 100));
    }
  });

  if (timeLeft() < 90 * 1000) {
    console.log('\n⏱ 剩 ' + Math.round(timeLeft() / 1000) + 's，略過中文測試。重跑一次即可取得。');
    return;
  }

  // 中文測試刻意**串列**跑：備援模型上場時使用者正在等，單顆延遲是選型依據之一，
  // 而 fetchAll 只給得出整批耗時，拿不到個別數字。會卡住的模型已在 MODELS 剔除，
  // 串列才付得起；每顆之前仍留一道時間檢查。
  console.log('\n\n=== 中文 + 個別延遲（串列）===');
  for (var j = 0; j < MODELS.length; j++) {
    if (timeLeft() < 70 * 1000) {
      console.log('\n⏱ 時間預算用完，尚未測：' + MODELS.slice(j).join(', '));
      break;
    }
    var model = MODELS[j];
    var t = Date.now();
    var resp = null;
    try {
      resp = UrlFetchApp.fetch(url, buildRequest(
        model, [{ role: 'user', content: '請用一句話說明你是哪個模型，並回答台股的交易時間。' }], 160, null));
    } catch (ex) {
      console.log('──── ' + model + '  ❌ 連線例外: ' + ex);
      continue;
    }
    var msg = pickMessage(resp);
    console.log('──── ' + model + '  ' + (Date.now() - t) + 'ms');
    console.log('  ' + (msg && !msg._err ? String(msg.content).slice(0, 200) : '❌ ' + (msg ? msg._err : '無回應')));
  }

  console.log('\n=== 測試結束（總耗時 ' + elapsed() + '）===');
}

/**
 * 關卡三：關思考測試。確認兩件事 —— 關得掉嗎？關掉後正文出得來嗎？
 *
 * ⚠️ 推理文字走 reasoning_content 且會吃掉 max_tokens 預算，預算不夠時
 *    content 直接是 null。所以每個案例都要印 finish_reason / completion_tokens /
 *    reasoning 長度，才分得清「關不掉」與「預算不夠」。
 * ⚠️ NIM 沒有統一開關，每家形狀不同，見 NvidiaService 的分支。
 *    測試的寫法必須與那裡一致，否則測出來的結論套不到線上。
 */
function testNimThinkingOff() {
  var url     = Config.NVIDIA_API_BASE + '/chat/completions';
  var headers = {
    'Content-Type':  'application/json',
    'Authorization': 'Bearer ' + Config.NVIDIA_API_KEY,
    'Accept':        'application/json'
  };

  var QUESTION = '請用一句話說明你是哪個模型，並回答台股的交易時間。';

  // 每個案例 = 一種「模型 × 關思考手法」的組合
  // 2026-08-09：改測新主模型的候選。每顆都是「預設 vs 嘗試關掉」一對，
  // 才看得出關思考的寫法有沒有生效（只看單邊會把「本來就不思考」誤判成「關成功」）。
  var CASES = [
    { label: 'deepseek-v4-flash-0731  預設', model: 'deepseek-ai/deepseek-v4-flash-0731', noThink: false },
    { label: 'deepseek-v4-flash-0731  thinking=false', model: 'deepseek-ai/deepseek-v4-flash-0731', noThink: true },
    { label: 'gpt-oss-120b            預設', model: 'openai/gpt-oss-120b', noThink: false },
    { label: 'gpt-oss-120b            effort=low(top)', model: 'openai/gpt-oss-120b', noThink: true },
    { label: 'minimax-m3              預設', model: 'minimaxai/minimax-m3', noThink: false },
    { label: 'minimax-m3              thinking=false', model: 'minimaxai/minimax-m3', noThink: true },
    { label: 'nemotron-3-super-120b   預設', model: 'nvidia/nemotron-3-super-120b-a12b', noThink: false },
    { label: 'nemotron-3-super-120b   /no_think', model: 'nvidia/nemotron-3-super-120b-a12b', noThink: true }
  ];

  // ⚠️ 每一家的形狀都不同，而且**寫錯地方不會報錯，只會沒效果**。
  //    這裡刻意跟 `NvidiaService.gs` 的分支對齊 —— 測試用 A 寫法、正式用 B 寫法的話，
  //    測出來的結論套不到線上。gpt-oss 尤其：舊版這支把 reasoning_effort 放進
  //    chat_template_kwargs（無效），而 NvidiaService 放 top-level（有效），
  //    兩邊測的根本不是同一件事。
  var buildRequest = (c) => {
    var messages = [];
    var payload  = { model: c.model, max_tokens: 512, temperature: 0.7 };

    if (c.model.indexOf('deepseek-ai/deepseek-v4') === 0) {
      // V4 系列一定要送這個欄位，省略會讓 NIM 掛住而不是報錯
      payload.chat_template_kwargs = { thinking: !c.noThink };
      if (!c.noThink) payload.chat_template_kwargs.reasoning_effort = 'high';
    } else if (c.model.indexOf('openai/gpt-oss') === 0) {
      payload.reasoning_effort = c.noThink ? 'low' : 'high';   // top-level，不是 kwargs
    } else if (c.noThink && c.model.indexOf('nvidia/') === 0) {
      messages.push({ role: 'system', content: '/no_think' });
    } else if (c.model.indexOf('minimaxai/') === 0) {
      // 形狀未知，先照 deepseek 的猜一次；沒生效就看 reasoning_content 還在不在
      payload.chat_template_kwargs = { thinking: !c.noThink };
    }

    messages.push({ role: 'user', content: QUESTION });
    payload.messages = messages;

    return { url: url, method: 'post', headers: headers,
             payload: JSON.stringify(payload), muteHttpExceptions: true };
  };

  console.log('=== 關思考測試（' + CASES.length + ' 個案例，並行，max_tokens=512）===\n');

  var responses;
  try {
    responses = UrlFetchApp.fetchAll(CASES.map(buildRequest));
  } catch (ex) {
    console.log('⚠️ 整批丟出例外：' + ex);
    return;
  }

  CASES.forEach((c, i) => {
    var resp = responses[i];
    console.log('──────── ' + c.label);
    if (!resp) { console.log('  ❌ 無回應'); return; }
    if (resp.getResponseCode() !== 200) {
      console.log('  ❌ HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText('UTF-8').slice(0, 120));
      return;
    }
    try {
      var json   = JSON.parse(resp.getContentText('UTF-8'));
      var choice = json.choices[0];
      var msg    = choice.message || {};
      var usage  = json.usage || {};
      // reasoning_content 有多長，直接說明推理吃掉多少預算
      var rc = msg.reasoning_content ? String(msg.reasoning_content) : '';
      console.log('  finish_reason=' + choice.finish_reason +
                  '  completion_tokens=' + usage.completion_tokens +
                  '  reasoning長度=' + rc.length);
      console.log('  正文: ' + (msg.content ? String(msg.content).slice(0, 180) : '❌ null（正文空）'));
    } catch (ex) {
      console.log('  ❌ 解析失敗: ' + ex);
    }
  });

  console.log('\n=== 測試結束 ===');
}

/**
 * 關卡四（決選）：拿到資料後能不能忠實地用繁體中文轉述。驗三件事：
 *   1 忠實  只能用給它的數字，不能自己編、不能算錯
 *   2 繁中  要繁體、要台灣用語
 *   3 收斂  不要長篇大論
 *
 * ⚠️ 不要考模型的內建知識，那對 iris 沒意義：數字一律從試算表與 searchWeb 餵進去。
 * ⚠️ 下面的持股數字全是捏造的。DevTools.gs 會進 git，真實金額不得入庫
 *    （見 CLAUDE.md「No real figures in git」）。
 */
function testNimFaithfulness() {
  var url     = Config.NVIDIA_API_BASE + '/chat/completions';
  var headers = {
    'Content-Type':  'application/json',
    'Authorization': 'Bearer ' + Config.NVIDIA_API_KEY,
    'Accept':        'application/json'
  };

  var PROMPT =
    '以下是今日持倉資料：\n' +
    '0050 元大台灣50：1000 股，成本 150000 元，市值 168000 元\n' +
    '0056 元大高股息：2000 股，成本 68000 元，市值 65000 元\n' +
    '現金：120000 元\n\n' +
    '請用繁體中文寫一段 80 字以內的摘要，說明目前損益狀況。只能使用上面的數字。';

  // 2026-08-09：新主模型候選的決選。`gpt-oss-20b` 留著當對照組 —— 它是現役備援，
  // 已知會過，用來確認這批的失敗不是環境問題。
  //
  // ⚠️ 上一次就是這一關刷掉了兩顆 Nemotron：語氣專業、格式完整、把 68000−65000
  //    算成 23000。前三關完全看不出來。對一個報損益的機器人這是一票否決。
  var CASES = [
    { label: 'deepseek-v4-flash-0731（頭號人選）',
      model: 'deepseek-ai/deepseek-v4-flash-0731', mode: 'deepseek' },
    { label: 'gpt-oss-20b（對照組，現役備援）',
      model: 'openai/gpt-oss-20b', mode: 'gptoss-top' },
    { label: 'gpt-oss-120b',
      model: 'openai/gpt-oss-120b', mode: 'gptoss-top' },
    { label: 'minimax-m3',
      model: 'minimaxai/minimax-m3', mode: 'deepseek' },
    { label: 'nemotron-3-super-120b  /no_think',
      model: 'nvidia/nemotron-3-super-120b-a12b', mode: 'nemotron' }
    // meta/llama-3.3-70b-instruct 已剔除：探測過得了，帶工具呼叫時 504，
    // 一顆就把 2026-08-09 那批拖滿 303 秒、害中文測試被時間不足跳過。
    // 這是第三次同樣的形狀（前兩次是 mistral-medium-3.5、glm-5.2）——
    // **探測過關不代表扛得住真實請求**，重的那關才會現形。
  ];

  var buildRequest = (c) => {
    var messages = [];
    var payload  = { model: c.model, max_tokens: 512, temperature: 0.7 };

    if (c.mode === 'deepseek') {
      payload.chat_template_kwargs = { thinking: false };
    } else if (c.mode === 'nemotron') {
      messages.push({ role: 'system', content: '/no_think' });
    } else if (c.mode === 'gptoss-top') {
      payload.reasoning_effort = 'low';          // top-level 才生效，見 NvidiaService
    } else if (c.mode === 'plain') {
      // 非思考模型，什麼都不加
    }

    messages.push({ role: 'user', content: PROMPT });
    payload.messages = messages;

    return { url: url, method: 'post', headers: headers,
             payload: JSON.stringify(payload), muteHttpExceptions: true };
  };

  console.log('=== 忠實轉述決選（' + CASES.length + ' 案例，並行）===');
  console.log('檢查點：股票市值合計應為 233000、總成本 218000、未實現損益 +15000\n');

  var responses;
  try {
    responses = UrlFetchApp.fetchAll(CASES.map(buildRequest));
  } catch (ex) {
    console.log('⚠️ 整批丟出例外：' + ex);
    return;
  }

  CASES.forEach((c, i) => {
    var resp = responses[i];
    console.log('──────── ' + c.label);
    if (!resp || resp.getResponseCode() !== 200) {
      console.log('  ❌ ' + (resp ? 'HTTP ' + resp.getResponseCode() + ' ' +
                  resp.getContentText('UTF-8').slice(0, 120) : '無回應'));
      return;
    }
    try {
      var json   = JSON.parse(resp.getContentText('UTF-8'));
      var choice = json.choices[0];
      var msg    = choice.message || {};
      var rc     = msg.reasoning_content ? String(msg.reasoning_content).length : 0;
      console.log('  tokens=' + (json.usage ? json.usage.completion_tokens : '?') +
                  '  reasoning長度=' + rc + '  finish=' + choice.finish_reason);
      console.log('  ' + (msg.content ? String(msg.content) : '❌ null（正文空）'));
    } catch (ex) {
      console.log('  ❌ 解析失敗: ' + ex);
    }
  });

  console.log('\n=== 測試結束 ===');
}

/**
 * 驗證備援鏈會動。改了 NVIDIA_FALLBACK_MODEL 或思考分流之後跑這支。測三件事：
 *   1 備援模型活著、關思考有效
 *   2 備援模型帶工具定義時會發出 tool_calls
 *   3 主模型故意給不存在的名字，確認 AIServiceFactory 真的接手 ——
 *     前兩項全過而這項掛掉的話，保底等於不存在
 */
function verifyFallbackChain() {
  var FB = Config.NVIDIA_FALLBACK_MODEL;
  console.log('備援模型 = ' + FB + '\n');

  console.log('【1】關思考');
  var r1 = NvidiaService.callAPI(
    [{ role: 'user', content: '用一句話說明什麼是 ETF。' }],
    { model: FB, maxOutputTokens: 512, enableThinking: false });
  if (!r1) {
    console.log('  ❌ 呼叫失敗');
  } else {
    var m1 = r1.choices[0].message;
    console.log('  reasoning長度=' + (m1.reasoning_content ? String(m1.reasoning_content).length : 0) +
                '  tokens=' + (r1.usage ? r1.usage.completion_tokens : '?'));
    console.log('  ' + String(m1.content).slice(0, 120));
  }

  console.log('\n【2】Function Calling');
  var tools = AIAdapter.convertToolsToOpenAI(
    Tools.getDefinitions().filter(d => d.name === 'getHistory'));
  var r2 = NvidiaService.callAPI(
    [{ role: 'user', content: '幫我查最近 7 天的資產走勢' }],
    { model: FB, maxOutputTokens: 512, enableThinking: false, tools: tools });
  if (!r2) {
    console.log('  ❌ 呼叫失敗');
  } else {
    var tc = r2.choices[0].message.tool_calls;
    console.log(tc && tc.length
      ? '  ✅ ' + tc[0].function.name + '(' + tc[0].function.arguments + ')'
      : '  ⚠️ 沒呼叫工具');
  }

  // 主模型給一個絕對不存在的 id：AIServiceFactory 找不到對應 tier config，
  // 會原封不動送出去 → NvidiaService 回 null → 保底邏輯接手改用備援。
  console.log('\n【3】主模型失敗 → 備援接手');
  var r3 = AIServiceFactory.callAPI(
    [{ role: 'user', parts: [{ text: '用一句話說明什麼是殖利率。' }] }],
    { model: 'deepseek-ai/this-model-does-not-exist', maxOutputTokens: 512, caller: 'verifyFallbackChain' });
  if (!r3) {
    console.log('  ❌ 備援沒接住 —— 保底等於不存在，要查 AIServiceFactory 的 fallback 分支');
  } else {
    var parts = r3.candidates && r3.candidates[0] && r3.candidates[0].content.parts;
    var text  = (parts || []).filter(p => p.text).map(p => p.text).join('');
    console.log('  ✅ 備援接手成功：' + text.slice(0, 120));
  }

  console.log('\n=== 驗證結束 ===');
}
