'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { generateDepositPdf } = require('../services/depositPdfService');

// POST /api/deposit-pdf
// Body: { depositId, type: 'slip' | 'report', mark_printed: true }
router.post('/', async (req, res) => {
  const { depositId, type = 'slip', mark_printed = true } = req.body;

  if (!depositId) return res.status(400).json({ error: 'depositId is required.' });
  if (!['slip', 'report'].includes(type)) {
    return res.status(400).json({ error: 'type must be "slip" or "report".' });
  }

  const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(depositId);
  if (!deposit) return res.status(404).json({ error: 'Deposit not found.' });

  const account = db.prepare('SELECT * FROM account WHERE id = ?').get(deposit.account_id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  const items = db.prepare(
    'SELECT * FROM deposit_items WHERE deposit_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(depositId);

  try {
    const pdfBuffer = await generateDepositPdf(account, deposit, items, type);

    if (mark_printed && type === 'slip') {
      db.prepare('UPDATE deposits SET printed = 1 WHERE id = ?').run(depositId);
    }

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `inline; filename="deposit-${type}-${deposit.deposit_date}.pdf"`,
      'Content-Length':      pdfBuffer.length,
    });
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Deposit PDF generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
