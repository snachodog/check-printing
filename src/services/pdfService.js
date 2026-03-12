'use strict';

/**
 * pdfService.js
 *
 * Generates a 3-up check PDF from 1–3 check records.
 * All measurements are in points (72 pts/inch) internally;
 * layout coordinates from the database are in inches and converted here.
 *
 * Page layout:
 *   - 8.5" × 11" letter page
 *   - Three check slots: each 8.5" wide × 3.5" tall; remaining ~0.5" is tear-off strip
 *   - MICR line: hardcoded at Y = 3.233" from top of each slot (0.267" from bottom of check)
 *
 * Coordinate origin for each slot is top-left of that slot.
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const POINTS_PER_INCH = 72;
const PAGE_WIDTH_IN  = 8.5;
const PAGE_HEIGHT_IN = 11;
const SLOT_HEIGHT_IN = 3.5;  // physical check height; remainder (~0.5") is tear-off strip at bottom
const MICR_Y_IN      = SLOT_HEIGHT_IN - 0.267;  // 0.267" from bottom of slot

// MICR line format: transit symbol (⑆) and on-us symbol (⑈) in E-13B encoding.
// The GnuMICR / micrenc font maps these to specific characters.
// Standard MICR layout: [check#] ⑆[routing]⑆ [account#]⑈
// Use TTF — the OTF is converted from PostScript Type 1 and may not embed correctly in PDFKit
const MICR_FONT_PATH = path.join(__dirname, '../../fonts/GnuMICR.ttf');

// Amount in words conversion
function amountToWords(amount) {
  const dollars = Math.floor(amount);
  const cents = Math.round((amount - dollars) * 100);

  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven',
    'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen',
    'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty',
    'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function below1000(n) {
    if (n === 0) return '';
    if (n < 20) return ones[n] + ' ';
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? '-' + ones[n % 10] : '') + ' ';
    return ones[Math.floor(n / 100)] + ' Hundred ' + below1000(n % 100);
  }

  function toWords(n) {
    if (n === 0) return 'Zero';
    let result = '';
    if (Math.floor(n / 1000) > 0) {
      result += below1000(Math.floor(n / 1000)) + 'Thousand ';
      n = n % 1000;
    }
    result += below1000(n);
    return result.trim();
  }

  const dollarWords = dollars === 0 ? 'Zero' : toWords(dollars);
  const centStr = cents.toString().padStart(2, '0');
  return `${dollarWords} and ${centStr}/100`;
}

// Format amount with ** padding (like the original software)
function formatAmountDisplay(amount) {
  return `**${amount.toFixed(2)}`;
}

// Format MICR line
// Standard check layout: [spaces][check#][transit symbol][routing][transit symbol][account][on-us symbol]
// Using micrenc.ttf character mappings: A=transit, B=amount, C=on-us, D=dash
// GnuMICR uses: 'A' for transit, 'C' for on-us
function formatMicrLine(routingNo, accountNo, checkNo) {
  // Pad check number to 4+ digits
  const checkPadded = checkNo.toString().padStart(4, '0');
  // Routing: 9 digits, wrapped in transit symbols (A in micrenc)
  const routing = routingNo.replace(/\D/g, '');
  // Account: strip non-numeric, wrap in on-us symbols (C in micrenc)
  const account = accountNo.replace(/[^0-9]/g, '');

  // MICR format: A[routing]A [account]C [check#]A
  // This is the standard US check layout
  return `A${routing}A ${account}C ${checkPadded}A`;
}

/**
 * Main export: generates a PDF buffer for 1–3 checks.
 *
 * @param {Object} account - Account row from database
 * @param {Array}  checks  - Array of 1–3 check rows from database
 * @param {Array}  fields  - Layout field rows from layout_fields table
 * @returns {Promise<Buffer>} PDF as a buffer
 */
function generateCheckPdf(account, checks, fields) {
  return new Promise((resolve, reject) => {
    console.log(`[pdf] MICR font path: ${MICR_FONT_PATH}`);
    const hasMicrFont = fs.existsSync(MICR_FONT_PATH);
    console.log(`[pdf] MICR font exists: ${hasMicrFont}`);

    const doc = new PDFDocument({
      size: [
        PAGE_WIDTH_IN * POINTS_PER_INCH,
        PAGE_HEIGHT_IN * POINTS_PER_INCH,
      ],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: true,
    });

    if (hasMicrFont) {
      try {
        doc.registerFont('MICR', MICR_FONT_PATH);
        console.log('[pdf] MICR font registered successfully');
      } catch (err) {
        console.error(`[pdf] MICR font registration failed: ${err.message}`);
      }
    } else {
      console.warn(`[pdf] MICR font not found — falling back to Courier`);
    }

    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // TODO: Add 1-up with stub layout -- render Stub-prefixed fields from layout_fields alongside the check body

    // Separate layout fields into check body vs stub fields
    const bodyFields = fields.filter(f => !f.field_name.startsWith('Stub'));
    const stubFields = fields.filter(f => f.field_name.startsWith('Stub')); // eslint-disable-line no-unused-vars

    // We always render 3 slots; empty slots get a blank placeholder
    for (let slot = 0; slot < 3; slot++) {
      const check = checks[slot] || null;
      const slotOriginY = slot * SLOT_HEIGHT_IN;

      // Offset adjustments from account calibration
      const offX = (account.offset_right - account.offset_left);
      const offY = (account.offset_down - account.offset_up);

      // Helper: convert inches (relative to slot) to PDF points (absolute page)
      const pt = (xIn, yIn) => ({
        x: (xIn + offX) * POINTS_PER_INCH,
        y: (slotOriginY + yIn + offY) * POINTS_PER_INCH,
      });

      if (!check) continue;

      // --- Render each layout field ---
      for (const field of bodyFields) {
        if (!field.visible) continue;

        const pos = pt(field.x_pos, field.y_pos);

        switch (field.field_type) {
          case 'Line': {
            const endPos = pt(field.x_end_pos, field.y_end_pos);
            doc.moveTo(pos.x, pos.y)
               .lineTo(endPos.x, endPos.y)
               .lineWidth(field.line_thick || 1)
               .stroke('#000000');
            break;
          }

          case 'Graph': {
            // Logo or signature image
            const imgData = field.field_name === 'Logo'
              ? account.logo_data
              : account.signature_data;

            if (imgData) {
              try {
                // Data URI: strip the header, get base64
                const base64 = imgData.replace(/^data:[^;]+;base64,/, '');
                const imgBuffer = Buffer.from(base64, 'base64');
                const endPos = pt(field.x_end_pos, field.y_end_pos);
                const w = Math.abs(endPos.x - pos.x);
                const h = Math.abs(endPos.y - pos.y);
                doc.image(imgBuffer, pos.x, pos.y, { width: w, height: h });
              } catch (err) {
                console.warn(`Could not render image for field ${field.field_name}:`, err.message);
              }
            }
            break;
          }

          case 'Text': {
            // Static label
            const label = field.field_text || '';
            setFont(doc, field);
            renderLines(doc, label, pos.x, pos.y, field.font_size || 10);
            break;
          }

          case 'Regular': {
            // Dynamic data - map field name to check/account data
            const value = resolveFieldValue(field.field_name, check, account);
            if (value !== null && value !== undefined && value !== '') {
              setFont(doc, field);
              renderLines(doc, String(value), pos.x, pos.y, field.font_size || 10);
            }
            break;
          }
        }
      }

      // --- MICR line ---
      const micrLine = formatMicrLine(account.routing_number, account.account_number, check.check_no);
      const micrPos = pt(0.3, MICR_Y_IN);

      if (hasMicrFont) {
        try {
          doc.font('MICR').fontSize(12).fillColor('#000000')
             .text(micrLine, micrPos.x, micrPos.y, { lineBreak: false });
        } catch (err) {
          console.error(`[pdf] Failed to render MICR font on slot ${slot}: ${err.message}`);
          doc.font('Courier').fontSize(10).fillColor('#000000')
             .text(micrLine, micrPos.x, micrPos.y, { lineBreak: false });
        }
      } else {
        doc.font('Courier').fontSize(10).fillColor('#000000')
           .text(micrLine, micrPos.x, micrPos.y, { lineBreak: false });
      }

    }

    doc.end();
  });
}

/**
 * Renders text at (x, y), splitting on newlines for multi-line fields.
 * Each line is placed at an explicit Y so PDFKit's internal cursor doesn't drift.
 */
function renderLines(doc, text, x, y, fontSize) {
  const lineHeight = fontSize * 1.2;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    doc.fillColor('#000000')
       .text(line, x, y + i * lineHeight, { lineBreak: false });
  });
}

/**
 * Maps a layout field name to its runtime value from check/account data.
 * Field names come from T200's FldName column.
 */
function resolveFieldValue(fieldName, check, account) {
  switch (fieldName) {
    case 'Payee Name':
      return check.payee;
    case 'Amount':
      return formatAmountDisplay(check.amount);
    case 'Text Amount':
      return amountToWords(check.amount) + '***';
    case 'Date':
      return check.check_date;
    case 'Memo':
      return check.memo;
    case 'Check Number':
      return check.check_no;
    case 'Payee Address':
      // Multi-line address
      return [
        check.payee_address1,
        check.payee_address2,
        check.payee_address3,
        check.payee_address4,
      ].filter(Boolean).join('\n');
    case 'Company Name':
      return account.company1;
    case 'Company Name2':
      return account.company2;
    case 'Bank Information':
      return [account.bank_name, account.bank_info1, account.bank_info2, account.bank_info3]
        .filter(Boolean).join('\n');
    case 'Bank Transit Code':
      return account.transit_code;
    default:
      return null;
  }
}

// TODO: Add visual layout editor -- UI to nudge field X/Y positions and printer offset calibration (offset_left/right/up/down)

/**
 * Sets the PDFKit font based on a layout field's font properties.
 * Falls back to Helvetica if the stored font name is not a built-in.
 */
function setFont(doc, field) {
  const builtins = [
    'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
    'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
    'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  ];
  const fontName = builtins.includes(field.font_name) ? field.font_name : 'Helvetica';
  doc.font(fontName).fontSize(field.font_size || 10);
}

module.exports = { generateCheckPdf, amountToWords, formatMicrLine };
