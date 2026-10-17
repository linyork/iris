/**
 * ExpenseImport
 * @description 記帳 App 的匯出檔（.xlsx）→「消費」分頁
 *
 * 「消費」是 App 資料的**鏡像**。App 的每一筆都有穩定的 source_uid，每次匯出又都是
 * 全部歷史，所以直接以 App 為準整張覆寫 —— App 端改的、刪的自然跟著同步，不必算指紋。
 *
 * ⚠️ 只用來分析，**不入帳**。不寫「交易」、不動任何帳戶餘額：現金帳戶的餘額靠「交易」的
 *    調整對帳，消費再去扣一次，支出就算了兩次。所以這裡也不呼叫 Utils.noteLedgerWrite()
 *    —— 那是「帳本真的動了」的證據，這裡沒有動帳本。
 *
 * ⚠️ xlsx 由這裡自己解（Utilities.unzip + 讀 XML），**不經過 Drive 轉成 Google Sheet**：
 *    - 轉檔要多開 Drive 權限。新權限授權之前，整個 webhook 部署都會停擺（不只匯入），
 *      而 pre-push hook 推完就 deploy，中間沒有空檔讓人先去授權。
 *    - 轉檔後儲存格型別由 Sheets 重新猜：App 寫成文字的「2026-10-17」「11:54」可能變成
 *      日期與時刻。自己解的話 App 寫什麼就讀到什麼。
 *    - 不會在 Drive 留下暫存檔，也就不用擔心清不乾淨。
 *
 * 入口：Telegram 傳 .xlsx → doPost → fromUpload()。拿到檔案之後的流程全在 run()，
 * 之後要加 Drive 資料夾之類的入口，呼叫 run() 就好。
 */
var ExpenseImport = (() => {
  var m = {};

  var _str = (v) => AssetSchema.str(v);

  // ─── 匯出格式 ────────────────────────────────────────────────

  m.FORMAT_ID      = 'com.budget.portable-xlsx';
  /** ⚠️ 改版就整批拒絕：欄位可能變了，寧可不匯，也不要默默寫進錯的資料 */
  m.SCHEMA_VERSION = 7;
  /** 不是全量的匯出檔只新增與更新，不刪除 —— 匯出範圍外的紀錄不代表被刪掉了 */
  m.FULL_SCOPE     = 'selected_ledgers_full_history';
  m.TIMEZONE       = 'Asia/Taipei';
  /** Bot API 的 getFile 只讓 bot 下載 20MB 以內的檔案 */
  m.MAX_BYTES      = 20 * 1024 * 1024;

  /** Records 的必要欄位。注意 App 的欄名是「備注」，寫進「消費」時是「備註」 */
  m.REQUIRED = ['日期', '時間', '收支', '分類', '子分類', '帳戶', '備注', 'source_uid',
                'system_amount', 'system_currency', 'modified_at_utc', 'ignore', 'status'];

  /** 對照不到的分類：計入支出 —— 寧可多算支出，也不要漏算 */
  m.UNMAPPED = '未分類';
  /** 「匯入紀錄」的狀態欄；去重與新舊比較只看這種列 */
  m.DONE = '成功';

  m.isExportFile = (fileName) => /\.xlsx$/i.test(_str(fileName));

  // ─── 讀 xlsx ─────────────────────────────────────────────────
  //
  // 只處理 App 會寫的東西，不是通用的 xlsx 解析器：沒有公式求值、沒有日期序號換算。
  // 日期序號不換算是刻意的 —— App 的日期是文字，哪天變成序號代表格式改了，那時
  // 日期檢查會整批拒絕，而不是把序號當成日期硬轉。

  var _ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

  /** XML 文字解碼：實體字元，以及 OOXML 的 _xHHHH_ 跳脫（換行在 xlsx 裡寫成 _x000D_） */
  var _decode = (t) => String(t)
    .replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (all, e) => e.charAt(0) !== '#' ? _ENT[e]
      : String.fromCodePoint(e.charAt(1) === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)))
    .replace(/_x([0-9A-Fa-f]{4})_/g, (all, h) => String.fromCharCode(parseInt(h, 16)));

  var _attrs = (s) => {
    var o = {};
    String(s).replace(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (all, k, v1, v2) => {
      o[k] = _decode(v1 !== undefined ? v1 : v2);
      return '';
    });
    return o;
  };

  /** 「AZ6067」→ 51（0-based 欄號） */
  var _colIndex = (ref) => {
    var mm = /^([A-Z]+)/.exec(ref || '');
    if (!mm) return -1;
    var n = 0;
    for (var i = 0; i < mm[1].length; i++) n = n * 26 + mm[1].charCodeAt(i) - 64;
    return n - 1;
  };

  /** <is> / <si> 裡的文字：所有 <t> 串起來，標音（<rPh>）不算 */
  var _text = (xml) => {
    var out = '';
    String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
      .replace(/<t(?:\s[^>\/]*)?>([\s\S]*?)<\/t>/g, (all, t) => { out += _decode(t); return ''; });
    return out;
  };

  var _cellValue = (type, body, shared) => {
    if (type === 'inlineStr') {
      var is = /<is>([\s\S]*?)<\/is>/.exec(body);
      return is ? _text(is[1]) : '';
    }
    var v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
    if (!v) return '';
    var raw = _decode(v[1]);
    if (type === 's')   return shared[parseInt(raw, 10)] !== undefined ? shared[parseInt(raw, 10)] : '';
    if (type === 'b')   return raw === '1' || raw === 'true';
    if (type === 'str' || type === 'e') return raw;
    var n = Number(raw);
    return raw !== '' && isFinite(n) ? n : raw;
  };

  /**
   * 掃過「開始標籤」，再用 indexOf 找結束標籤，而不是一條正規式吃整個元素：
   * 自我結束的 <row r="5"/> 會讓 <row[^>]*>…</row> 一路吞到下一列的結尾。
   */
  var _eachElement = (xml, tag, fn) => {
    var open = new RegExp('<' + tag + '\\b([^>]*?)(\\/?)>', 'g');
    var close = '</' + tag + '>';
    var mm;
    while ((mm = open.exec(xml))) {
      if (mm[2]) { fn(_attrs(mm[1]), ''); continue; }
      var end = xml.indexOf(close, open.lastIndex);
      if (end < 0) break;
      fn(_attrs(mm[1]), xml.slice(open.lastIndex, end));
      open.lastIndex = end + close.length;
    }
  };

  /**
   * 一張工作表的 XML → 二維陣列（第 0 列是標題）。空的儲存格與沒寫出來的列都是空字串，
   * 依 r 屬性定位，所以 App 跳過空白儲存格也不會讓後面的值往左擠。
   */
  m.parseSheetXml = (xml, shared) => {
    shared = shared || [];
    var rows = [];
    var nextRow = 0;
    _eachElement(xml, 'row', (ra, body) => {
      var r = ra.r ? parseInt(ra.r, 10) - 1 : nextRow;
      nextRow = r + 1;
      var cells = [];
      var nextCol = 0;
      _eachElement(body, 'c', (ca, cbody) => {
        var c = ca.r ? _colIndex(ca.r) : nextCol;
        nextCol = c + 1;
        cells[c] = cbody ? _cellValue(ca.t || 'n', cbody, shared) : '';
      });
      for (var i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
      rows[r] = cells;
    });
    for (var i = 0; i < rows.length; i++) if (rows[i] === undefined) rows[i] = [];
    return rows;
  };

  /**
   * 解開 xlsx，只讀指定的工作表。
   * @param {Blob} blob
   * @param {string[]} names
   * @returns {Object<string, Array[]>} 工作表名稱 → 二維陣列；檔案裡沒有的不會出現
   */
  m.readXlsx = (blob, names) => {
    var files = {}, byBase = {};
    try {
      // Telegram 下載下來的是 octet-stream，unzip 要看到 zip 才肯解
      if (blob.setContentType) blob.setContentType('application/zip');
      Utilities.unzip(blob).forEach(b => {
        files[b.getName()] = b;
        byBase[b.getName().split('/').pop()] = b;
      });
    } catch (e) {
      throw new Error('解不開這個檔案，它不像是 .xlsx（' + (e && e.message ? e.message : e) + '）');
    }
    // 名字對不上完整路徑時退回只比檔名：xlsx 裡要讀的這幾個檔名彼此不重複，
    // 這樣不管 unzip 回來的名字帶不帶資料夾都讀得到
    var read = (p) => {
      var b = files[p] || byBase[p.split('/').pop()];
      return b ? b.getDataAsString('UTF-8') : null;
    };
    var wb = read('xl/workbook.xml'), rels = read('xl/_rels/workbook.xml.rels');
    if (!wb || !rels) throw new Error('解不開這個檔案：裡面沒有 xl/workbook.xml，不像是 .xlsx');

    var target = {};
    _eachElement(rels, 'Relationship', (a) => { target[a.Id] = a.Target; });
    var shared = [];
    var sst = read('xl/sharedStrings.xml');
    if (sst) _eachElement(sst, 'si', (a, body) => { shared.push(_text(body)); });

    var out = {};
    _eachElement(wb, 'sheet', (a) => {
      if (names.indexOf(a.name) < 0) return;
      // 關聯屬性的命名空間前綴不一定叫 r
      var rid = a['r:id'] || Object.keys(a).filter(k => /:id$/.test(k)).map(k => a[k])[0];
      var t = _str(target[rid]);
      var xml = read(t.charAt(0) === '/' ? t.slice(1) : 'xl/' + t);
      if (xml !== null) out[a.name] = m.parseSheetXml(xml, shared);
    });
    return out;
  };

  // ─── 驗證與轉換 ──────────────────────────────────────────────

  var _bool = (v) => v === true || /^(true|1)$/i.test(_str(v));

  /**
   * 驗證並轉成「消費」的列。純函式：不碰試算表。
   *
   * 任何一項不對就回 {error}，一筆都不留 —— 全有或全無，寫入前「消費」維持原樣。
   *
   * @param {Object<string, Array[]>} book readXlsx 的結果
   * @returns {{error: string} | {manifest: object, full: boolean, rows: object[], excluded: number, warnings: string[]}}
   */
  m.parse = (book) => {
    var man = book['_Manifest'];
    if (!man) return { error: '這不是記帳 App 的匯出檔：裡面沒有 _Manifest 工作表。' };
    var M = {};
    man.slice(1).forEach(r => { var k = _str(r[0]); if (k) M[k] = r[1]; });

    if (_str(M.format_id) !== m.FORMAT_ID) {
      return { error: '這不是認得的記帳 App 匯出格式：format_id 是「' + _str(M.format_id) +
                      '」，iris 認得的是「' + m.FORMAT_ID + '」。' };
    }
    if (_str(M.schema_version) !== String(m.SCHEMA_VERSION)) {
      return { error: 'App 匯出格式改版了（實際 v' + _str(M.schema_version) + '，iris 認得 v' +
                      m.SCHEMA_VERSION + '），需要更新 iris。' };
    }
    var exportId = _str(M.export_id), exportedAt = _str(M.exported_at_utc);
    if (!exportId) return { error: '_Manifest 沒有 export_id，分不出這份匯入過沒有。' };
    if (isNaN(Date.parse(exportedAt))) {
      return { error: '_Manifest 的 exported_at_utc 讀不出時間（「' + exportedAt + '」），分不出這份比上次新還是舊。' };
    }

    var rec = book['Records'];
    if (!rec || !rec.length) return { error: '匯出檔裡沒有 Records 工作表。' };
    var col = {};
    rec[0].forEach((h, i) => { h = _str(h); if (h && !(h in col)) col[h] = i; });
    var missing = m.REQUIRED.filter(h => col[h] === undefined);
    if (missing.length) return { error: 'Records 少了必要欄位：' + missing.join('、') + '。' };

    var g = (r, h) => { var v = r[col[h]]; return v === undefined || v === null ? '' : v; };
    var data = [];
    rec.forEach((r, i) => {
      if (i === 0 || !r || !r.some(v => v !== '' && v !== null && v !== undefined)) return;
      data.push({ r: r, at: i + 1 });   // 工作表上的實際列號，錯誤訊息用
    });
    if (_str(M.records_count) === '' || Number(M.records_count) !== data.length) {
      return { error: '筆數對不上：_Manifest 說有 ' + _str(M.records_count) + ' 筆，Records 實際是 ' +
                      data.length + ' 筆。檔案可能不完整。' };
    }

    var rows = [], errors = [], seen = {}, excluded = 0;
    data.forEach(d => {
      var r = d.r, at = '第 ' + d.at + ' 列';
      // App 的資料結構有這兩個旗標，目前的資料裡沒有用到，先防著
      if (_bool(g(r, 'ignore')) || ['', '0'].indexOf(_str(g(r, 'status'))) < 0) { excluded++; return; }

      var uid = _str(g(r, 'source_uid'));
      var ymd = _str(g(r, '日期'));
      var rawAmt = g(r, 'system_amount');
      var amt = typeof rawAmt === 'number' ? rawAmt : Number(_str(rawAmt).replace(/,/g, ''));
      if (!uid) errors.push(at + '沒有 source_uid');
      else if (seen[uid]) errors.push(at + '的 source_uid 跟第 ' + seen[uid] + ' 列重複');
      // 用 App 給的當地日期，不要拿 occurred_at_utc 自己換算
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) errors.push(at + '的日期讀不懂（「' + ymd + '」）');
      if (_str(rawAmt) === '' || !isFinite(amt) || amt < 0) {
        errors.push(at + '的 system_amount 不是正數（「' + _str(rawAmt) + '」）');
      }
      if (!_str(g(r, '收支'))) errors.push(at + '沒有收支');
      if (uid) seen[uid] = d.at;

      rows.push({
        '日期': ymd,
        '時間': _str(g(r, '時間')),
        '收支': _str(g(r, '收支')),
        '金額': amt,
        '幣別': _str(g(r, 'system_currency')),
        '分類': _str(g(r, '分類')),
        '子分類': _str(g(r, '子分類')),
        '帳戶': _str(g(r, '帳戶')),
        '備註': _str(g(r, '備注')),
        'source_uid': uid,
        '修改時間': _str(g(r, 'modified_at_utc'))
      });
    });
    if (errors.length) {
      return { error: '有 ' + errors.length + ' 處資料讀不懂：\n・' + errors.slice(0, 5).join('\n・') +
                      (errors.length > 5 ? '\n…' : '') };
    }

    var warnings = [];
    var tz = _str(M.timezone);
    if (tz !== m.TIMEZONE) warnings.push('匯出檔的時區是「' + tz + '」，不是 ' + m.TIMEZONE + '，日期可能差一天。');

    return {
      manifest: { exportId: exportId, exportedAt: exportedAt, scope: _str(M.scope), timezone: tz },
      full: _str(M.scope) === m.FULL_SCOPE,
      rows: rows,
      excluded: excluded,
      warnings: warnings
    };
  };

  // ─── 分類對照 ────────────────────────────────────────────────

  /**
   * 「收支|分類」→ {type, counted}。鍵要含收支：App 的「其他」收入和支出都有。
   * 分析類型空白的列不算有對照；同一個鍵出現兩次以第一列為準。
   * ⚠️ 不讓 AI 判斷分類 —— 結果要可預測，錯了也知道去哪裡改。
   */
  m.readMapping = (ss) => {
    var map = {};
    var sh = ss.getSheetByName('分類對照');
    if (!sh) return map;
    AssetSchema.readObjects(sh).forEach(x => {
      var key = _str(x['收支']) + '|' + _str(x['分類']);
      var type = _str(x['分析類型']);
      if (!type || map[key]) return;
      map[key] = { type: type, counted: _bool(x['計入支出']) };
    });
    return map;
  };

  var _classify = (row, mapping, unmapped) => {
    var hit = mapping[row['收支'] + '|' + row['分類']];
    if (hit) {
      row['分析類型'] = hit.type;
      row['計入支出'] = hit.counted;
      return;
    }
    row['分析類型'] = m.UNMAPPED;
    row['計入支出'] = true;
    var k = row['收支'] + '／' + row['分類'];
    unmapped[k] = (unmapped[k] || 0) + 1;
  };

  // ─── 同步 ────────────────────────────────────────────────────

  var _ts = (v) => {
    var t = v instanceof Date ? v.getTime() : Date.parse(_str(v));
    return isNaN(t) ? -Infinity : t;
  };

  /** 「消費」上讀回來的一列 → 跟 parse() 產出同形狀（只有不是全量的匯出才用得到） */
  var _fromSheet = (x, tz) => {
    var o = {};
    AssetSchema.expected('消費').forEach(h => { o[h] = x[h]; });
    o['日期'] = x['日期'] instanceof Date ? Utilities.formatDate(x['日期'], tz, 'yyyy-MM-dd') : _str(x['日期']);
    o['金額'] = AssetSchema.num(x['金額']);
    ['時間', '收支', '幣別', '分類', '子分類', '帳戶', '備註', 'source_uid', '修改時間', '批次']
      .forEach(h => { o[h] = _str(x[h]); });
    return o;
  };

  /**
   * 寫進試算表的樣子。日期寫 yyyy-MM-dd 字串，由 Sheets 轉成日期值 —— 跟「交易」的日期
   * 一樣，不在 JS 裡組 Date，就不會碰到時區差一天。
   * 開頭是 = 的文字前面加 '：純文字格式不保證擋得住 setValues 把它當公式。最壞情況是那一格
   * 多一個看得到的 '，比備註變成公式好。
   */
  var _toSheet = (r) => {
    var o = Object.assign({}, r);
    Object.keys(o).forEach(k => {
      if (typeof o[k] === 'string' && o[k].charAt(0) === '=') o[k] = "'" + o[k];
    });
    return o;
  };

  var _ymdOf = (r) => r['日期'] + ' ' + r['時間'];

  /**
   * 拿到匯出檔之後的整條流程。Telegram 以外的入口也呼叫這一支。
   *
   * @param {{blob: Blob, fileName: string}} input
   * @returns {object} ok=false 時帶 reason（duplicate=true 代表匯入過了）；
   *   ok=true 時帶 total / added / updated / deleted / unmapped / batch / exportId 等
   */
  m.run = (input) => {
    var started = Date.now();
    var fileName = _str(input && input.fileName);
    Logger.info('ExpenseImport.run', '開始匯入', { fileName: fileName });

    var parsed = m.parse(m.readXlsx(input.blob, ['_Manifest', 'Records']));
    if (parsed.error) {
      Logger.warning('ExpenseImport.run', '拒絕匯入', parsed.error);
      return { ok: false, reason: parsed.error + '\n這次一筆都沒有寫，「消費」維持原樣。' };
    }
    parsed.warnings.forEach(w => Logger.warning('ExpenseImport.run', w));
    var man = parsed.manifest;

    // 鎖住的是「查重 → 寫入 → 記紀錄」這一整段：兩份同時進來（例如主人連傳兩次），
    // 第二份要等第一份記完紀錄，才看得到自己是重複的
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30 * 1000)) {
      return { ok: false, reason: '另一份匯入還在處理中，等它結束再傳一次。' };
    }
    try {
      var ss = AssetSchema.open();
      var sheet = AssetSchema.ensureTab(ss, '消費').sheet;
      AssetSchema.ensureTab(ss, '分類對照');
      var logSheet = AssetSchema.ensureTab(ss, '匯入紀錄').sheet;

      var history = AssetSchema.readObjects(logSheet).filter(x => _str(x['狀態']) === m.DONE);
      if (history.some(x => _str(x['export_id']) === man.exportId)) {
        Logger.info('ExpenseImport.run', '重複的匯出檔', man.exportId);
        return { ok: false, duplicate: true,
                 reason: '這份匯出檔已經匯入過了，資料沒有變動。改了「分類對照」想重新套用的話，' +
                         '從 App 重新匯出一份再傳。' };
      }
      // 整張覆寫時拿舊檔來匯，會把之後新增的紀錄刪掉
      var last = history.reduce((a, x) => Math.max(a, _ts(x['exported_at'])), -Infinity);
      if (Date.parse(man.exportedAt) < last) {
        Logger.warning('ExpenseImport.run', '匯出檔比上次匯入的舊', { exportedAt: man.exportedAt });
        return { ok: false,
                 reason: '這份比上次匯入的還舊（上次 ' + Utilities.formatDate(new Date(last), m.TIMEZONE, 'yyyy/MM/dd') +
                         '），為了避免把新資料蓋掉，沒有匯入。' };
      }

      var now = new Date();
      var batch = 'imp-' + Utilities.formatDate(now, m.TIMEZONE, 'yyyyMMdd-HHmmss');
      var tz = ss.getSpreadsheetTimeZone();

      // 跟現有的比，只是為了回報新增／更新／刪除幾筆；寫入是整張重寫
      var existing = AssetSchema.readObjects(sheet);
      var before = {};
      existing.forEach(x => { var u = _str(x['source_uid']); if (u) before[u] = x; });
      var stats = { added: 0, updated: 0, deleted: 0 };
      var incoming = {};
      parsed.rows.forEach(r => {
        incoming[r['source_uid']] = true;
        var old = before[r['source_uid']];
        if (!old) { stats.added++; r['批次'] = batch; }
        else if (_str(old['修改時間']) !== r['修改時間']) { stats.updated++; r['批次'] = batch; }
        else r['批次'] = _str(old['批次']) || batch;     // 沒變的列留著它當初是哪一批進來的
      });
      var kept = [];
      existing.forEach(x => {
        if (incoming[_str(x['source_uid'])]) return;
        if (parsed.full) stats.deleted++;
        else kept.push(_fromSheet(x, tz));
      });

      // App 是新的排前面。先反過來再做穩定排序，同一分鐘內的幾筆才會維持 App 裡的先後
      var all = kept.concat(parsed.rows.slice().reverse());
      all.sort((a, b) => _ymdOf(a) < _ymdOf(b) ? -1 : _ymdOf(a) > _ymdOf(b) ? 1 : 0);

      // 分類每次都整批重套：改了「分類對照」，連沒變的紀錄也要跟著改
      var mapping = m.readMapping(ss), unmapped = {};
      all.forEach(r => _classify(r, mapping, unmapped));

      AssetSchema.writeBlockByName(sheet, () => all.map(_toSheet));
      logSheet.appendRow(AssetSchema.headerMap(logSheet).__header.map(h => ({
        '時間': Utilities.formatDate(now, m.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
        'export_id': man.exportId,
        'exported_at': man.exportedAt,
        '檔名': fileName,
        '總筆數': all.length,
        '新增': stats.added,
        '更新': stats.updated,
        '刪除': stats.deleted,
        '未對照': Object.keys(unmapped).length,
        '批次': batch,
        '狀態': m.DONE
      })[h]).map(v => v === undefined ? '' : v));
      SpreadsheetApp.flush();   // 放鎖之前寫完，下一個拿到鎖的才讀得到這次的紀錄
    } finally {
      lock.releaseLock();
    }

    var result = {
      ok: true,
      exportId: man.exportId,
      exportedAt: man.exportedAt,
      full: parsed.full,
      total: all.length,
      added: stats.added,
      updated: stats.updated,
      deleted: stats.deleted,
      excluded: parsed.excluded,
      unmapped: Object.keys(unmapped).sort().map(k => ({ key: k, n: unmapped[k] })),
      batch: batch,
      period: all.length ? [all[0]['日期'], all[all.length - 1]['日期']] : null,
      month: m.monthSummary(all, Utilities.formatDate(now, m.TIMEZONE, 'yyyy-MM')),
      warnings: parsed.warnings
    };
    Logger.info('ExpenseImport.run', '匯入完成', {
      exportId: result.exportId, total: result.total, added: result.added, updated: result.updated,
      deleted: result.deleted, unmapped: result.unmapped.length, ms: Date.now() - started
    });
    return result;
  };

  /**
   * 某個月（yyyy-MM）的兩個數字，給匯入完的回覆用。
   *   生活支出：計入支出的「支出」加總，減掉計入支出的「退款」。收入不管怎麼標都不算進來，
   *             不然一個還沒對照的收入分類（預設計入支出）會讓支出變少，跟「寧可多算」相反。
   *   代墊往來淨額：代墊往來的支出 − 收入。正數是這個月墊出去的比收回來的多。
   */
  m.monthSummary = (rows, month) => {
    var out = { spend: 0, advance: 0 };
    rows.forEach(r => {
      if (String(r['日期']).slice(0, 7) !== month) return;
      var amt = AssetSchema.num(r['金額']);
      if (r['計入支出'] === true && r['收支'] === '支出') out.spend += amt;
      if (r['計入支出'] === true && r['收支'] === '退款') out.spend -= amt;
      if (r['分析類型'] === '代墊往來') {
        if (r['收支'] === '支出') out.advance += amt;
        if (r['收支'] === '收入') out.advance -= amt;
      }
    });
    return out;
  };

  // ─── 回覆 ────────────────────────────────────────────────────

  var _money = (n) => (n < 0 ? '−' : '') + Math.round(Math.abs(n)).toLocaleString('en-US');
  var _slash = (ymd) => String(ymd).replace(/-/g, '/');

  /** run() 的結果 → 給主人的訊息 */
  m.formatReply = (r) => {
    if (!r.ok) return (r.duplicate ? '' : '⚠️ ') + r.reason;
    var lines = [
      '✅ 已同步記帳資料（匯出時間 ' +
        Utilities.formatDate(new Date(Date.parse(r.exportedAt)), m.TIMEZONE, 'yyyy/MM/dd HH:mm') + '）',
      '共 ' + _money(r.total) + ' 筆｜新增 ' + _money(r.added) + '｜更新 ' + _money(r.updated) +
        '｜刪除 ' + _money(r.deleted)
    ];
    if (!r.full) lines.push('這份不是完整匯出，只新增和更新，沒有刪除任何一筆。');
    if (r.excluded) lines.push('另有 ' + _money(r.excluded) + ' 筆在 App 裡標成忽略或停用，沒有匯入。');
    if (r.period) lines.push('期間：' + _slash(r.period[0]) + ' – ' + _slash(r.period[1]));
    lines.push('');
    lines.push('本月到目前：生活支出 ' + _money(r.month.spend) + '｜代墊往來淨額 ' + _money(r.month.advance));
    if (r.unmapped.length) {
      lines.push('');
      lines.push('⚠️ ' + r.unmapped.length + ' 個分類沒有對照，暫時標成「' + m.UNMAPPED + '」並計入支出：');
      r.unmapped.forEach(u => lines.push('・' + u.key + '（' + _money(u.n) + ' 筆）'));
      lines.push('到「分類對照」補上，再從 App 重新匯出一份傳過來就會更新。');
    }
    r.warnings.forEach(w => { lines.push(''); lines.push('⚠️ ' + w); });
    return lines.join('\n');
  };

  // ─── 從聊天室收檔案 ──────────────────────────────────────────

  /**
   * 主人在 Telegram 傳 .xlsx 時的進入點（由 doPost 分流過來，跟券商 CSV 分開）。
   * 不先問就匯入：同一份匯出檔（export_id）只會匯入一次，舊的蓋不掉新的。
   *
   * @param {object} event doPost 正規化後的事件
   * @returns {string} 要回給主人的訊息
   */
  m.fromUpload = (event) => {
    try {
      var doc = event && event.message && event.message.document;
      if (!doc) return '沒有收到檔案。';
      if (event.platform !== 'TELEGRAM') return '目前只有 Telegram 收得到檔案。';
      if (doc.fileSize > m.MAX_BYTES) {
        return '檔案太大了（' + (Math.round(doc.fileSize / 1024 / 102.4) / 10) + ' MB），' +
               'Telegram 只讓 bot 下載 20 MB 以內的檔案。';
      }
      return m.formatReply(m.run({ blob: Telegram.fetchFileBlob(doc.fileId), fileName: doc.fileName }));
    } catch (ex) {
      Logger.error('ExpenseImport.fromUpload', '匯入記帳匯出檔失敗', ex);
      return '匯入記帳資料時發生錯誤：' + (ex && ex.message ? ex.message : String(ex));
    }
  };

  return m;
})();
