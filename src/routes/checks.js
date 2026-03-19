'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { canAccessAccount, isEditorForAccount } = require('../middleware/auth');

// Helper: resolve account_id from a check id (for edit/delete access checks)
function checkAccountId(checkId) {
  const row = db.prepare('SELECT account_id FROM checks WHERE id = ?').get(checkId);
  return row ? row.account_id : null;
}

// TODO: Add ledger reporting -- date range filter, payee search, total amount display, CSV export

// GET /api/checks?account_id=X - list checks for an account, newest first
router.get('/', (req, res) => {
  if (!canAccessAccount(req.session, parseInt(req.query.account_id, 10))) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  const { after, printed, account_id } = req.query;
  if (!account_id) return res.status(400).json({ error: 'account_id query param required' });

  let query = 'SELECT * FROM checks WHERE account_id = ?';
  const params = [account_id];

  if (after) {
    query += ' AND check_date >= ?';
    params.push(after);
  }
  if (printed !== undefined) {
    query += ' AND printed = ?';
    params.push(printed === 'true' || printed === '1' ? 1 : 0);
  }

  query += ' ORDER BY check_no DESC';
  res.json(db.prepare(query).all(...params));
});

// GET /api/checks/:id
router.get('/:id', (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ?').get(req.params.id);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  res.json(check);
});

// TODO: Add payee address book -- store and recall payee name + address lines, autocomplete on new check form

// POST /api/checks - create a new check (editor+)
router.post('/', (req, res) => {
  const { account_id, payee, amount, check_date, memo, note1, note2,
          payee_address1, payee_address2, payee_address3, payee_address4 } = req.body;

  if (!account_id || !payee || !amount || !check_date) {
    return res.status(400).json({ error: 'account_id, payee, amount, and check_date are required' });
  }
  if (!isEditorForAccount(req.session, parseInt(account_id, 10))) {
    return res.status(403).json({ error: 'Write access required.' });
  }

  const account = db.prepare('SELECT current_check_no FROM account WHERE id = ?').get(account_id);
  if (!account) return res.status(400).json({ error: 'Account not found.' });

  const checkNo = account.current_check_no + 1;

  const insertCheck = db.prepare(`
    INSERT INTO checks (account_id, check_no, payee, amount, check_date, memo, note1, note2,
      payee_address1, payee_address2, payee_address3, payee_address4)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateAccountCheckNo = db.prepare(
    "UPDATE account SET current_check_no = ?, updated_at = datetime('now') WHERE id = ?"
  );

  const transaction = db.transaction(() => {
    const result = insertCheck.run(
      account_id, checkNo, payee, parseFloat(amount), check_date,
      memo || null, note1 || null, note2 || null,
      payee_address1 || null, payee_address2 || null,
      payee_address3 || null, payee_address4 || null
    );
    updateAccountCheckNo.run(checkNo, account_id);
    return result.lastInsertRowid;
  });

  const newId = transaction();
  res.status(201).json(db.prepare('SELECT * FROM checks WHERE id = ?').get(newId));
});

// PUT /api/checks/:id - update a check (editor+)
router.put('/:id', (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ?').get(req.params.id);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (!isEditorForAccount(req.session, check.account_id)) {
    return res.status(403).json({ error: 'Write access required.' });
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

// DELETE /api/checks/:id (editor+)
router.delete('/:id', (req, res) => {
  const check = db.prepare('SELECT * FROM checks WHERE id = ?').get(req.params.id);
  if (!check) return res.status(404).json({ error: 'Check not found' });
  if (!isEditorForAccount(req.session, check.account_id)) {
    return res.status(403).json({ error: 'Write access required.' });
  }
  db.prepare('DELETE FROM checks WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// POST /api/checks/mark-printed (editor+)
router.post('/mark-printed', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  // Verify editor access via the first check's account
  const first = db.prepare('SELECT account_id FROM checks WHERE id = ?').get(ids[0]);
  if (!first || !isEditorForAccount(req.session, first.account_id)) {
    return res.status(403).json({ error: 'Write access required.' });
  }
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE checks SET printed = 1 WHERE id IN (${placeholders})`).run(...ids);
  res.json({ updated: ids.length });
});

module.exports = router;
