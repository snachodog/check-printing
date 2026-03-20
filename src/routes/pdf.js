'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { generateCheckPdf } = require('../services/pdfService');
const { isEditorForAccount } = require('../middleware/auth');

/**
 * POST /api/pdf
 * Body: { checkIds: [1, 2, ...], account_id: X }
 *
 * Returns a multi-page PDF (3 checks per page).
 * After successful generation, marks all checks as printed.
 * Query param: ?mark_printed=false to suppress auto-marking.
 */
router.post('/', async (req, res) => {
  const { checkIds, account_id } = req.body;

  if (!Array.isArray(checkIds) || checkIds.length === 0) {
    return res.status(400).json({ error: 'checkIds must be a non-empty array' });
  }
  const resolvedAccountId = parseInt(account_id, 10);
  if (!isEditorForAccount(req.session, resolvedAccountId)) {
    return res.status(403).json({ error: 'Write access required.' });
  }

  // Fetch checks in the order provided; verify each belongs to the declared account
  let checks;
  try {
    checks = checkIds.map(id => {
      const check = db.prepare('SELECT * FROM checks WHERE id = ?').get(id);
      if (!check) throw new Error(`Check ID ${id} not found`);
      if (check.account_id !== resolvedAccountId) throw new Error(`Check ID ${id} does not belong to this account`);
      return check;
    });
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
  const account = db.prepare('SELECT * FROM account WHERE id = ?').get(resolvedAccountId);
  if (!account) {
    return res.status(500).json({ error: 'No account configured.' });
  }

  // Fetch layout fields for this account
  const fields = db.prepare('SELECT * FROM layout_fields WHERE account_id = ? AND visible = 1').all(resolvedAccountId);

  try {
    const pdfBuffer = await generateCheckPdf(account, checks, fields);

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
