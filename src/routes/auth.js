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

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Sliding-window counter per key (IP). After `max` hits within `windowMs`,
// further attempts are blocked until the window resets.
function makeRateLimiter(max, windowMs) {
  const attempts = new Map(); // key -> { count, resetAt }

  // Purge stale entries every 30 minutes to prevent unbounded memory growth
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of attempts) {
      if (now > entry.resetAt) attempts.delete(key);
    }
  }, 30 * 60 * 1000).unref();

  return {
    allowed(key) {
      const entry = attempts.get(key);
      if (!entry || Date.now() > entry.resetAt) return true;
      return entry.count < max;
    },
    record(key) {
      const now   = Date.now();
      const entry = attempts.get(key);
      if (!entry || now > entry.resetAt) {
        attempts.set(key, { count: 1, resetAt: now + windowMs });
      } else {
        entry.count++;
      }
    },
    clear(key) {
      attempts.delete(key);
    },
  };
}

// 10 failed logins per IP per 15 minutes
const loginLimiter = makeRateLimiter(10, 15 * 60 * 1000);
// 5 reset emails per IP per 15 minutes (counts every request, success or not)
const resetLimiter = makeRateLimiter(5, 15 * 60 * 1000);

// Regenerates the session ID before establishing a login (prevents session fixation)
function establishSession(req, user, cb) {
  req.session.regenerate(err => {
    if (err) return cb(err);
    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.role     = user.role;
    cb(null);
  });
}

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

  const user = { id: result.lastInsertRowid, username: username.trim(), role: 'admin' };
  establishSession(req, user, err => {
    if (err) return res.status(500).json({ error: 'Failed to create session.' });
    res.status(201).json(user);
  });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (!loginLimiter.allowed(ip)) {
    return res.status(429).json({ error: 'Too many failed login attempts. Please try again later.' });
  }

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username.trim());
  if (!user) {
    loginLimiter.record(ip);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    loginLimiter.record(ip);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  loginLimiter.clear(ip);
  establishSession(req, user, err => {
    if (err) return res.status(500).json({ error: 'Failed to create session.' });
    res.json({ id: user.id, username: user.username, role: user.role });
  });
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
  const user = db.prepare('SELECT oidc_sub FROM users WHERE id = ?').get(req.session.userId);
  res.json({
    id: req.session.userId,
    username: req.session.username,
    role: req.session.role,
    oidc_linked: !!(user && user.oidc_sub),
  });
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
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!resetLimiter.allowed(ip)) {
    return res.status(429).json({ error: 'Too many reset requests. Please try again later.' });
  }
  resetLimiter.record(ip);

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

    // Prefer the configured base URL; deriving it from the Host header lets an
    // attacker poison reset links (host header injection)
    const baseUrl   = (process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
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

// ── OIDC helpers ─────────────────────────────────────────────────────────────

function getOidcSettings() {
  return {
    enabled:       process.env.OIDC_ENABLED === '1' || process.env.OIDC_ENABLED === 'true',
    discovery_url: process.env.OIDC_DISCOVERY_URL || '',
    client_id:     process.env.OIDC_CLIENT_ID     || '',
    client_secret: process.env.OIDC_CLIENT_SECRET || '',
    redirect_uri:  process.env.OIDC_REDIRECT_URI  || '',
    button_label:  process.env.OIDC_BUTTON_LABEL  || 'Sign in with SSO',
  };
}

async function getOidcClient(settings) {
  const { Issuer } = require('openid-client');
  const issuer = await Issuer.discover(settings.discovery_url);
  return new issuer.Client({
    client_id:     settings.client_id,
    client_secret: settings.client_secret,
    redirect_uris: [settings.redirect_uri],
    response_types: ['code'],
  });
}

// GET /api/auth/oidc/config — public, returns whether OIDC is enabled + button label
router.get('/oidc/config', (req, res) => {
  const s = getOidcSettings();
  res.json({ enabled: s.enabled, button_label: s.button_label });
});

// GET /api/auth/oidc/authorize — initiates the OIDC flow (redirect to provider)
router.get('/oidc/authorize', async (req, res) => {
  try {
    const settings = getOidcSettings();
    if (!settings.enabled) return res.status(400).json({ error: 'OIDC is not enabled.' });

    const { generators } = require('openid-client');
    const client = await getOidcClient(settings);

    const code_verifier = generators.codeVerifier();
    const code_challenge = generators.codeChallenge(code_verifier);
    const state = generators.state();
    const nonce = generators.nonce();

    req.session.oidc = { code_verifier, state, nonce };

    const authUrl = client.authorizationUrl({
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge,
      code_challenge_method: 'S256',
    });

    // Ensure session is persisted before redirecting (saveUninitialized is false)
    req.session.save(() => res.redirect(authUrl));
  } catch (err) {
    console.error('[oidc] authorize error:', err.message);
    res.redirect('/#oidc-error=' + encodeURIComponent('Failed to initiate SSO login.'));
  }
});

// GET /api/auth/oidc/callback — handles the provider redirect
router.get('/oidc/callback', async (req, res) => {
  try {
    const settings = getOidcSettings();
    if (!settings.enabled) return res.redirect('/#oidc-error=' + encodeURIComponent('OIDC is not enabled.'));

    const oidcSession = req.session.oidc;
    if (!oidcSession) {
      console.error('[oidc] callback: no oidc session data found — session may have expired or cookie lost');
      return res.redirect('/#oidc-error=' + encodeURIComponent('Session expired. Please try again.'));
    }

    const client = await getOidcClient(settings);
    const params = client.callbackParams(req);

    const tokenSet = await client.callback(settings.redirect_uri, params, {
      code_verifier: oidcSession.code_verifier,
      state:         oidcSession.state,
      nonce:         oidcSession.nonce,
    });

    const claims = tokenSet.claims();
    const sub    = claims.sub;
    const issuer = claims.iss;

    delete req.session.oidc;

    // Self-service linking flow
    if (oidcSession.linking && oidcSession.linkUserId) {
      const existing = db.prepare(
        'SELECT id FROM users WHERE oidc_issuer = ? AND oidc_sub = ? AND id != ?'
      ).get(issuer, sub, oidcSession.linkUserId);
      if (existing) {
        return res.redirect('/#oidc-error=' + encodeURIComponent('This identity is already linked to another account.'));
      }

      db.prepare("UPDATE users SET oidc_sub = ?, oidc_issuer = ?, updated_at = datetime('now') WHERE id = ?")
        .run(sub, issuer, oidcSession.linkUserId);
      console.log('[oidc] linked identity to userId=%s', oidcSession.linkUserId);
      return res.redirect('/#oidc-linked');
    }

    // Login flow — look up user by OIDC identity
    const user = db.prepare(
      'SELECT id, username, role FROM users WHERE oidc_issuer = ? AND oidc_sub = ?'
    ).get(issuer, sub);

    if (!user) {
      console.warn('[oidc] callback: identity not linked to any user');
      return res.redirect('/#oidc-error=' + encodeURIComponent(
        'No account is linked to this identity. Ask an admin to link your account, or sign in with your password and link it yourself.'
      ));
    }

    console.log('[oidc] login success for userId=%s', user.id);
    establishSession(req, user, err => {
      if (err) return res.redirect('/#oidc-error=' + encodeURIComponent('SSO login failed. Please try again.'));
      // Load account access into session (mirrors login behavior)
      if (user.role !== 'admin') {
        req.session.accounts = db.prepare('SELECT account_id, role FROM user_accounts WHERE user_id = ?').all(user.id);
      }
      res.redirect('/');
    });
  } catch (err) {
    console.error('[oidc] callback error:', err.message);
    res.redirect('/#oidc-error=' + encodeURIComponent('SSO login failed. Please try again.'));
  }
});

// GET /api/auth/oidc/link — logged-in user initiates linking flow
router.get('/oidc/link', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/#oidc-error=' + encodeURIComponent('You must be signed in to link your account.'));
  }

  try {
    const settings = getOidcSettings();
    if (!settings.enabled) return res.redirect('/#oidc-error=' + encodeURIComponent('OIDC is not enabled.'));

    const { generators } = require('openid-client');
    const client = await getOidcClient(settings);

    const code_verifier = generators.codeVerifier();
    const code_challenge = generators.codeChallenge(code_verifier);
    const state = generators.state();
    const nonce = generators.nonce();

    req.session.oidc = { code_verifier, state, nonce, linking: true, linkUserId: req.session.userId };

    const authUrl = client.authorizationUrl({
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge,
      code_challenge_method: 'S256',
    });

    req.session.save(() => res.redirect(authUrl));
  } catch (err) {
    console.error('[oidc] link error:', err.message);
    res.redirect('/#oidc-error=' + encodeURIComponent('Failed to initiate SSO linking.'));
  }
});

// POST /api/auth/oidc/unlink — logged-in user removes their own OIDC link
router.post('/oidc/unlink', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  db.prepare("UPDATE users SET oidc_sub = NULL, oidc_issuer = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(req.session.userId);
  res.json({ ok: true });
});

module.exports = router;
module.exports.validatePassword = validatePassword;
