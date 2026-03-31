'use strict';

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const crypto    = require('crypto');
const { execFileSync } = require('child_process');
const multer    = require('multer');
const session   = require('express-session');

const db     = require('./db/database');
const { requireAuth, requireAdmin, canAccessAccount } = require('./middleware/auth');

const app    = express();
const upload = multer({ dest: os.tmpdir() });

// ── Session store (SQLite-backed, no extra packages) ──────────────────────────
const SessionStore = require('./lib/SessionStore');

if (!process.env.SESSION_SECRET) {
  console.error('[fatal] SESSION_SECRET environment variable is not set. See .env.example. Exiting.');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET;

const SESSION_MAX_AGE_MS = (parseInt(process.env.SESSION_MAX_AGE_HOURS, 10) || 168) * 60 * 60 * 1000;

app.use(session({
  store: new SessionStore(db),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', maxAge: SESSION_MAX_AGE_MS },
}));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // style-src unsafe-inline: required for inline style= attrs in JS-generated HTML
  // img-src data: required for base64-embedded logos and signatures
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'");
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ── Auth routes (public — no requireAuth) ─────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));

// ── All routes below require authentication ───────────────────────────────────
app.use('/api', requireAuth);

// ── User management (admin only) ──────────────────────────────────────────────
app.use('/api/users', require('./routes/users'));

// ── App settings (admin only) ─────────────────────────────────────────────────
app.use('/api/settings', require('./routes/settings'));

// ── Check routes ──────────────────────────────────────────────────────────────
app.use('/api/checks', require('./routes/checks'));

// ── PDF (per-account editor check inside route) ───────────────────────────────
app.use('/api/pdf', require('./routes/pdf'));

// ── Deposits ──────────────────────────────────────────────────────────────────
app.use('/api/deposits',    require('./routes/deposits'));
app.use('/api/deposit-pdf', require('./routes/deposit-pdf'));

// ── QBO import (per-account editor check inside route) ────────────────────────
app.use('/api/qbo-import', require('./routes/qbo-import'));

// ── Accounts list — filtered by role ─────────────────────────────────────────
app.get('/api/accounts', (req, res) => {
  let accounts;
  if (req.session.role === 'admin') {
    accounts = db.prepare(
      'SELECT id, company1, bank_name, current_check_no FROM account ORDER BY id ASC'
    ).all();
    // Admins have editor access to all accounts
    accounts.forEach(a => { a.user_role = 'editor'; });
  } else {
    accounts = db.prepare(`
      SELECT a.id, a.company1, a.bank_name, a.current_check_no, ua.role AS user_role
      FROM account a
      JOIN user_accounts ua ON ua.account_id = a.id
      WHERE ua.user_id = ?
      ORDER BY a.id ASC
    `).all(req.session.userId);
  }
  res.json(accounts);
});

// ── Account settings (admin only) ─────────────────────────────────────────────
app.put('/api/account/:id', requireAdmin, (req, res) => {
  const account = db.prepare('SELECT id FROM account WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  const {
    company1, company2, company3, company4,
    bank_name, bank_info1, bank_info2, bank_info3, transit_code,
    routing_number, account_number,
    offset_left, offset_right, offset_up, offset_down,
    logo_data, second_signature,
  } = req.body;

  if (!company1 || !routing_number || !account_number) {
    return res.status(400).json({ error: 'Organization name, routing number, and account number are required.' });
  }
  const MAX_IMAGE_BYTES = 512 * 1024; // 512 KB base64 limit
  if (logo_data && Buffer.byteLength(logo_data, 'utf8') > MAX_IMAGE_BYTES) {
    return res.status(400).json({ error: 'Logo image must be smaller than 512 KB.' });
  }

  db.prepare(`
    UPDATE account SET
      company1 = ?, company2 = ?, company3 = ?, company4 = ?,
      bank_name = ?, bank_info1 = ?, bank_info2 = ?, bank_info3 = ?, transit_code = ?,
      routing_number = ?, account_number = ?,
      offset_left = ?, offset_right = ?, offset_up = ?, offset_down = ?,
      second_signature = ?,
      logo_data = CASE WHEN ? IS NOT NULL THEN ? ELSE logo_data END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    company1 || null, company2 || null, company3 || null, company4 || null,
    bank_name || '', bank_info1 || null, bank_info2 || null, bank_info3 || null, transit_code || null,
    routing_number, account_number,
    parseFloat(offset_left) || 0, parseFloat(offset_right) || 0,
    parseFloat(offset_up) || 0, parseFloat(offset_down) || 0,
    second_signature ? 1 : 0,
    logo_data || null, logo_data || null,
    req.params.id
  );

  res.json(db.prepare(
    'SELECT id, bank_name, bank_info1, bank_info2, bank_info3, transit_code, ' +
    'routing_number, account_number, current_check_no, ' +
    'company1, company2, company3, company4, check_position, second_signature FROM account WHERE id = ?'
  ).get(req.params.id));
});

// GET /api/account/:id — any authenticated user with access
// Routing/account numbers are only returned to admins (non-admins don't need them client-side)
app.get('/api/account/:id', (req, res) => {
  if (!canAccessAccount(req.session, parseInt(req.params.id, 10))) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  const isAdmin = req.session.role === 'admin';
  const cols = isAdmin
    ? 'id, bank_name, bank_info1, bank_info2, bank_info3, transit_code, routing_number, account_number, current_check_no, company1, company2, company3, company4, check_position, second_signature'
    : 'id, bank_name, bank_info1, bank_info2, bank_info3, transit_code, current_check_no, company1, company2, company3, company4, check_position, second_signature';
  const account = db.prepare(`SELECT ${cols} FROM account WHERE id = ?`).get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  res.json(account);
});

// PUT /api/account/:id/check-no (admin only)
app.put('/api/account/:id/check-no', requireAdmin, (req, res) => {
  const account = db.prepare('SELECT id FROM account WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  const next = parseInt(req.body.next_check_no, 10);
  if (isNaN(next) || next < 1) {
    return res.status(400).json({ error: 'Next check number must be a positive integer.' });
  }

  db.prepare("UPDATE account SET current_check_no = ?, updated_at = datetime('now') WHERE id = ?")
    .run(next - 1, req.params.id);

  res.json({ next_check_no: next });
});

// DELETE /api/account/:id (admin only)
app.delete('/api/account/:id', requireAdmin, (req, res) => {
  const account = db.prepare('SELECT id FROM account WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  db.transaction(() => {
    db.prepare('DELETE FROM deposits WHERE account_id = ?').run(req.params.id);
    db.prepare('DELETE FROM checks WHERE account_id = ?').run(req.params.id);
    db.prepare('DELETE FROM layout_fields WHERE account_id = ?').run(req.params.id);
    db.prepare('DELETE FROM user_accounts WHERE account_id = ?').run(req.params.id);
    db.prepare('DELETE FROM account WHERE id = ?').run(req.params.id);
  })();

  res.status(204).end();
});

// Default layout fields for manually-created accounts (no .mdb import).
// Coordinates are in inches from the top-left of each check slot (8.5" × 3.5").
// Field names for type 'Regular' must match the keys in pdfService.resolveFieldValue.
function seedDefaultLayoutFields(accountId) {
  const fields = [
    // Company block — top left
    { field_name: 'Company Name',  field_type: 'Regular', x_pos: 0.50, y_pos: 0.12, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica-Bold', font_size: 10, font_bold: 1, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Company Name2', field_type: 'Regular', x_pos: 0.50, y_pos: 0.30, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica',      font_size: 9,  font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Company Name3', field_type: 'Regular', x_pos: 0.50, y_pos: 0.44, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica',      font_size: 9,  font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Company Name4', field_type: 'Regular', x_pos: 0.50, y_pos: 0.58, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica',      font_size: 9,  font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    // Check number — top right
    { field_name: 'Check Number',  field_type: 'Regular', x_pos: 7.20, y_pos: 0.12, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica-Bold', font_size: 10, font_bold: 1, field_text: null, line_thick: 1, visible: 1 },
    // Date — upper right
    { field_name: 'Date Label',    field_type: 'Text',    x_pos: 5.80, y_pos: 0.40, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica',      font_size: 8,  font_bold: 0, field_text: 'DATE', line_thick: 1, visible: 1 },
    { field_name: 'Date',          field_type: 'Regular', x_pos: 6.30, y_pos: 0.40, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica',      font_size: 9,  font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    // Pay to the order of
    { field_name: 'Pay To Label',  field_type: 'Text',    x_pos: 0.30, y_pos: 0.82, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica',      font_size: 7,  font_bold: 0, field_text: 'PAY TO THE ORDER OF', line_thick: 1, visible: 1 },
    { field_name: 'Payee Name',    field_type: 'Regular', x_pos: 2.15, y_pos: 0.80, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica',      font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    // Amount box
    { field_name: 'Dollar Sign',   field_type: 'Text',    x_pos: 6.80, y_pos: 0.80, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica',      font_size: 10, font_bold: 0, field_text: '$', line_thick: 1, visible: 1 },
    { field_name: 'Amount',        field_type: 'Regular', x_pos: 6.95, y_pos: 0.80, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica-Bold', font_size: 10, font_bold: 1, field_text: null, line_thick: 1, visible: 1 },
    // Written amount
    { field_name: 'Text Amount',   field_type: 'Regular', x_pos: 0.30, y_pos: 1.28, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica',      font_size: 9,  font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Dollars Label', field_type: 'Text',    x_pos: 6.30, y_pos: 1.28, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica',      font_size: 8,  font_bold: 0, field_text: 'DOLLARS', line_thick: 1, visible: 1 },
    // Bank info block
    { field_name: 'Bank Information',  field_type: 'Regular', x_pos: 0.30, y_pos: 1.82, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica', font_size: 8,  font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Bank Transit Code', field_type: 'Regular', x_pos: 0.30, y_pos: 2.38, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica', font_size: 7,  font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    // Payee address — center window area (for windowed envelopes)
    { field_name: 'Payee Address', field_type: 'Regular', x_pos: 3.50, y_pos: 1.82, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica',      font_size: 9,  font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    // Memo
    { field_name: 'Memo Label',    field_type: 'Text',    x_pos: 0.30, y_pos: 2.82, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica',      font_size: 7,  font_bold: 0, field_text: 'MEMO', line_thick: 1, visible: 1 },
    { field_name: 'Memo',          field_type: 'Regular', x_pos: 0.72, y_pos: 2.82, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica',      font_size: 9,  font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    // Auth signature label
    { field_name: 'Auth Signature Label', field_type: 'Text', x_pos: 5.00, y_pos: 3.14, x_end_pos: 0, y_end_pos: 0, font_name: 'Helvetica', font_size: 6,  font_bold: 0, field_text: 'AUTHORIZED SIGNATURE', line_thick: 1, visible: 1 },
    // Lines
    { field_name: 'Payee Line',       field_type: 'Line', x_pos: 2.10, y_pos: 1.00, x_end_pos: 6.70, y_end_pos: 1.00, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Amount Box Top',   field_type: 'Line', x_pos: 6.75, y_pos: 0.70, x_end_pos: 8.30, y_end_pos: 0.70, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Amount Box Left',  field_type: 'Line', x_pos: 6.75, y_pos: 0.70, x_end_pos: 6.75, y_end_pos: 1.05, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Amount Box Bottom',field_type: 'Line', x_pos: 6.75, y_pos: 1.05, x_end_pos: 8.30, y_end_pos: 1.05, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Text Amount Line', field_type: 'Line', x_pos: 0.30, y_pos: 1.48, x_end_pos: 6.30, y_end_pos: 1.48, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Memo Line',        field_type: 'Line', x_pos: 0.68, y_pos: 3.00, x_end_pos: 4.00, y_end_pos: 3.00, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Signature Line',   field_type: 'Line', x_pos: 5.00, y_pos: 3.10, x_end_pos: 8.20, y_end_pos: 3.10, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO layout_fields
      (account_id, field_name, field_text, font_name, font_size, font_bold,
       field_type, line_thick, x_pos, y_pos, x_end_pos, y_end_pos, visible)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const f of fields) {
      stmt.run(accountId, f.field_name, f.field_text, f.font_name, f.font_size, f.font_bold,
               f.field_type, f.line_thick, f.x_pos, f.y_pos, f.x_end_pos, f.y_end_pos, f.visible);
    }
  })();
}

// POST /api/account/setup (admin only — creates a new checking account)
app.post('/api/account/setup', requireAdmin, (req, res) => {
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

  seedDefaultLayoutFields(result.lastInsertRowid);

  res.status(201).json({ success: true, accountId: result.lastInsertRowid });
});

// .mdb import (admin only)
app.post('/api/import', requireAdmin, upload.single('mdbfile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const tmpPath = req.file.path;
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(__dirname, '../migrations/import-mdb.js'), '--file', tmpPath],
      { encoding: 'utf8', timeout: 120000, env: process.env }
    );
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

// Catch-all: serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ezcheck running on http://localhost:${PORT}`);
});

module.exports = app;
