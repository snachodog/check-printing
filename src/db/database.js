'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/ezcheck.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema on first run
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// --- Runtime migrations for schema upgrades ---

// Migration: add account_id to checks, fix UNIQUE to be per-account
const checksInfo = db.prepare('PRAGMA table_info(checks)').all();
if (!checksInfo.some(c => c.name === 'account_id')) {
  db.exec(`
    ALTER TABLE checks RENAME TO checks_old;
    CREATE TABLE checks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id     INTEGER NOT NULL DEFAULT 1 REFERENCES account(id),
      check_no       INTEGER NOT NULL,
      payee          TEXT NOT NULL,
      amount         REAL NOT NULL,
      check_date     TEXT NOT NULL,
      memo           TEXT,
      note1          TEXT,
      note2          TEXT,
      payee_address1 TEXT,
      payee_address2 TEXT,
      payee_address3 TEXT,
      payee_address4 TEXT,
      printed        INTEGER NOT NULL DEFAULT 0,
      add_date       TEXT NOT NULL DEFAULT (datetime('now')),
      mdb_check_id   INTEGER,
      UNIQUE(account_id, check_no)
    );
    INSERT INTO checks (id, account_id, check_no, payee, amount, check_date, memo, note1, note2,
      payee_address1, payee_address2, payee_address3, payee_address4, printed, add_date, mdb_check_id)
    SELECT id, 1, check_no, payee, amount, check_date, memo, note1, note2,
      payee_address1, payee_address2, payee_address3, payee_address4, printed, add_date, mdb_check_id
    FROM checks_old;
    DROP TABLE checks_old;
    CREATE INDEX IF NOT EXISTS idx_checks_date     ON checks(check_date);
    CREATE INDEX IF NOT EXISTS idx_checks_printed  ON checks(printed);
    CREATE INDEX IF NOT EXISTS idx_checks_check_no ON checks(check_no);
    CREATE INDEX IF NOT EXISTS idx_checks_account  ON checks(account_id);
  `);
}

// Migration: add account_id to layout_fields, change UNIQUE to per-account
const lfInfo = db.prepare('PRAGMA table_info(layout_fields)').all();
if (!lfInfo.some(c => c.name === 'account_id')) {
  db.exec(`
    ALTER TABLE layout_fields RENAME TO layout_fields_old;
    CREATE TABLE layout_fields (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id       INTEGER NOT NULL DEFAULT 1 REFERENCES account(id),
      field_name       TEXT NOT NULL,
      field_text       TEXT,
      font_name        TEXT NOT NULL DEFAULT 'Helvetica',
      font_size        REAL NOT NULL DEFAULT 10,
      font_bold        INTEGER NOT NULL DEFAULT 0,
      field_type       TEXT NOT NULL DEFAULT 'Regular',
      line_thick       INTEGER NOT NULL DEFAULT 1,
      x_pos            REAL NOT NULL DEFAULT 0,
      y_pos            REAL NOT NULL DEFAULT 0,
      x_end_pos        REAL NOT NULL DEFAULT 0,
      y_end_pos        REAL NOT NULL DEFAULT 0,
      visible          INTEGER NOT NULL DEFAULT 1,
      not_for_preprint INTEGER NOT NULL DEFAULT 0,
      UNIQUE(account_id, field_name)
    );
    INSERT INTO layout_fields (id, account_id, field_name, field_text, font_name, font_size, font_bold,
      field_type, line_thick, x_pos, y_pos, x_end_pos, y_end_pos, visible, not_for_preprint)
    SELECT id, 1, field_name, field_text, font_name, font_size, font_bold,
      field_type, line_thick, x_pos, y_pos, x_end_pos, y_end_pos, visible, not_for_preprint
    FROM layout_fields_old;
    DROP TABLE layout_fields_old;
    CREATE INDEX IF NOT EXISTS idx_layout_account ON layout_fields(account_id);
  `);
}

// Migration: add second_signature column to account
const acctInfo = db.prepare('PRAGMA table_info(account)').all();
if (!acctInfo.some(c => c.name === 'second_signature')) {
  db.exec('ALTER TABLE account ADD COLUMN second_signature INTEGER NOT NULL DEFAULT 0');
}

// Migration: add role column to user_accounts
const uaInfo = db.prepare('PRAGMA table_info(user_accounts)').all();
if (!uaInfo.some(c => c.name === 'role')) {
  db.exec(`
    ALTER TABLE user_accounts RENAME TO user_accounts_old;
    CREATE TABLE user_accounts (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES account(id) ON DELETE CASCADE,
      role       TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('editor','viewer')),
      PRIMARY KEY (user_id, account_id)
    );
    INSERT INTO user_accounts (user_id, account_id, role)
    SELECT user_id, account_id, 'editor' FROM user_accounts_old;
    DROP TABLE user_accounts_old;
  `);
}

// Create account_id indexes unconditionally (safe after migrations have run)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_checks_account ON checks(account_id);
  CREATE INDEX IF NOT EXISTS idx_layout_account ON layout_fields(account_id);
`);

// Migration: add email column to users
const usersInfo = db.prepare('PRAGMA table_info(users)').all();
if (!usersInfo.some(c => c.name === 'email')) {
  db.exec('ALTER TABLE users ADD COLUMN email TEXT');
}

// Migration: create password_reset_tokens table
db.exec(`
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  )
`);

// Migration: create settings table
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  )
`);

// Default layout fields used for seeding and migration.
const DEFAULT_LAYOUT_FIELDS = [
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
    { field_name: 'Payee Line',        field_type: 'Line', x_pos: 2.10, y_pos: 1.00, x_end_pos: 6.70, y_end_pos: 1.00, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Amount Box Top',    field_type: 'Line', x_pos: 6.75, y_pos: 0.70, x_end_pos: 8.30, y_end_pos: 0.70, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Amount Box Left',   field_type: 'Line', x_pos: 6.75, y_pos: 0.70, x_end_pos: 6.75, y_end_pos: 1.05, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Amount Box Bottom', field_type: 'Line', x_pos: 6.75, y_pos: 1.05, x_end_pos: 8.30, y_end_pos: 1.05, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Text Amount Line',  field_type: 'Line', x_pos: 0.30, y_pos: 1.48, x_end_pos: 6.30, y_end_pos: 1.48, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Memo Line',         field_type: 'Line', x_pos: 0.68, y_pos: 3.00, x_end_pos: 4.00, y_end_pos: 3.00, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
    { field_name: 'Signature Line',    field_type: 'Line', x_pos: 5.00, y_pos: 3.10, x_end_pos: 8.20, y_end_pos: 3.10, font_name: 'Helvetica', font_size: 10, font_bold: 0, field_text: null, line_thick: 1, visible: 1 },
  ];

function seedLayoutFields(accountId) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO layout_fields
      (account_id, field_name, field_text, font_name, font_size, font_bold,
       field_type, line_thick, x_pos, y_pos, x_end_pos, y_end_pos, visible)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const f of DEFAULT_LAYOUT_FIELDS) {
      insert.run(accountId, f.field_name, f.field_text, f.font_name, f.font_size, f.font_bold,
        f.field_type, f.line_thick, f.x_pos, f.y_pos, f.x_end_pos, f.y_end_pos, f.visible);
    }
  })();
}

// Migration: reset all accounts to default layout (runs once, gated by settings key).
// Replaces any .mdb-imported or legacy layout_fields with the clean default layout.
if (!db.prepare("SELECT value FROM settings WHERE key = 'layout_reset_v1'").get()) {
  const accounts = db.prepare('SELECT id FROM account').all();
  db.transaction(() => {
    for (const { id } of accounts) {
      db.prepare('DELETE FROM layout_fields WHERE account_id = ?').run(id);
      seedLayoutFields(id);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('layout_reset_v1', '1')").run();
  })();
}

// Migration: seed default layout fields for any account that has none (ongoing, idempotent).
(function seedMissingLayoutFields() {
  const accounts = db.prepare('SELECT id FROM account').all();
  for (const { id } of accounts) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM layout_fields WHERE account_id = ?').get(id);
    if (n === 0) seedLayoutFields(id);
  }
})();

module.exports = db;
module.exports.seedLayoutFields = seedLayoutFields;
