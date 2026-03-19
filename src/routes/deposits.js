'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { canAccessAccount, isEditorForAccount } = require('../middleware/auth');

// Helper: fetch deposit with items
function getDepositWithItems(id) {
  const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
  if (!deposit) return null;
  deposit.items = db.prepare(
    'SELECT * FROM deposit_items WHERE deposit_id = ? ORDER BY sort_order ASC, id ASC'
  ).all(id);
  return deposit;
}

// GET /api/deposits?account_id=X
router.get('/', (req, res) => {
  const { account_id } = req.query;
  if (!account_id) return res.status(400).json({ error: 'account_id is required.' });
  if (!canAccessAccount(req.session, parseInt(account_id, 10))) return res.status(403).json({ error: 'Access denied.' });

  const deposits = db.prepare(`
    SELECT d.*, COUNT(di.id) AS item_count,
           COALESCE(SUM(di.amount), 0) AS checks_total
    FROM deposits d
    LEFT JOIN deposit_items di ON di.deposit_id = d.id
    WHERE d.account_id = ?
    GROUP BY d.id
    ORDER BY d.deposit_date DESC, d.id DESC
  `).all(account_id);

  res.json(deposits);
});

// GET /api/deposits/:id
router.get('/:id', (req, res) => {
  const deposit = getDepositWithItems(req.params.id);
  if (!deposit) return res.status(404).json({ error: 'Deposit not found.' });
  res.json(deposit);
});

// POST /api/deposits
router.post('/', (req, res) => {
  const { account_id, deposit_date, currency, coin, cash_back, items } = req.body;
  if (!account_id) return res.status(400).json({ error: 'account_id is required.' });
  if (!deposit_date) return res.status(400).json({ error: 'deposit_date is required.' });
  if (!isEditorForAccount(req.session, parseInt(account_id, 10))) {
    return res.status(403).json({ error: 'Write access required.' });
  }

  const insert = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO deposits (account_id, deposit_date, currency, coin, cash_back)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      account_id,
      deposit_date,
      parseFloat(currency) || 0,
      parseFloat(coin)     || 0,
      parseFloat(cash_back) || 0,
    );

    const depositId = result.lastInsertRowid;

    if (Array.isArray(items)) {
      const stmt = db.prepare(`
        INSERT INTO deposit_items (deposit_id, sort_order, check_no, bank_no, payee, memo, amount)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      items.forEach((item, i) => {
        stmt.run(
          depositId, i,
          item.check_no || null,
          item.bank_no  || null,
          item.payee    || null,
          item.memo     || null,
          parseFloat(item.amount) || 0,
        );
      });
    }

    return depositId;
  });

  const depositId = insert();
  res.status(201).json(getDepositWithItems(depositId));
});

// PUT /api/deposits/:id
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id, account_id FROM deposits WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Deposit not found.' });
  if (!isEditorForAccount(req.session, existing.account_id)) {
    return res.status(403).json({ error: 'Write access required.' });
  }

  const { deposit_date, currency, coin, cash_back, items } = req.body;
  if (!deposit_date) return res.status(400).json({ error: 'deposit_date is required.' });

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE deposits SET deposit_date = ?, currency = ?, coin = ?, cash_back = ?
      WHERE id = ?
    `).run(
      deposit_date,
      parseFloat(currency)  || 0,
      parseFloat(coin)      || 0,
      parseFloat(cash_back) || 0,
      req.params.id,
    );

    if (Array.isArray(items)) {
      db.prepare('DELETE FROM deposit_items WHERE deposit_id = ?').run(req.params.id);
      const stmt = db.prepare(`
        INSERT INTO deposit_items (deposit_id, sort_order, check_no, bank_no, payee, memo, amount)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      items.forEach((item, i) => {
        stmt.run(
          req.params.id, i,
          item.check_no || null,
          item.bank_no  || null,
          item.payee    || null,
          item.memo     || null,
          parseFloat(item.amount) || 0,
        );
      });
    }
  });

  update();
  res.json(getDepositWithItems(req.params.id));
});

// DELETE /api/deposits/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id, account_id FROM deposits WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Deposit not found.' });
  if (!isEditorForAccount(req.session, existing.account_id)) {
    return res.status(403).json({ error: 'Write access required.' });
  }
  // deposit_items deleted via ON DELETE CASCADE
  db.prepare('DELETE FROM deposits WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// PATCH /api/deposits/:id/mark-printed
router.patch('/:id/mark-printed', (req, res) => {
  const existing = db.prepare('SELECT account_id FROM deposits WHERE id = ?').get(req.params.id);
  if (!existing || !isEditorForAccount(req.session, existing.account_id)) {
    return res.status(403).json({ error: 'Write access required.' });
  }
  db.prepare('UPDATE deposits SET printed = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
