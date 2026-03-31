'use strict';

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const db      = require('../db/database');

// ── Password validation ───────────────────────────────────────────────────────
// Returns an error string if invalid, or null if acceptable.
function validatePassword(password) {
  if (!password || password.length < 10) return 'Password must be at least 10 characters.';
  if (!/[a-zA-Z]/.test(password))        return 'Password must contain at least one letter.';
  if (!/[^a-zA-Z]/.test(password))       return 'Password must contain at least one digit or symbol.';
  return null;
}

// ── Login rate limiter ────────────────────────────────────────────────────────
// Tracks failed login attempts per IP. After 10 failures within 15 minutes,
// further attempts are blocked until the window resets.
const loginAttempts = new Map(); // ip -> { count, resetAt }
const RATE_WINDOW_MS  = 15 * 60 * 1000; // 15 minutes
const RATE_MAX_FAILS  = 10;

function checkLoginRate(ip) {
  const now  = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 0, resetAt: now + RATE_WINDOW_MS });
    return true; // allow
  }
  return entry.count < RATE_MAX_FAILS;
}

function recordLoginFailure(ip) {
  const now   = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else {
    entry.count++;
  }
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

// Purge stale entries every 30 minutes to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000).unref();

// GET /api/auth/setup-needed — true when no users exist (first-run)
router.get('/setup-needed', (req, res) => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  res.json({ setupNeeded: n === 0 });
});

// POST /api/auth/setup — create the first admin (only works when no users exist)
router.post('/setup', async (req, res) => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return res.status(409).json({ error: 'Setup already complete.' });

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')"
  ).run(username.trim(), hash);

  req.session.userId   = result.lastInsertRowid;
  req.session.username = username.trim();
  req.session.role     = 'admin';

  res.status(201).json({ id: result.lastInsertRowid, username: username.trim(), role: 'admin' });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (!checkLoginRate(ip)) {
    return res.status(429).json({ error: 'Too many failed login attempts. Please try again later.' });
  }

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username.trim());
  if (!user) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  clearLoginFailures(ip);
  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.role     = user.role;

  res.json({ id: user.id, username: user.username, role: user.role });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  res.json({ id: req.session.userId, username: req.session.username, role: req.session.role });
});

// POST /api/auth/change-password — any logged-in user can change their own password
router.post('/change-password', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated.' });

  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both fields required.' });
  const pwErr = validatePassword(new_password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const match = await bcrypt.compare(current_password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });

  const hash = await bcrypt.hash(new_password, 12);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(hash, req.session.userId);

  res.json({ ok: true });
});

// POST /api/auth/forgot-password — always 200 to avoid user enumeration
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const user = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email.trim());
  if (user) {
    const token     = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    db.transaction(() => {
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
      db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(user.id, tokenHash, expiresAt);
    })();

    const baseUrl   = `${req.protocol}://${req.get('host')}`;
    const resetLink = `${baseUrl}/#reset?token=${token}`;

    try {
      const { sendPasswordReset } = require('../services/emailService');
      await sendPasswordReset(email.trim(), resetLink);
    } catch (err) {
      console.error('[password-reset] Failed to send email:', err.message);
    }
  }

  res.json({ ok: true, message: 'If that email is on file, a reset link has been sent.' });
});

// POST /api/auth/reset-password — validates token, updates password
router.post('/reset-password', async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) return res.status(400).json({ error: 'Token and new password are required.' });

  const pwErr = validatePassword(new_password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL').get(tokenHash);

  if (!row || new Date(row.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Invalid or expired reset link.' });
  }

  const hash = await bcrypt.hash(new_password, 12);
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, row.user_id);
    db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?").run(row.id);
  })();

  res.json({ ok: true });
});

module.exports = router;
module.exports.validatePassword = validatePassword;
