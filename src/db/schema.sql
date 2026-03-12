-- ezcheck SQLite schema
-- Mirrors .mdb structure (T100, T104, T200) with readable column names.
-- One account per database is the Phase 1 assumption.
-- Phase 2 will add foreign keys and an account switcher.

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
  -- Per-check offset adjustments in inches (for printer calibration)
  offset_left       REAL NOT NULL DEFAULT 0,
  offset_right      REAL NOT NULL DEFAULT 0,
  offset_up         REAL NOT NULL DEFAULT 0,
  offset_down       REAL NOT NULL DEFAULT 0,
  -- Company info lines (printed top-left of check)
  company1          TEXT,
  company2          TEXT,
  company3          TEXT,
  company4          TEXT,
  -- Images stored as base64 data URIs
  logo_data         TEXT,
  signature_data    TEXT,
  -- Metadata
  blank_stock       INTEGER NOT NULL DEFAULT 1,  -- 1 = blank check stock
  check_position    TEXT NOT NULL DEFAULT '3-per-page',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  check_no          INTEGER NOT NULL,
  payee             TEXT NOT NULL,
  amount            REAL NOT NULL,
  check_date        TEXT NOT NULL,  -- ISO date string YYYY-MM-DD
  memo              TEXT,
  note1             TEXT,
  note2             TEXT,
  payee_address1    TEXT,
  payee_address2    TEXT,
  payee_address3    TEXT,
  payee_address4    TEXT,
  printed           INTEGER NOT NULL DEFAULT 0,  -- 0 = not printed, 1 = printed
  add_date          TEXT NOT NULL DEFAULT (datetime('now')),
  -- original .mdb CheckID preserved if migrated, null if created in app
  mdb_check_id      INTEGER,
  UNIQUE(check_no)
);

CREATE TABLE IF NOT EXISTS layout_fields (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  field_name    TEXT NOT NULL UNIQUE,
  field_text    TEXT,       -- static label text (for Text type fields)
  font_name     TEXT NOT NULL DEFAULT 'Helvetica',
  font_size     REAL NOT NULL DEFAULT 10,
  -- FldFontType from .mdb: 0=normal, 1=bold
  font_bold     INTEGER NOT NULL DEFAULT 0,
  -- FldType: 'Regular' (data), 'Text' (static label), 'Graph' (image), 'Line'
  field_type    TEXT NOT NULL DEFAULT 'Regular',
  line_thick    INTEGER NOT NULL DEFAULT 1,
  x_pos         REAL NOT NULL DEFAULT 0,
  y_pos         REAL NOT NULL DEFAULT 0,
  x_end_pos     REAL NOT NULL DEFAULT 0,
  y_end_pos     REAL NOT NULL DEFAULT 0,
  visible       INTEGER NOT NULL DEFAULT 1,
  -- 1 = only used on blank stock (not preprinted). We always render these.
  not_for_preprint INTEGER NOT NULL DEFAULT 0
);

-- Index for fast ledger queries
CREATE INDEX IF NOT EXISTS idx_checks_date ON checks(check_date);
CREATE INDEX IF NOT EXISTS idx_checks_printed ON checks(printed);
CREATE INDEX IF NOT EXISTS idx_checks_check_no ON checks(check_no);
