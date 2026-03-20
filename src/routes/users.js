'use strict';

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { validatePassword } = require('./auth');

// All /api/users routes require admin
router.use(requireAuth, requireAdmin);

function userWithAccounts(id) {
  const user = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id);
  if (!user) return null;
  user.accounts = db.prepare('SELECT account_id, role FROM user_accounts WHERE user_id = ?').all(id);
  return user;
}

// GET /api/users
router.get('/', (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id ASC').all();
  users.forEach(u => {
    u.accounts = db.prepare('SELECT account_id, role FROM user_accounts WHERE user_id = ?').all(u.id);
  });
  res.json(users);
});

// POST /api/users
router.post('/', async (req, res) => {
  const { username, password, role, accounts } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  if (!['admin', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const hash = await bcrypt.hash(password, 12);

  let userId;
  try {
    const result = db.prepare(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    ).run(username.trim(), hash, role);
    userId = result.lastInsertRowid;
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken.' });
    throw err;
  }

  if (role !== 'admin' && Array.isArray(accounts) && accounts.length > 0) {
    const stmt = db.prepare('INSERT OR IGNORE INTO user_accounts (user_id, account_id, role) VALUES (?, ?, ?)');
    accounts.forEach(a => stmt.run(userId, a.id, a.role === 'editor' ? 'editor' : 'viewer'));
  }

  res.status(201).json(userWithAccounts(userId));
});

// PUT /api/users/:id
router.put('/:id', async (req, res) => {
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const { username, password, role, accounts } = req.body;

  if (role && !['admin', 'editor', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  if (username && username.trim() !== '') {
    try {
      db.prepare("UPDATE users SET username = ?, updated_at = datetime('now') WHERE id = ?")
        .run(username.trim(), req.params.id);
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken.' });
      throw err;
    }
  }

  if (role) {
    db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?")
      .run(role, req.params.id);
  }

  if (password) {
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const hash = await bcrypt.hash(password, 12);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .run(hash, req.params.id);
  }

  if (Array.isArray(accounts)) {
    db.prepare('DELETE FROM user_accounts WHERE user_id = ?').run(req.params.id);
    const effectiveRole = role || user.role;
    if (effectiveRole !== 'admin' && accounts.length > 0) {
      const stmt = db.prepare('INSERT OR IGNORE INTO user_accounts (user_id, account_id, role) VALUES (?, ?, ?)');
      accounts.forEach(a => stmt.run(req.params.id, a.id, a.role === 'editor' ? 'editor' : 'viewer'));
    }
  }

  // If role or account assignments changed, invalidate all active sessions for this user
  // so the new permissions take effect immediately rather than at session expiry.
  if (role || Array.isArray(accounts)) {
    db.prepare("DELETE FROM sessions WHERE CAST(json_extract(sess, '$.userId') AS INTEGER) = ?")
      .run(parseInt(req.params.id, 10));
  }

  res.json(userWithAccounts(req.params.id));
});

// DELETE /api/users/:id
router.delete('/:id', (req, res) => {
  if (parseInt(req.params.id, 10) === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account.' });
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
