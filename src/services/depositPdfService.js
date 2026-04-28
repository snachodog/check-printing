'use strict';

/**
 * depositPdfService.js
 *
 * Generates two PDF types for a deposit:
 *   - Deposit Report: plain formatted document (Courier, monospaced)
 *   - Deposit Slip:   precisely positioned 3.375" × 8.5" slip printed on an 8.5"×11"
 *                     letter page for trimming. Style A background (grid lines drawn
 *                     server-side). Digit-column amounts. GnuMICR line in left strip.
 *
 * All measurements in inches; converted to points (× 72) for PDFKit.
 *
 * Left strip elements use rotate(90) so text reads when tilting head LEFT (same
 * orientation as Qslip/standard bank deposit slips).
 *
 * Tune the SL constants below if fields print slightly off on physical stock.
 */

const PDFDocument = require('pdfkit');
const path        = require('path');
const fs          = require('fs');

const PT = 72; // points per inch
const MICR_FONT_PATH = path.join(__dirname, '../../fonts/GnuMICR.ttf');

// ── Deposit Slip Layout Constants (inches) ────────────────────────────────────
// Slip is 3.375" wide × 8.5" tall, printed on an 8.5"×11" letter page.
// slipX offsets the slip horizontally on the letter page (0 = left edge).
// A 0.625" strip on the LEFT holds all rotated strip elements.
// Strip elements use rotate(90): text reads when tilting head LEFT (Qslip orientation).
// Strip element Y positions are the TOP of each element; text flows downward.
const SL = {
  W: 3.375,
  H: 8.5,

  // Horizontal offset of the slip on the 8.5"×11" letter page
  slipX: 0,

  // Left rotated strip — width of reserved area
  stripX: 0.625,

  // Content X start (right of strip)
  cX: 0.65,

  // ── Depositor block ───────────────────────────────────────────────────────
  depositorY: 0.28,   // Y of company name (first depositor line)

  // ── Date ─────────────────────────────────────────────────────────────────
  dateY:      1.38,   // Y of DATE label
  dateValueX: 0.92,   // X where date value prints

  // ── Disclaimer ────────────────────────────────────────────────────────────
  disclaimerY: 1.56,

  // ── Amount grid ───────────────────────────────────────────────────────────
  gridTop:  1.72,   // top border of grid
  rowH:     0.175,  // height of each row

  // Column positions (right edges, in inches from left of slip)
  colCentsR:    3.26,   // right edge of cents column
  colCentsW:    0.42,   // width of cents column
  colDollarSep: 0.08,   // gap between dollars and cents columns

  digitW:     0.115,  // width per dollar digit slot
  centDigitW: 0.115,

  // Row indices
  currencyRow:   1,
  coinRow:       2,
  checksRow:     3,  // "CHECKS:" label row — no amount
  firstCheckRow: 4,
  maxChecks:     30,

  checkNoX: 0.67,
  checkNoW: 0.55,

  // ── Rotated left strip (rotate(90): text flows downward, reads tilt-left) ─
  // All strip X positions are centered in the 0.625" strip.
  // Y positions are the TOP anchor; text flows DOWNWARD from there.
  stripCenterX:     0.32,   // ≈ stripX/2; tune to center text in strip width

  // Order top-to-bottom: "DEPOSIT TOTAL $ X.XX" → MICR → "TOTAL ITEMS" → count
  depTotalY:        0.7,    // combined "DEPOSIT TOTAL $ X.XX" rotated text start
  micrY:            2.2,    // MICR starts here (~2.4" long at 11pt); ends ~4.6"
  checkCountLabelY: 5.0,    // "TOTAL ITEMS" label start
  checkCountValY:   6.1,    // check count value start

  // ── Colours ───────────────────────────────────────────────────────────────
  bgLineColor:   '#888888',
  bgLabelColor:  '#444444',
  bgHeaderColor: '#000000',
};

// Grid row Y baseline (from top of page, in inches)
function rowY(rowIndex) {
  return SL.gridTop + rowIndex * SL.rowH + SL.rowH * 0.7; // text baseline within row
}

function rowTopY(rowIndex) {
  return SL.gridTop + rowIndex * SL.rowH;
}

// ── Report PDF ────────────────────────────────────────────────────────────────

function generateDepositReport(account, deposit, items) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 36, bottom: 36, left: 54, right: 54 },
      autoFirstPage: true,
    });

    const buffers = [];
    doc.on('data', c => buffers.push(c));
    doc.on('end',  () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const cashTotal   = (deposit.currency || 0) + (deposit.coin || 0);
    const checksTotal = items.reduce((s, i) => s + (i.amount || 0), 0);
    const subTotal    = cashTotal + checksTotal;
    const depositTotal = subTotal - (deposit.cash_back || 0);

    const fmt = n => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const W = 504; // usable width in points

    // Header
    doc.font('Helvetica-Bold').fontSize(14)
       .text('Deposit Report', { align: 'center' });
    doc.font('Helvetica').fontSize(10)
       .text(deposit.deposit_date, { align: 'right' });
    doc.moveDown(0.5);

    // Two-column depositor / bank block
    const colW = W / 2;
    const startY = doc.y;
    doc.font('Helvetica-Bold').fontSize(9)
       .text(account.company1 || '', 54, startY, { width: colW });
    if (account.company2) doc.font('Helvetica').fontSize(9).text(account.company2, 54, doc.y, { width: colW });
    if (account.company3) doc.font('Helvetica').fontSize(9).text(account.company3, 54, doc.y, { width: colW });

    const bankX = 54 + colW;
    doc.font('Helvetica-Bold').fontSize(9)
       .text(account.bank_name || '', bankX, startY, { width: colW });
    if (account.bank_info1) doc.font('Helvetica').fontSize(9).text(account.bank_info1, bankX, doc.y, { width: colW });
    if (account.bank_info2) doc.font('Helvetica').fontSize(9).text(account.bank_info2, bankX, doc.y, { width: colW });

    doc.moveDown(1);

    // Cash summary
    doc.font('Courier').fontSize(9);
    const lw = 200;
    const rx = 54 + W - 80;
    function reportLine(label, value) {
      doc.font('Courier').fontSize(9)
         .text(label + ':', 54, doc.y, { width: lw, continued: false });
      doc.text(fmt(value), rx, doc.y - doc.currentLineHeight(), { width: 80, align: 'right' });
    }
    reportLine('Currency', deposit.currency || 0);
    reportLine('Coin',     deposit.coin     || 0);
    reportLine('Cash Total', cashTotal);
    doc.moveDown(0.3);

    // Check grid header
    doc.moveTo(54, doc.y).lineTo(54 + W, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(0.2);
    doc.font('Courier-Bold').fontSize(8)
       .text('#',       54,       doc.y, { width: 20 })
       .text('Check#',  74,       doc.y - doc.currentLineHeight(), { width: 55 })
       .text('Bank#',   134,      doc.y - doc.currentLineHeight(), { width: 55 })
       .text('Received From', 194, doc.y - doc.currentLineHeight(), { width: 140 })
       .text('Memo',    340,      doc.y - doc.currentLineHeight(), { width: 120 })
       .text('Amount',  460,      doc.y - doc.currentLineHeight(), { width: 98, align: 'right' });
    doc.moveDown(0.2);
    doc.moveTo(54, doc.y).lineTo(54 + W, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(0.2);

    // Check rows
    doc.font('Courier').fontSize(8);
    items.forEach((item, i) => {
      const y = doc.y;
      doc.text(String(i + 1) + '.', 54, y, { width: 20 });
      doc.text(item.check_no || '', 74,  y, { width: 55 });
      doc.text(item.bank_no  || '', 134, y, { width: 55 });
      doc.text(item.payee    || '', 194, y, { width: 140, ellipsis: true });
      doc.text(item.memo     || '', 340, y, { width: 120, ellipsis: true });
      doc.text(fmt(item.amount || 0), 460, y, { width: 98, align: 'right' });
    });

    doc.moveDown(0.3);
    doc.moveTo(54, doc.y).lineTo(54 + W, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(0.3);

    // Totals block
    function totalLine(label, value, bold) {
      const y = doc.y;
      doc.font(bold ? 'Courier-Bold' : 'Courier').fontSize(9)
         .text(label + ':', 54, y, { width: lw })
         .text(fmt(value), rx, y, { width: 80, align: 'right' });
    }
    totalLine('Checks Total', checksTotal);
    totalLine('Subtotal',     subTotal);
    totalLine('Cash Back',    deposit.cash_back || 0);
    doc.moveDown(0.2);
    doc.moveTo(rx - 10, doc.y).lineTo(54 + W, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(0.2);
    totalLine('Deposit Total', depositTotal, true);

    doc.end();
  });
}

// ── Slip PDF ──────────────────────────────────────────────────────────────────

function generateDepositSlip(account, deposit, items) {
  return new Promise((resolve, reject) => {
    const hasMicrFont = fs.existsSync(MICR_FONT_PATH);

    // Landscape letter page (11"×8.5") — slip is drawn portrait in the left 3.375"
    // and the remaining ~7.6" to the right is blank for trimming.
    const doc = new PDFDocument({
      size: 'LETTER',
      layout: 'landscape',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: true,
    });

    if (hasMicrFont) doc.registerFont('MICR', MICR_FONT_PATH);

    const buffers = [];
    doc.on('data', c => buffers.push(c));
    doc.on('end',  () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const cashTotal    = (deposit.currency || 0) + (deposit.coin || 0);
    const checksTotal  = items.reduce((s, i) => s + (i.amount || 0), 0);
    const subTotal     = cashTotal + checksTotal;
    const depositTotal = subTotal - (deposit.cash_back || 0);
    const checkCount   = items.length;

    // Split items: first 30 on front, up to 30 more on back
    const frontItems  = items.slice(0, SL.maxChecks);
    const backItems   = items.slice(SL.maxChecks, SL.maxChecks * 2);
    const hasBackPage = backItems.some(it => (it.amount || 0) > 0 || it.check_no || it.payee);
    const backTotal   = hasBackPage ? backItems.reduce((s, i) => s + (i.amount || 0), 0) : 0;

    // When back page exists, add one extra row on front for "FROM REVERSE"
    const fromReverseRow = hasBackPage ? SL.firstCheckRow + SL.maxChecks : null;
    const totalRows  = fromReverseRow != null
      ? SL.firstCheckRow + SL.maxChecks + 1
      : SL.firstCheckRow + SL.maxChecks;
    const totalRowY_ = rowTopY(totalRows);
    const gridBottom = totalRowY_ + SL.rowH;

    // Offset all slip drawing to its position on the letter page
    doc.save();
    doc.translate(SL.slipX * PT, 0);

    // ── Style A background ──────────────────────────────────────────────────

    // No fill on left strip (white/transparent per user preference)

    // Vertical divider between check# and amount columns
    const dividerX    = (SL.colCentsR - SL.colCentsW - SL.colDollarSep - 7 * SL.digitW) * PT;
    const gridTopPt   = SL.gridTop * PT;
    const gridBotPt   = gridBottom * PT;
    doc.moveTo(dividerX, gridTopPt).lineTo(dividerX, gridBotPt)
       .lineWidth(0.5).stroke(SL.bgLineColor);

    // Vertical divider between dollars and cents
    const dollarsCentsX = (SL.colCentsR - SL.colCentsW - SL.colDollarSep) * PT;
    doc.moveTo(dollarsCentsX, gridTopPt).lineTo(dollarsCentsX, gridBotPt)
       .lineWidth(0.5).stroke(SL.bgLineColor);

    // Right border of cents column
    doc.moveTo(SL.colCentsR * PT, gridTopPt).lineTo(SL.colCentsR * PT, gridBotPt)
       .lineWidth(0.5).stroke(SL.bgLineColor);

    // Column header labels
    doc.font('Helvetica').fontSize(6).fillColor(SL.bgLabelColor);
    const hdrY = (SL.gridTop - 0.1) * PT;
    doc.text('DOLLARS', dollarsCentsX - 7 * SL.digitW * PT, hdrY,
             { width: 7 * SL.digitW * PT, align: 'center', lineBreak: false });
    doc.text('CENTS', (SL.colCentsR - SL.colCentsW) * PT, hdrY,
             { width: SL.colCentsW * PT, align: 'center', lineBreak: false });

    // Horizontal grid lines
    for (let r = 0; r <= totalRows + 1; r++) {
      const y = rowTopY(r) * PT;
      doc.moveTo(SL.stripX * PT, y).lineTo(SL.colCentsR * PT, y)
         .lineWidth(r === 0 || r === totalRows + 1 ? 0.75 : 0.3)
         .stroke(SL.bgLineColor);
    }

    // Row labels
    doc.font('Courier').fontSize(7).fillColor(SL.bgLabelColor);
    function rowLabel(label, rowIdx) {
      doc.text(label, SL.cX * PT, rowY(rowIdx) * PT - 5, { lineBreak: false });
    }
    rowLabel('CURRENCY', SL.currencyRow);
    rowLabel('COIN',     SL.coinRow);
    rowLabel('CHECKS:',  SL.checksRow);

    // Numbered check rows
    doc.font('Courier').fontSize(6).fillColor(SL.bgLabelColor);
    for (let i = 0; i < SL.maxChecks; i++) {
      const r = SL.firstCheckRow + i;
      doc.text(String(i + 1), SL.cX * PT, rowY(r) * PT - 4,
               { width: 14, align: 'right', lineBreak: false });
    }

    // TOTAL $ row label
    doc.font('Courier-Bold').fontSize(7).fillColor('#000000');
    doc.text('TOTAL $', SL.cX * PT, rowY(totalRows) * PT - 5, { lineBreak: false });

    // Top disclaimer (above grid)
    doc.font('Helvetica').fontSize(5).fillColor('#666666')
       .text(
         'DEPOSITS MAY NOT BE AVAILABLE FOR IMMEDIATE WITHDRAWAL',
         SL.cX * PT, SL.disclaimerY * PT,
         { width: (SL.W - SL.cX - 0.05) * PT, lineBreak: false }
       );

    // Bottom disclaimer (below grid)
    doc.font('Helvetica').fontSize(5).fillColor('#666666')
       .text(
         'Checks and other items are received for deposit subject to the provisions of the Uniform Commercial Code or any applicable collection agreements.',
         SL.cX * PT, (gridBottom + 0.05) * PT,
         { width: (SL.W - SL.cX - 0.1) * PT }
       );

    // DEPOSIT TICKET header
    doc.font('Helvetica-Bold').fontSize(9).fillColor(SL.bgHeaderColor)
       .text('D E P O S I T   T I C K E T', SL.cX * PT, 0.08 * PT,
             { width: (SL.W - SL.cX - 0.05) * PT, align: 'center', lineBreak: false });

    // ── Depositor block — account info, then bank info stacked below ────────
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000')
       .text(account.company1 || '', SL.cX * PT, SL.depositorY * PT,
             { lineBreak: false });
    let blockY = SL.depositorY + 0.12;
    doc.font('Helvetica').fontSize(7);
    [account.company2, account.company3, account.company4].forEach(line => {
      if (line) {
        doc.text(line, SL.cX * PT, blockY * PT, { lineBreak: false });
        blockY += 0.10;
      }
    });

    // Bank info — stacked below depositor, small gap
    blockY += 0.06;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000')
       .text(account.bank_name || '', SL.cX * PT, blockY * PT, { lineBreak: false });
    blockY += 0.12;
    doc.font('Helvetica').fontSize(7);
    [account.bank_info1, account.bank_info2].forEach(line => {
      if (line) {
        doc.text(line, SL.cX * PT, blockY * PT, { lineBreak: false });
        blockY += 0.10;
      }
    });

    // ── Date ───────────────────────────────────────────────────────────────
    doc.font('Helvetica').fontSize(7).fillColor(SL.bgLabelColor)
       .text('DATE', SL.cX * PT, SL.dateY * PT, { lineBreak: false });
    // Underline (positioned lower than the label text)
    const dateUnderX1 = (SL.cX + 0.33) * PT;
    const dateUnderX2 = (SL.dateValueX + 0.85) * PT;
    const dateUnderY  = (SL.dateY + 0.09) * PT;
    doc.moveTo(dateUnderX1, dateUnderY).lineTo(dateUnderX2, dateUnderY)
       .lineWidth(0.5).stroke('#000000');
    doc.font('Courier').fontSize(8).fillColor('#000000')
       .text(deposit.deposit_date || '', (SL.cX + 0.36) * PT, (SL.dateY - 0.01) * PT,
             { lineBreak: false });

    // ── Amount data ─────────────────────────────────────────────────────────
    const dollarsRightX = (SL.colCentsR - SL.colCentsW - SL.colDollarSep);

    function drawAmountRow(amount, rowIdx) {
      const y = (rowY(rowIdx) - 0.015) * PT;
      doc.font('Courier').fontSize(8).fillColor('#000000');
      drawDigitAmount(doc, amount, dollarsRightX, y);
    }

    drawAmountRow(deposit.currency || 0, SL.currencyRow);
    drawAmountRow(deposit.coin     || 0, SL.coinRow);

    frontItems.forEach((item, i) => {
      const r = SL.firstCheckRow + i;
      const y = (rowY(r) - 0.015) * PT;
      if (item.check_no) {
        doc.font('Courier').fontSize(7).fillColor('#000000')
           .text(String(item.check_no).slice(0, 8),
                 (SL.cX + 0.16) * PT, y,
                 { width: SL.checkNoW * PT, lineBreak: false });
      }
      drawAmountRow(item.amount || 0, r);
    });

    // "FROM REVERSE" row carries back-page subtotal onto the front
    if (fromReverseRow != null) {
      doc.font('Courier').fontSize(6).fillColor(SL.bgLabelColor)
         .text('FROM REVERSE', SL.cX * PT, rowY(fromReverseRow) * PT - 4, { lineBreak: false });
      drawAmountRow(backTotal, fromReverseRow);
    }

    drawAmountRow(depositTotal, totalRows);

    // ── Rotated left strip elements ─────────────────────────────────────────
    // All elements use rotate(90): text flows downward on the page, which reads
    // correctly when you tilt your head to the LEFT (standard bank deposit orientation).
    // stripCenterX centers the text baseline within the 0.625" strip.

    const routing = (account.routing_number || '').replace(/\D/g, '');
    const acctNo  = (account.account_number || '').replace(/[^0-9]/g, '');
    const micrStr = `A${routing}A ${acctNo}C`;

    // MICR line — centered in strip, near bottom
    doc.save();
    doc.translate(SL.stripCenterX * PT, SL.micrY * PT);
    doc.rotate(90);
    if (hasMicrFont) {
      doc.font('MICR').fontSize(11).fillColor('#000000')
         .text(micrStr, 0, 0, { lineBreak: false });
    } else {
      doc.font('Courier').fontSize(8).fillColor('#000000')
         .text(micrStr, 0, 0, { lineBreak: false });
    }
    doc.restore();

    // Combined "DEPOSIT TOTAL $  X,XXX.XX" — single rotated text line
    const fmtDepTotal = depositTotal.toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
    doc.save();
    doc.translate(SL.stripCenterX * PT, SL.depTotalY * PT);
    doc.rotate(90);
    doc.font('Courier').fontSize(7).fillColor('#000000')
       .text(`DEPOSIT TOTAL $  ${fmtDepTotal}`, 0, 0, { lineBreak: false });
    doc.restore();

    // "TOTAL ITEMS" label
    doc.save();
    doc.translate(SL.stripCenterX * PT, SL.checkCountLabelY * PT);
    doc.rotate(90);
    doc.font('Helvetica').fontSize(6).fillColor(SL.bgLabelColor)
       .text('TOTAL ITEMS', 0, 0, { lineBreak: false });
    doc.restore();

    // Check count value
    doc.save();
    doc.translate(SL.stripCenterX * PT, SL.checkCountValY * PT);
    doc.rotate(90);
    doc.font('Courier').fontSize(9).fillColor('#000000')
       .text(String(checkCount), 0, 0, { lineBreak: false });
    doc.restore();

    doc.restore(); // end slip position translate

    if (hasBackPage) {
      doc.addPage();
      renderDepositBackPage(doc, backItems, backTotal);
    }

    doc.end();
  });
}

// ── Back page renderer ────────────────────────────────────────────────────────

function renderDepositBackPage(doc, backItems, backTotal) {
  // Same slip position and width as front (slipX=0, W=3.375").
  // No left strip elements; grid starts near the top.
  const BK = {
    gridTop:   0.48,
    checksRow: 0,
    firstRow:  1,
    maxChecks: SL.maxChecks,  // 30
  };
  const totalRows  = BK.firstRow + BK.maxChecks;  // "TOTAL $" row index

  const bkRowTopY = r => BK.gridTop + r * SL.rowH;
  const bkRowY    = r => BK.gridTop + r * SL.rowH + SL.rowH * 0.7;

  const gridTopPt = bkRowTopY(0) * PT;
  const gridBotPt = (bkRowTopY(totalRows) + SL.rowH) * PT;

  doc.save();
  doc.translate(SL.slipX * PT, 0);

  // ── Title ─────────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(9).fillColor(SL.bgHeaderColor)
     .text('A D D I T I O N A L   C H E C K   L I S T I N G',
           SL.cX * PT, 0.10 * PT,
           { width: (SL.W - SL.cX - 0.05) * PT, align: 'center', lineBreak: false });

  // ── Grid verticals (same column positions as front) ───────────────────────
  const dollarsRightX  = SL.colCentsR - SL.colCentsW - SL.colDollarSep;
  const dividerX       = (dollarsRightX - 7 * SL.digitW) * PT;
  const dollarsCentsX  = dollarsRightX * PT;

  doc.moveTo(dividerX,       gridTopPt).lineTo(dividerX,       gridBotPt).lineWidth(0.5).stroke(SL.bgLineColor);
  doc.moveTo(dollarsCentsX,  gridTopPt).lineTo(dollarsCentsX,  gridBotPt).lineWidth(0.5).stroke(SL.bgLineColor);
  doc.moveTo(SL.colCentsR * PT, gridTopPt).lineTo(SL.colCentsR * PT, gridBotPt).lineWidth(0.5).stroke(SL.bgLineColor);

  // Column headers
  doc.font('Helvetica').fontSize(6).fillColor(SL.bgLabelColor);
  const hdrY = (BK.gridTop - 0.10) * PT;
  doc.text('DOLLARS', dollarsCentsX - 7 * SL.digitW * PT, hdrY,
           { width: 7 * SL.digitW * PT, align: 'center', lineBreak: false });
  doc.text('CENTS', (SL.colCentsR - SL.colCentsW) * PT, hdrY,
           { width: SL.colCentsW * PT, align: 'center', lineBreak: false });

  // "CHECKS:" header label
  doc.font('Courier').fontSize(7).fillColor(SL.bgLabelColor)
     .text('CHECKS:', SL.cX * PT, bkRowY(BK.checksRow) * PT - 5, { lineBreak: false });

  // ── Horizontal grid lines ─────────────────────────────────────────────────
  for (let r = 0; r <= totalRows + 1; r++) {
    const y = bkRowTopY(r) * PT;
    const isOuter = r === 0 || r === totalRows + 1;
    doc.moveTo(SL.stripX * PT, y).lineTo(SL.colCentsR * PT, y)
       .lineWidth(isOuter ? 0.75 : 0.3).stroke(SL.bgLineColor);
  }

  // ── Row numbers (continuing from front: 31–60) ────────────────────────────
  doc.font('Courier').fontSize(6).fillColor(SL.bgLabelColor);
  for (let i = 0; i < BK.maxChecks; i++) {
    const r = BK.firstRow + i;
    doc.text(String(SL.maxChecks + i + 1), SL.cX * PT, bkRowY(r) * PT - 4,
             { width: 14, align: 'right', lineBreak: false });
  }

  // ── "TOTAL $" footer label ────────────────────────────────────────────────
  doc.font('Courier-Bold').fontSize(7).fillColor('#000000')
     .text('T O T A L  $', SL.cX * PT, bkRowY(totalRows) * PT - 5, { lineBreak: false });

  // ── "Forward to other side" in left strip (rotated) ───────────────────────
  const fwdY = bkRowTopY(totalRows) + SL.rowH * 0.5;
  doc.save();
  doc.translate(SL.stripCenterX * PT, fwdY * PT);
  doc.rotate(90);
  doc.font('Helvetica').fontSize(6).fillColor(SL.bgLabelColor)
     .text('Forward to other side', 0, 0, { lineBreak: false });
  doc.restore();

  // ── Amount data ───────────────────────────────────────────────────────────
  backItems.forEach((item, i) => {
    const r = BK.firstRow + i;
    const y = (bkRowY(r) - 0.015) * PT;
    if (item.check_no) {
      doc.font('Courier').fontSize(7).fillColor('#000000')
         .text(String(item.check_no).slice(0, 8),
               (SL.cX + 0.16) * PT, y,
               { width: SL.checkNoW * PT, lineBreak: false });
    }
    if ((item.amount || 0) > 0) {
      doc.font('Courier').fontSize(8).fillColor('#000000');
      drawDigitAmount(doc, item.amount, dollarsRightX, y);
    }
  });

  // Back page total
  doc.font('Courier').fontSize(8).fillColor('#000000');
  drawDigitAmount(doc, backTotal, dollarsRightX, (bkRowY(totalRows) - 0.015) * PT);

  doc.restore();
}

// ── Amount rendering helpers ──────────────────────────────────────────────────

/**
 * Draw a dollar amount in digit-column format (each digit in its own fixed slot).
 * @param {PDFDocument} doc
 * @param {number}      amount      e.g. 9224.45
 * @param {number}      dollarsRightX  right edge of dollars column (inches)
 * @param {number}      y           PDFKit Y in points (absolute)
 */
function drawDigitAmount(doc, amount, dollarsRightX, y) {
  const totalCents = Math.round(Math.abs(amount) * 100);
  const dollars    = Math.floor(totalCents / 100);
  const cents      = totalCents % 100;

  const NSLOTS = 7;   // dollar digit slots
  const dolStr = dollars === 0 ? '' : String(dollars);
  const ctStr  = String(cents).padStart(2, '0');

  // Dollars: place each digit right-to-left
  const dW = SL.digitW * PT;
  const rightPt = dollarsRightX * PT;
  for (let i = 0; i < NSLOTS; i++) {
    const digitIdx = dolStr.length - 1 - i;
    if (digitIdx < 0) break;
    const x = rightPt - (i + 1) * dW + (dW - 4.8) / 2; // centre 4.8pt char in slot
    doc.text(dolStr[digitIdx], x, y, { lineBreak: false });
  }

  // Cents: two digits in cents column
  const SL_colCentsR  = SL.colCentsR * PT;
  const cW = SL.centDigitW * PT;
  for (let i = 0; i < 2; i++) {
    const x = SL_colCentsR - (2 - i) * cW + (cW - 4.8) / 2;
    doc.text(ctStr[i], x, y, { lineBreak: false });
  }
}

/**
 * Draw deposit total digits in the left strip using rotate(90).
 * Each character is stacked top-to-bottom on the page; reads correctly
 * when tilting head left. Includes a '.' decimal separator.
 */
function drawRotatedDigitAmount(doc, amount, stripCenterX, startY) {
  const totalCents = Math.round(Math.abs(amount) * 100);
  const dollars    = Math.floor(totalCents / 100);
  const cents      = totalCents % 100;
  // Include decimal point between dollars and cents
  const fullStr    = String(dollars) + '.' + String(cents).padStart(2, '0');
  const spacing    = 0.16; // inches between each character

  doc.font('Courier').fontSize(9).fillColor('#000000');
  fullStr.split('').forEach((ch, i) => {
    doc.save();
    doc.translate(stripCenterX * PT, (startY + i * spacing) * PT);
    doc.rotate(90);
    doc.text(ch, 0, 0, { lineBreak: false });
    doc.restore();
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {Object} account  - account row
 * @param {Object} deposit  - deposit row
 * @param {Array}  items    - deposit_items rows
 * @param {string} type     - 'slip' | 'report'
 * @returns {Promise<Buffer>}
 */
function generateDepositPdf(account, deposit, items, type) {
  if (type === 'report') return generateDepositReport(account, deposit, items);
  return generateDepositSlip(account, deposit, items);
}

module.exports = { generateDepositPdf };
