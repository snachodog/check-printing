'use strict';

/**
 * depositPdfService.js
 *
 * Generates two PDF types for a deposit:
 *   - Deposit Report: plain formatted document (Courier, monospaced)
 *   - Deposit Slip:   precisely positioned 3.375" × 8.5" slip with Style A background,
 *                     digit-column amounts, and a GnuMICR line rotated 90°.
 *
 * All measurements in inches; converted to points (× 72) for PDFKit.
 *
 * TMDC slip layout is hardcoded. Tune the LAYOUT constants below if fields
 * print slightly off on physical stock.
 */

const PDFDocument = require('pdfkit');
const path        = require('path');
const fs          = require('fs');

const PT = 72; // points per inch
const MICR_FONT_PATH = path.join(__dirname, '../../fonts/GnuMICR.ttf');

// ── Deposit Slip Layout Constants (inches) ────────────────────────────────────
// Page is 3.375" wide × 8.5" tall (portrait).
// A 0.625" strip on the LEFT holds all rotated elements (MICR, deposit total,
// check count). The remaining 2.75" is the main form content.
const SL = {
  W: 3.375,
  H: 8.5,

  // Left rotated strip — right edge of reserved area
  stripX: 0.625,

  // Content X start (inside the strip)
  cX: 0.65,

  // ── Depositor / Bank block ────────────────────────────────────────────────
  depositorY:  0.28,   // Y of first depositor line
  bankX:       1.9,    // X of bank name (right column)

  // ── Date ─────────────────────────────────────────────────────────────────
  dateY:       1.38,   // Y of DATE label
  dateValueX:  0.92,   // X where date value prints

  // ── Disclaimer ────────────────────────────────────────────────────────────
  disclaimerY: 1.56,

  // ── Amount grid ───────────────────────────────────────────────────────────
  gridTop:     1.72,   // top border of grid
  rowH:        0.175,  // height of each row

  // Column positions (right edges, in inches from left of page)
  colCentsR:   3.26,   // right edge of cents column
  colCentsW:   0.42,   // width of cents column
  colDollarSep: 0.08,  // gap between dollars and cents columns
  // dollars column right edge = colCentsR - colCentsW - colDollarSep
  // dollars column width = 7 digit slots × digitW

  digitW:      0.115,  // width of each digit slot (Courier 8pt ≈ 4.8pt + spacing)
  centDigitW:  0.115,

  // Row Y offsets from gridTop (label baseline)
  currencyRow: 1,      // grid row index
  coinRow:     2,
  checksRow:   3,      // "CHECKS:" label row (no amount on this row)
  firstCheckRow: 4,    // first numbered check row
  maxChecks:   30,

  // Check number column X
  checkNoX:    0.67,
  checkNoW:    0.55,   // max width for check number text

  // ── Footer ────────────────────────────────────────────────────────────────
  // "TOTAL $" row sits just below the last check row
  // (computed dynamically from firstCheckRow + maxChecks)

  // ── Rotated left strip ────────────────────────────────────────────────────
  // Rotated text is drawn with doc.rotate(-90) centred in the strip.
  // X positions below are distance from LEFT edge of page (strip area).
  micrY:         8.3,   // Y (on page) where rotated MICR baseline sits
  micrX:         0.12,  // X anchor for rotated MICR (left side of text after rotation)

  depTotalLabelY: 6.8,  // Y where "DEPOSIT TOTAL $" rotated label baseline sits
  depTotalAmtY:   5.6,  // Y where deposit total digits start (reading upward)
  depTotalX:      0.44, // X of rotated deposit total elements

  checkCountLabelY: 3.5, // Y of rotated "TOTAL ITEMS" label
  checkCountValY:   2.8, // Y of rotated check count value
  checkCountX:      0.44,

  // ── Style A background colours ───────────────────────────────────────────
  bgStripColor:  '#d4c9a8',  // beige shaded strip (left margin)
  bgLineColor:   '#888888',  // grid lines
  bgLabelColor:  '#444444',  // row labels (CURRENCY, COIN, etc.)
  bgHeaderColor: '#000000',  // DEPOSIT TICKET header
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

    const doc = new PDFDocument({
      size: [SL.W * PT, SL.H * PT],
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

    const totalRows    = SL.firstCheckRow + SL.maxChecks;  // last row index
    const totalRowY_   = rowTopY(totalRows);                // top of TOTAL $ row
    const gridBottom   = totalRowY_ + SL.rowH;

    // ── Style A background ──────────────────────────────────────────────────

    // Left beige strip
    doc.rect(0, 0, SL.stripX * PT, SL.H * PT)
       .fill(SL.bgStripColor);

    // Outer border
    doc.rect(SL.stripX * PT, 0, (SL.W - SL.stripX) * PT, SL.H * PT)
       .lineWidth(1).stroke('#000000');

    // Vertical divider between check# and amount columns
    const dividerX = (SL.colCentsR - SL.colCentsW - SL.colDollarSep - 7 * SL.digitW) * PT;
    const gridTopPt = SL.gridTop * PT;
    const gridBotPt = gridBottom * PT;
    doc.moveTo(dividerX, gridTopPt).lineTo(dividerX, gridBotPt).lineWidth(0.5).stroke(SL.bgLineColor);

    // Vertical divider between dollars and cents
    const dollarsCentsX = (SL.colCentsR - SL.colCentsW - SL.colDollarSep) * PT;
    doc.moveTo(dollarsCentsX, gridTopPt).lineTo(dollarsCentsX, gridBotPt).lineWidth(0.5).stroke(SL.bgLineColor);

    // Right border of cents column
    doc.moveTo(SL.colCentsR * PT, gridTopPt).lineTo(SL.colCentsR * PT, gridBotPt).lineWidth(0.5).stroke(SL.bgLineColor);

    // Column header labels
    doc.font('Helvetica').fontSize(6).fillColor(SL.bgLabelColor);
    const hdrY = (SL.gridTop - 0.1) * PT;
    doc.text('DOLLARS', dollarsCentsX - 7 * SL.digitW * PT, hdrY,
             { width: 7 * SL.digitW * PT, align: 'center', lineBreak: false });
    doc.text('CENTS', (SL.colCentsR - SL.colCentsW) * PT, hdrY,
             { width: SL.colCentsW * PT, align: 'center', lineBreak: false });

    // Horizontal grid lines for all rows
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

    // Disclaimer text (below date, above grid)
    doc.font('Helvetica').fontSize(5).fillColor('#666666')
       .text(
         'DEPOSITS MAY NOT BE AVAILABLE FOR IMMEDIATE WITHDRAWAL',
         SL.cX * PT, SL.disclaimerY * PT,
         { width: (SL.W - SL.cX - 0.05) * PT, lineBreak: false }
       );

    // Bottom disclaimer (inside form, near total row)
    doc.font('Helvetica').fontSize(5).fillColor('#666666')
       .text(
         'Checks and other items are received for deposit subject to the provisions of the Uniform Commercial Code or any applicable collection agreements.',
         SL.cX * PT, (gridBottom + 0.05) * PT,
         { width: (SL.W - SL.cX - 0.1) * PT }
       );

    // DEPOSIT TICKET header
    doc.font('Helvetica-Bold').fontSize(9).fillColor(SL.bgHeaderColor);
    const headerText = 'D E P O S I T   T I C K E T';
    doc.text(headerText, SL.cX * PT, 0.08 * PT,
             { width: (SL.W - SL.cX - 0.05) * PT, align: 'center', lineBreak: false });

    // Vertical separator between depositor and bank columns
    const midX = ((SL.cX + SL.bankX) / 2) * PT;
    doc.moveTo(midX, 0.18 * PT).lineTo(midX, (SL.dateY - 0.05) * PT)
       .lineWidth(0.5).stroke('#aaaaaa');

    // ── Depositor / Bank block ──────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000')
       .text(account.company1 || '', SL.cX * PT, SL.depositorY * PT,
             { lineBreak: false });
    let depY = SL.depositorY + 0.12;
    doc.font('Helvetica').fontSize(7);
    [account.company2, account.company3, account.company4].forEach(line => {
      if (line) {
        doc.text(line, SL.cX * PT, depY * PT, { lineBreak: false });
        depY += 0.10;
      }
    });

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000')
       .text(account.bank_name || '', SL.bankX * PT, SL.depositorY * PT,
             { lineBreak: false });
    let bnkY = SL.depositorY + 0.12;
    doc.font('Helvetica').fontSize(7);
    [account.bank_info1, account.bank_info2].forEach(line => {
      if (line) {
        doc.text(line, SL.bankX * PT, bnkY * PT, { lineBreak: false });
        bnkY += 0.10;
      }
    });

    // ── Date ───────────────────────────────────────────────────────────────
    doc.font('Helvetica').fontSize(7).fillColor(SL.bgLabelColor)
       .text('DATE', SL.cX * PT, SL.dateY * PT, { lineBreak: false });
    // Underline
    const dateUnderX1 = (SL.cX + 0.33) * PT;
    const dateUnderX2 = (SL.dateValueX + 0.85) * PT;
    const dateUnderY  = (SL.dateY + 0.01) * PT;
    doc.moveTo(dateUnderX1, dateUnderY).lineTo(dateUnderX2, dateUnderY)
       .lineWidth(0.5).stroke('#000000');
    doc.font('Courier').fontSize(8).fillColor('#000000')
       .text(deposit.deposit_date || '', (SL.cX + 0.36) * PT, (SL.dateY - 0.03) * PT,
             { lineBreak: false });

    // ── Amount data ─────────────────────────────────────────────────────────
    // Draw digits in fixed-width slots, right-aligned in the dollars column
    const dollarsRightX = (SL.colCentsR - SL.colCentsW - SL.colDollarSep);

    function drawAmountRow(amount, rowIdx) {
      const y = (rowY(rowIdx) - 0.015) * PT;
      doc.font('Courier').fontSize(8).fillColor('#000000');
      drawDigitAmount(doc, amount, dollarsRightX, y);
    }

    drawAmountRow(deposit.currency || 0, SL.currencyRow);
    drawAmountRow(deposit.coin     || 0, SL.coinRow);

    // Check items
    items.slice(0, SL.maxChecks).forEach((item, i) => {
      const r = SL.firstCheckRow + i;
      const y = (rowY(r) - 0.015) * PT;

      // Check number
      if (item.check_no) {
        doc.font('Courier').fontSize(7).fillColor('#000000')
           .text(String(item.check_no).slice(0, 8),
                 (SL.cX + 0.16) * PT, y,
                 { width: SL.checkNoW * PT, lineBreak: false });
      }
      drawAmountRow(item.amount || 0, r);
    });

    // Total $ row
    drawAmountRow(checksTotal, totalRows);

    // ── Rotated left strip elements ─────────────────────────────────────────

    // MICR line (routing + account, no check number for deposits)
    const routing = (account.routing_number || '').replace(/\D/g, '');
    const acctNo  = (account.account_number || '').replace(/[^0-9]/g, '');
    const micrStr = `A${routing}A ${acctNo}C`;

    doc.save();
    doc.translate(SL.micrX * PT, SL.micrY * PT);
    doc.rotate(-90);
    if (hasMicrFont) {
      doc.font('MICR').fontSize(11).fillColor('#000000')
         .text(micrStr, 0, 0, { lineBreak: false });
    } else {
      doc.font('Courier').fontSize(8).fillColor('#000000')
         .text(micrStr, 0, 0, { lineBreak: false });
    }
    doc.restore();

    // Rotated "DEPOSIT TOTAL $" label + amount
    doc.save();
    doc.translate(SL.depTotalX * PT, SL.depTotalLabelY * PT);
    doc.rotate(-90);
    doc.font('Helvetica').fontSize(6).fillColor(SL.bgLabelColor)
       .text('DEPOSIT TOTAL $', 0, 0, { lineBreak: false });
    doc.restore();

    // Deposit total digits (rotated, spaced)
    drawRotatedDigitAmount(doc, depositTotal, SL.depTotalX, SL.depTotalAmtY);

    // Rotated "TOTAL ITEMS" label + count
    doc.save();
    doc.translate(SL.checkCountX * PT, SL.checkCountLabelY * PT);
    doc.rotate(-90);
    doc.font('Helvetica').fontSize(6).fillColor(SL.bgLabelColor)
       .text('TOTAL ITEMS', 0, 0, { lineBreak: false });
    doc.restore();

    doc.save();
    doc.translate(SL.checkCountX * PT, SL.checkCountValY * PT);
    doc.rotate(-90);
    doc.font('Courier').fontSize(9).fillColor('#000000')
       .text(String(checkCount), 0, 0, { lineBreak: false });
    doc.restore();

    doc.end();
  });
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
 * Draw deposit total digits rotated 90° in the left strip.
 * Each digit is stacked vertically (reading downward when viewed in portrait).
 */
function drawRotatedDigitAmount(doc, amount, stripX, startY) {
  const totalCents = Math.round(Math.abs(amount) * 100);
  const dollars    = Math.floor(totalCents / 100);
  const cents      = totalCents % 100;
  const fullStr    = String(dollars) + String(cents).padStart(2, '0');
  const spacing    = 0.16; // inches between each digit

  doc.font('Courier').fontSize(9).fillColor('#000000');
  fullStr.split('').forEach((ch, i) => {
    doc.save();
    doc.translate(stripX * PT, (startY - i * spacing) * PT);
    doc.rotate(-90);
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
