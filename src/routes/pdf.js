'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { generateCheckPdf } = require('../services/pdfService');

/**
 * POST /api/pdf
 * Body: { checkIds: [1, 2, 3] }  -- 1 to 3 check IDs
 *
 * Returns a PDF with 1–3 checks in a 3-up layout.
 * After successful generation, marks all checks as printed.
 *
 * Query param: ?mark_printed=false to suppress auto-marking (for reprints).
 */
router.post('/', async (req, res) => {
  const { checkIds } = req.body;

  if (!Array.isArray(checkIds) || checkIds.length === 0) {
    return res.status(400).json({ error: 'checkIds must be a non-empty array' });
  }

  // Fetch account
  const account = db.prepare('SELECT * FROM account WHERE id = 1').get();
  if (!account) {
    return res.status(500).json({ error: 'No account configured. Run migration first.' });
  }

  // Fetch checks in the order provided
  const checks = checkIds.map(id => {
    const check = db.prepare('SELECT * FROM checks WHERE id = ?').get(id);
    if (!check) throw new Error(`Check ID ${id} not found`);
    return check;
  });

  // Fetch layout fields (all visible fields)
  const fields = db.prepare('SELECT * FROM layout_fields WHERE visible = 1').all();

  try {
    const pdfBuffer = await generateCheckPdf(account, checks, fields);

    // Mark as printed unless explicitly suppressed (e.g., reprint)
    const markPrinted = req.query.mark_printed !== 'false';
    if (markPrinted) {
      const placeholders = checkIds.map(() => '?').join(',');
      db.prepare(`UPDATE checks SET printed = 1 WHERE id IN (${placeholders})`).run(...checkIds);
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="checks-${checkIds.join('-')}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ error: 'PDF generation failed', detail: err.message });
  }
});

module.exports = router;
