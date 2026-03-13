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

// Create account_id indexes unconditionally (safe after migrations have run)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_checks_account ON checks(account_id);
  CREATE INDEX IF NOT EXISTS idx_layout_account ON layout_fields(account_id);
`);

module.exports = db;
