'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/checks - list all checks, newest first
router.get('/', (req, res) => {
  const { after, printed } = req.query;
  let query = 'SELECT * FROM checks';
  const params = [];
  const conditions = [];

  if (after) {
    conditions.push('check_date >= ?');
    params.push(after);
  }
  if (printed !== undefined) {
    conditions.push('printed = ?');
    params.push(printed === 'true' || printed === '1' ? 1 : 0);
  }

  if (conditions.length) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY check_no DESC';

  const checks = db.prepare(query).all(...params);
  res.json(checks);
});

// GET /api/checks/:id
router.get('/:id', (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ?').get(req.params.id);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  res.json(check);
});

// POST /api/checks - create a new check
router.post('/', (req, res) => {
  const { payee, amount, check_date, memo, note1, note2,
          payee_address1, payee_address2, payee_address3, payee_address4 } = req.body;

  if (!payee || !amount || !check_date) {
    return res.status(400).json({ error: 'payee, amount, and check_date are required' });
  }

  // Get next check number from account
  const account = db.prepare('SELECT current_check_no FROM account WHERE id = 1').get();
  if (!account) return res.status(500).json({ error: 'No account configured. Run migration first.' });

  const checkNo = account.current_check_no + 1;

  const insertCheck = db.prepare(`
    INSERT INTO checks (check_no, payee, amount, check_date, memo, note1, note2,
      payee_address1, payee_address2, payee_address3, payee_address4)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateAccountCheckNo = db.prepare(
    'UPDATE account SET current_check_no = ?, updated_at = datetime(\'now\') WHERE id = 1'
  );

  const transaction = db.transaction(() => {
    const result = insertCheck.run(
      checkNo, payee, parseFloat(amount), check_date,
      memo || null, note1 || null, note2 || null,
      payee_address1 || null, payee_address2 || null,
      payee_address3 || null, payee_address4 || null
    );
    updateAccountCheckNo.run(checkNo);
    return result.lastInsertRowid;
  });

  const newId = transaction();
  const newCheck = db.prepare('SELECT * FROM checks WHERE id = ?').get(newId);
  res.status(201).json(newCheck);
});

// PUT /api/checks/:id - update a check
router.put('/:id', (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ?').get(req.params.id);
  if (!check) return res.status(404).json({ error: 'Check not found' });

  if (check.printed) {
    return res.status(409).json({ error: 'Cannot edit a check that has been printed.' });
  }

  const { payee, amount, check_date, memo, note1, note2,
          payee_address1, payee_address2, payee_address3, payee_address4 } = req.body;

  db.prepare(`
    UPDATE checks SET
      payee = ?, amount = ?, check_date = ?, memo = ?, note1 = ?, note2 = ?,
      payee_address1 = ?, payee_address2 = ?, payee_address3 = ?, payee_address4 = ?
    WHERE id = ?
  `).run(
    payee ?? check.payee,
    amount !== undefined ? parseFloat(amount) : check.amount,
    check_date ?? check.check_date,
    memo ?? check.memo,
    note1 ?? check.note1,
    note2 ?? check.note2,
    payee_address1 ?? check.payee_address1,
    payee_address2 ?? check.payee_address2,
    payee_address3 ?? check.payee_address3,
    payee_address4 ?? check.payee_address4,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM checks WHERE id = ?').get(req.params.id));
});

// DELETE /api/checks/:id
router.delete('/:id', (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ?').get(req.params.id);
  if (!check) return res.status(404).json({ error: 'Check not found' });

  if (check.printed) {
    return res.status(409).json({ error: 'Cannot delete a check that has been printed.' });
  }

  db.prepare('DELETE FROM checks WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// POST /api/checks/mark-printed - mark checks as printed
router.post('/mark-printed', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }

  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE checks SET printed = 1 WHERE id IN (${placeholders})`).run(...ids);
  res.json({ updated: ids.length });
});

module.exports = router;
