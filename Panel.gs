/**
 * Panel
 * @description 「面板」分頁的排版 —— 人看的那一張
 *
 * 這張表**一格資料都不存**。每個儲存格都是指向「持倉」「現金」「實體資產」
 * 「交易」的公式，所以 GOOGLEFINANCE 一跳，這裡就跟著跳；重算之間也不會停在
 * 上一次寫入的時間點。`render()` 只決定「要畫幾列、畫哪幾列」。
 *
 * ⚠️ 程式要讀的數字**不在這裡**，在「指標」那張直式 key-value 表。
 *    兩張分工是刻意的：
 *      指標  固定三欄（指標／數值／說明），`readObjects` 讀得到，欄位契約嚴格
 *      面板  自由排版，隨時可以搬位置、加區塊，不會有東西跟著壞掉
 *    早期兩件事擠在同一張，於是「想把版面排得像舊表」與「持倉的
 *    VLOOKUP(\"總資產\") 不能斷」互相打架。拆開之後兩邊都不必再讓步。
 *
 * 由 `Position.rebuild()` 在最後呼叫，也可以單獨跑 `renderPanel()`。
 */
var Panel = (() => {
  var p = {};

  var _num = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var n = parseFloat(String(v).replace(/[,$%]/g, ''));
    return isNaN(n) ? 0 : n;
  };

  var MONEY = '#,##0';
  var PRICE = '#,##0.0000';
  var RATE  = '0.00%';

  /**
   * 重畫「面板」。
   * @param {Spreadsheet} [ss]
   * @returns {{holdings:number, accounts:number, top:number}}
   */
  p.render = (ss) => {
    ss = ss || AssetSchema.open();
    var pos = ss.getSheetByName('持倉');
    var csh = ss.getSheetByName('現金');
    var pnl = ss.getSheetByName('面板');
    if (!pos || !csh || !pnl) {
      Logger.error('Panel.render', '缺少 持倉／現金／面板 分頁');
      return { holdings: 0, accounts: 0, top: 0 };
    }

    // 只畫還有部位的標的。出清的留在「持倉」與「已實現損益」裡，
    // 但擺在面板上只會是一排 0，把還在的部位擠下去。
    var held = [];
    var posLast = pos.getLastRow();
    if (posLast >= 2) {
      pos.getRange(2, 1, posLast - 1, 3).getValues().forEach((v, i) => {
        if (_num(v[2]) > 0) held.push(i + 2);      // 記的是「持倉」的列號
      });
    }
    var cashN = Math.max(csh.getLastRow() - 1, 0);

    pnl.clear();
    try { pnl.clearNotes(); } catch (e) { /* 沒註解就算了 */ }
    try { pnl.setFrozenRows(0); pnl.setFrozenColumns(0); } catch (e) { /* 同上 */ }

    // ── 左上：總覽（A/B）與淨值（C/D）────────────────────────────
    //
    // 「淨」＝扣掉累計股利之後的成本。持倉!L 就是 總成本 − 累計股利，
    // 直接加總 L 即可，不要在這裡再減一次。
    //
    // 總成本／總價值刻意 SUM 整欄（含已出清的列）：出清後那幾列的
    // 總成本與市值都已經歸零，加進來不影響金額，卻省掉一串位址拼接。
    pnl.getRange(1, 1, 5, 4).setValues([
      ['總成本', '=SUM(持倉!$D$2:$D)',      '淨總成本',   '=SUM(持倉!$L$2:$L)'],
      ['總收益', '=$B$3-$B$1',              '淨收益',     '=$B$3-$D$1'],
      ['總價值', '=SUM(持倉!$I$2:$I)',      '淨收益率',   '=IF($D$1=0,0,$D$2/$D$1)'],
      ['收益率', '=IF($B$1=0,0,$B$2/$B$1)', '累計股利',   '=SUM(持倉!$F$2:$F)'],
      ['總資產', '=$B$3+SUM(現金!$H$2:$H)+SUM(實體資產!$I$2:$I)',
                                            '已實現損益', '=SUM(持倉!$G$2:$G)']
    ]);

    // 舊表的「虛均月領」是拿 5 年平均年股利推的，新表沒有那欄資料。
    // 改成近 12 個月**實際入帳**的股利平均 —— 一樣是公式，而且是真的收到的錢。
    pnl.getRange(7, 1, 2, 2).setValues([
      ['近12月均月股利',
        '=SUMIFS(交易!$I:$I,交易!$B:$B,"股利",交易!$A:$A,">="&EDATE(TODAY(),-12))/12'],
      ['近12月均日股利', '=$B$7/30.44']
    ]);

    // ── 右上：各帳戶餘額（E/F）─────────────────────────────────
    var cashRows = [];
    for (var i = 0; i < cashN; i++) {
      var cr = i + 2;
      cashRows.push(['=現金!$A' + cr, '=現金!$H' + cr]);
    }
    cashRows.push(['現金合計', '=SUM(現金!$H$2:$H)']);
    cashRows.push(['實體資產', '=SUM(實體資產!$I$2:$I)']);
    pnl.getRange(1, 5, cashRows.length, 2).setValues(cashRows);

    // ── 持股明細 ──────────────────────────────────────────────
    var top = Math.max(8, cashRows.length) + 2;
    pnl.getRange(top, 1, 1, 9).setValues([[
      '代號', '名稱', '總成本', '單位成本', '股數', '當前市價', '當前價值', '幅度', '淨幅度'
    ]]);

    var body = held.map(r => ([
      '=持倉!$A' + r, '=持倉!$B' + r, '=持倉!$D' + r, '=持倉!$E' + r, '=持倉!$C' + r,
      '=持倉!$H' + r, '=持倉!$I' + r, '=持倉!$K' + r, '=持倉!$M' + r
    ]));
    if (body.length) pnl.getRange(top + 1, 1, body.length, 9).setValues(body);

    var first = top + 1, last = top + body.length, sumRow = last + 1;
    if (body.length) {
      pnl.getRange(sumRow, 1, 1, 9).setValues([[
        '合計', '',
        '=SUM($C$' + first + ':$C$' + last + ')', '', '', '',
        '=SUM($G$' + first + ':$G$' + last + ')',
        '=IF($C$' + sumRow + '=0,0,($G$' + sumRow + '-$C$' + sumRow + ')/$C$' + sumRow + ')',
        '=IF($D$1=0,0,($G$' + sumRow + '-$D$1)/$D$1)'
      ]]);
    }

    _format(pnl, cashRows.length, top, body.length, sumRow);

    var result = { holdings: body.length, accounts: cashN, top: top };
    Logger.info('Panel.render', '面板重畫完成', result);
    return result;
  };

  /** 純外觀。失敗不該讓重算整支掛掉，所以整段包起來。 */
  var _format = (pnl, cashLen, top, bodyLen, sumRow) => {
    try {
      pnl.getRange(1, 2, 3, 1).setNumberFormat(MONEY);      // B1:B3
      pnl.getRange(4, 2, 1, 1).setNumberFormat(RATE);       // B4 收益率
      pnl.getRange(5, 2, 1, 1).setNumberFormat(MONEY);      // B5 總資產
      pnl.getRange(1, 4, 2, 1).setNumberFormat(MONEY);      // D1:D2
      pnl.getRange(3, 4, 1, 1).setNumberFormat(RATE);       // D3 淨收益率
      pnl.getRange(4, 4, 2, 1).setNumberFormat(MONEY);      // D4:D5
      pnl.getRange(7, 2, 2, 1).setNumberFormat(MONEY);
      pnl.getRange(1, 6, cashLen, 1).setNumberFormat(MONEY);

      pnl.getRange(1, 1, 5, 1).setFontWeight('bold');
      pnl.getRange(1, 3, 5, 1).setFontWeight('bold');
      pnl.getRange(5, 2, 1, 1).setFontWeight('bold');
      pnl.getRange(7, 1, 2, 1).setFontWeight('bold');
      pnl.getRange(1, 5, cashLen, 1).setFontWeight('bold');
      pnl.getRange(cashLen - 1, 5, 2, 2).setFontWeight('bold');
      pnl.getRange(top, 1, 1, 9).setFontWeight('bold');

      if (!bodyLen) return;
      pnl.getRange(top + 1, 3, bodyLen, 1).setNumberFormat(MONEY);
      pnl.getRange(top + 1, 4, bodyLen, 1).setNumberFormat(PRICE);
      pnl.getRange(top + 1, 5, bodyLen, 1).setNumberFormat(MONEY);
      pnl.getRange(top + 1, 6, bodyLen, 1).setNumberFormat(PRICE);
      pnl.getRange(top + 1, 7, bodyLen, 1).setNumberFormat(MONEY);
      pnl.getRange(top + 1, 8, bodyLen, 2).setNumberFormat(RATE);
      pnl.getRange(sumRow, 1, 1, 9).setFontWeight('bold');
      pnl.getRange(sumRow, 3, 1, 1).setNumberFormat(MONEY);
      pnl.getRange(sumRow, 7, 1, 1).setNumberFormat(MONEY);
      pnl.getRange(sumRow, 8, 1, 2).setNumberFormat(RATE);
    } catch (e) {
      Logger.error('Panel.render', '套用格式失敗（數字仍然正確）', e);
    }
  };

  return p;
})();
