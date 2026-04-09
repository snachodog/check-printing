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

module.exports = router;
