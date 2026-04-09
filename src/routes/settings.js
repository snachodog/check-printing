'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

// GET /api/settings/smtp
router.get('/smtp', (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'smtp_%'").all();
  const s = Object.fromEntries(rows.map(r => [r.key.replace('smtp_', ''), r.value || '']));
  res.json({
    host:         s.host   || '',
    port:         s.port   || '587',
    secure:       s.secure === '1',
    user:         s.user   || '',
    from:         s.from   || '',
    has_password: !!(rows.find(r => r.key === 'smtp_pass') || {}).value,
  });
});

// PUT /api/settings/smtp
router.put('/smtp', (req, res) => {
  const { host, port, secure, user, pass, from } = req.body;
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    upsert.run('smtp_host',   host || '');
    upsert.run('smtp_port',   String(parseInt(port, 10) || 587));
    upsert.run('smtp_secure', secure ? '1' : '0');
    upsert.run('smtp_user',   user || '');
    if (pass !== undefined && pass !== '') upsert.run('smtp_pass', pass);
    upsert.run('smtp_from',   from || '');
  })();
  res.json({ ok: true });
});

// GET /api/settings/oidc
router.get('/oidc', (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'oidc_%'").all();
  const s = Object.fromEntries(rows.map(r => [r.key.replace('oidc_', ''), r.value || '']));
  res.json({
    enabled:       s.enabled === '1',
    discovery_url: s.discovery_url || '',
    client_id:     s.client_id     || '',
    redirect_uri:  s.redirect_uri  || '',
    button_label:  s.button_label  || 'Sign in with SSO',
    has_secret:    !!(rows.find(r => r.key === 'oidc_client_secret') || {}).value,
  });
});

// PUT /api/settings/oidc
router.put('/oidc', (req, res) => {
  const { enabled, discovery_url, client_id, client_secret, redirect_uri, button_label } = req.body;
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    upsert.run('oidc_enabled',       enabled ? '1' : '0');
    upsert.run('oidc_discovery_url', discovery_url || '');
    upsert.run('oidc_client_id',     client_id     || '');
    upsert.run('oidc_redirect_uri',  redirect_uri  || '');
    upsert.run('oidc_button_label',  button_label  || 'Sign in with SSO');
    if (client_secret !== undefined && client_secret !== '') {
      upsert.run('oidc_client_secret', client_secret);
    }
  })();
  res.json({ ok: true });
});

module.exports = router;
