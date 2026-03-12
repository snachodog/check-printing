'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const multer = require('multer');

const app = express();
const upload = multer({ dest: os.tmpdir() });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api/checks', require('./routes/checks'));
app.use('/api/pdf',    require('./routes/pdf'));

// .mdb import endpoint
app.post('/api/import', upload.single('mdbfile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const tmpPath = req.file.path;
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(__dirname, '../migrations/import-mdb.js'), '--file', tmpPath],
      { encoding: 'utf8', timeout: 120000, env: process.env }
    );
    res.json({ success: true, log: output });
  } catch (err) {
    res.status(500).json({
      error: 'Import failed.',
      log: [err.stdout, err.stderr, err.message].filter(Boolean).join('\n'),
    });
  } finally {
    fs.unlink(tmpPath, () => {});
  }
});

// Account setup endpoint (first-run wizard)
app.post('/api/account/setup', (req, res) => {
  const db = require('./db/database');
  const existing = db.prepare('SELECT id FROM account WHERE id = 1').get();
  if (existing) return res.status(409).json({ error: 'Account already configured.' });

  const {
    company1, company2, company3, company4,
    bank_name, bank_info1, bank_info2, transit_code,
    routing_number, account_number, start_check_no, logo_data,
  } = req.body;

  if (!company1 || !routing_number || !account_number || !start_check_no) {
    return res.status(400).json({ error: 'Organization name, routing number, account number, and starting check number are required.' });
  }
  const checkNo = parseInt(start_check_no, 10);
  if (isNaN(checkNo) || checkNo < 1) {
    return res.status(400).json({ error: 'Starting check number must be a positive integer.' });
  }

  db.prepare(`
    INSERT INTO account (
      bank_name, bank_info1, bank_info2, transit_code,
      routing_number, account_number, start_check_no, current_check_no,
      company1, company2, company3, company4, logo_data
    ) VALUES (
      @bank_name, @bank_info1, @bank_info2, @transit_code,
      @routing_number, @account_number, @start_check_no, @current_check_no,
      @company1, @company2, @company3, @company4, @logo_data
    )
  `).run({
    bank_name:        bank_name || '',
    bank_info1:       bank_info1 || null,
    bank_info2:       bank_info2 || null,
    transit_code:     transit_code || null,
    routing_number,
    account_number,
    start_check_no:   checkNo,
    current_check_no: checkNo,
    company1:         company1 || null,
    company2:         company2 || null,
    company3:         company3 || null,
    company4:         company4 || null,
    logo_data:        logo_data || null,
  });

  res.status(201).json({ success: true });
});

// TODO: Add multi-account support -- account switcher, per-account routing/logo/layout, account_id FK on checks and layout_fields

// TODO: Add basic auth or simple password gate for any network-exposed deployment

// TODO: Add deposit slip support -- deposits table, PDF generation, ledger, and slide-in entry form

// Account info endpoint (read-only for Phase 1)
app.get('/api/account', (req, res) => {
  const db = require('./db/database');
  const account = db.prepare(
    'SELECT id, bank_name, bank_info1, bank_info2, bank_info3, transit_code, ' +
    'routing_number, account_number, current_check_no, ' +
    'company1, company2, company3, company4, check_position FROM account WHERE id = 1'
  ).get();
  if (!account) {
    return res.status(404).json({ error: 'No account configured. Run migration first.' });
  }
  // Never send routing/account numbers in cleartext to the browser in production.
  // For local-only Phase 1 this is acceptable; redact for any network-exposed deployment.
  res.json(account);
});

// Catch-all: serve index.html for client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ezcheck running on http://localhost:${PORT}`);
});

module.exports = app;
