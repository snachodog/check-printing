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

// GET /api/accounts - list all accounts (id + display name)
app.get('/api/accounts', (req, res) => {
  const db = require('./db/database');
  const accounts = db.prepare(
    'SELECT id, company1, bank_name, current_check_no FROM account ORDER BY id ASC'
  ).all();
  res.json(accounts);
});

// GET /api/account/:id - get full account by id
app.get('/api/account/:id', (req, res) => {
  const db = require('./db/database');
  const account = db.prepare(
    'SELECT id, bank_name, bank_info1, bank_info2, bank_info3, transit_code, ' +
    'routing_number, account_number, current_check_no, ' +
    'company1, company2, company3, company4, check_position FROM account WHERE id = ?'
  ).get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  res.json(account);
});

// POST /api/account/setup - create a new account (wizard)
app.post('/api/account/setup', (req, res) => {
  const db = require('./db/database');
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

  const result = db.prepare(`
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

  res.status(201).json({ success: true, accountId: result.lastInsertRowid });
});

// TODO: Add basic auth or simple password gate for any network-exposed deployment

// TODO: Add deposit slip support -- deposits table, PDF generation, ledger, and slide-in entry form

// .mdb import endpoint — always creates a new account
app.post('/api/import', upload.single('mdbfile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const db = require('./db/database');
  const tmpPath = req.file.path;
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(__dirname, '../migrations/import-mdb.js'), '--file', tmpPath],
      { encoding: 'utf8', timeout: 120000, env: process.env }
    );
    // Grab the newly created account (highest id)
    const newAccount = db.prepare('SELECT id, company1 FROM account ORDER BY id DESC LIMIT 1').get();
    res.json({ success: true, log: output, newAccountId: newAccount ? newAccount.id : null });
  } catch (err) {
    res.status(500).json({
      error: 'Import failed.',
      log: [err.stdout, err.stderr, err.message].filter(Boolean).join('\n'),
    });
  } finally {
    fs.unlink(tmpPath, () => {});
  }
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
