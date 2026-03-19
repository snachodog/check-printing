-- ezcheck SQLite schema

CREATE TABLE IF NOT EXISTS account (
  id                INTEGER PRIMARY KEY,
  bank_name         TEXT NOT NULL,
  bank_info1        TEXT,
  bank_info2        TEXT,
  bank_info3        TEXT,
  transit_code      TEXT,
  routing_number    TEXT NOT NULL,
  account_number    TEXT NOT NULL,
  start_check_no    INTEGER NOT NULL DEFAULT 1000,
  current_check_no  INTEGER NOT NULL DEFAULT 1000,
  check_width       REAL NOT NULL DEFAULT 8.5,
  check_height      REAL NOT NULL DEFAULT 3.5,
  offset_left       REAL NOT NULL DEFAULT 0,
  offset_right      REAL NOT NULL DEFAULT 0,
  offset_up         REAL NOT NULL DEFAULT 0,
  offset_down       REAL NOT NULL DEFAULT 0,
  company1          TEXT,
  company2          TEXT,
  company3          TEXT,
  company4          TEXT,
  logo_data         TEXT,
  signature_data    TEXT,
  second_signature  INTEGER NOT NULL DEFAULT 0,
  blank_stock       INTEGER NOT NULL DEFAULT 1,
  check_position    TEXT NOT NULL DEFAULT '3-per-page',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        INTEGER NOT NULL DEFAULT 1 REFERENCES account(id),
  check_no          INTEGER NOT NULL,
  payee             TEXT NOT NULL,
  amount            REAL NOT NULL,
  check_date        TEXT NOT NULL,
  memo              TEXT,
  note1             TEXT,
  note2             TEXT,
  payee_address1    TEXT,
  payee_address2    TEXT,
  payee_address3    TEXT,
  payee_address4    TEXT,
  printed           INTEGER NOT NULL DEFAULT 0,
  add_date          TEXT NOT NULL DEFAULT (datetime('now')),
  mdb_check_id      INTEGER,
  UNIQUE(account_id, check_no)
);

CREATE TABLE IF NOT EXISTS layout_fields (
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

CREATE INDEX IF NOT EXISTS idx_checks_date      ON checks(check_date);
CREATE INDEX IF NOT EXISTS idx_checks_printed   ON checks(printed);
CREATE INDEX IF NOT EXISTS idx_checks_check_no  ON checks(check_no);

CREATE TABLE IF NOT EXISTS deposits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES account(id),
  deposit_date  TEXT NOT NULL,
  currency      REAL NOT NULL DEFAULT 0,
  coin          REAL NOT NULL DEFAULT 0,
  cash_back     REAL NOT NULL DEFAULT 0,
  printed       INTEGER NOT NULL DEFAULT 0,
  add_date      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deposit_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  deposit_id  INTEGER NOT NULL REFERENCES deposits(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  check_no    TEXT,
  bank_no     TEXT,
  payee       TEXT,
  memo        TEXT,
  amount      REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_deposits_account ON deposits(account_id);
CREATE INDEX IF NOT EXISTS idx_deposit_items    ON deposit_items(deposit_id);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin','editor','viewer')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_accounts (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('editor','viewer')),
  PRIMARY KEY (user_id, account_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  sess    TEXT NOT NULL,
  expired INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
