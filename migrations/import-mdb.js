#!/usr/bin/env node
'use strict';

/**
 * import-mdb.js
 *
 * Migration: reads an ezCheckPrinting .mdb file and imports account config,
 * check layout, and check records into the SQLite database as a NEW account.
 * Each import creates a separate account row; existing accounts are unaffected.
 *
 * Usage:
 *   node migrations/import-mdb.js --file "/path/to/Account.mdb"
 *   node migrations/import-mdb.js --file "/path/to/Account.mdb" --dry-run
 */

const { execSync } = require('child_process');
const path = require('path');
const db = require('../src/db/database');

// ---- CLI args ---------------------------------------------------------------

const args = process.argv.slice(2);
const fileIndex = args.indexOf('--file');
if (fileIndex === -1 || !args[fileIndex + 1]) {
  console.error('Usage: node migrations/import-mdb.js --file "/path/to/Account.mdb"');
  process.exit(1);
}

const mdbFile = args[fileIndex + 1];
const dryRun = args.includes('--dry-run');

if (dryRun) {
  console.log('[dry-run] No data will be written to the database.');
}

// ---- mdbtools helpers -------------------------------------------------------

function mdbExport(table) {
  try {
    const output = execSync(`mdb-export "${mdbFile}" ${table}`, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    return parseCsv(output);
  } catch (err) {
    console.error(`Failed to export table ${table}:`, err.message);
    return [];
  }
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    if (values.length === 0) continue;
    const row = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = values[idx] !== undefined ? values[idx] : null;
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ---- Font name normalization -------------------------------------------------

const FONT_MAP = {
  'Times New Roman': 'Times-Roman',
  'Helsinki': 'Helvetica',
  'Arial': 'Helvetica',
  'Courier New': 'Courier',
};

function normalizeFont(fontName, isBold) {
  const mapped = FONT_MAP[fontName] || 'Helvetica';
  if (isBold) {
    if (mapped === 'Times-Roman') return 'Times-Bold';
    if (mapped === 'Helvetica') return 'Helvetica-Bold';
    if (mapped === 'Courier') return 'Courier-Bold';
  }
  return mapped;
}

// ---- Import: T100 (account config) ------------------------------------------

function importAccount() {
  console.log('\n--- Importing account config (T100) ---');
  const rows = mdbExport('T100');
  if (rows.length === 0) {
    console.error('No rows in T100. Is this a valid ezCheckPrinting .mdb?');
    process.exit(1);
  }

  const r = rows[0];
  console.log(`Account: ${r.Company1} / Bank: ${r.BankName}`);
  console.log(`Routing: ${r.BankRouteNo} | Account: ${r.BankAccountNo}`);
  console.log(`Current check no: ${r.CurrentCheckNo}`);

  const accountData = {
    bank_name:        r.BankName?.trim() || '',
    bank_info1:       r.BankInfo1?.trim() || null,
    bank_info2:       r.BankInfo2?.trim() || null,
    bank_info3:       r.BankInfo3?.trim() || null,
    transit_code:     r.TransitCode?.trim() || null,
    routing_number:   r.BankRouteNo?.trim() || '',
    account_number:   r.BankAccountNo?.trim() || '',
    start_check_no:   parseInt(r.StartCheckNo) || 1000,
    current_check_no: parseInt(r.CurrentCheckNo) || 1000,
    check_width:      parseFloat(r.CheckWidth) || 8.5,
    check_height:     parseFloat(r.CheckHeight) || 3.5,
    offset_left:      parseFloat(r.OffsetLeft) || 0,
    offset_right:     parseFloat(r.OffsetRight) || 0,
    offset_up:        parseFloat(r.OffsetUp) || 0,
    offset_down:      parseFloat(r.OffsetDown) || 0,
    company1:         r.Company1?.trim() || null,
    company2:         r.Company2?.trim() || null,
    company3:         r.Company3?.trim() || null,
    company4:         r.Company4?.trim() || null,
    blank_stock:      r.BlankBankStock === 'true' || r.BlankBankStock === '1' ? 1 : 0,
    check_position:   r.ExField1?.trim() || '3-per-page',
  };

  if (!dryRun) {
    const result = db.prepare(`
      INSERT INTO account (
        bank_name, bank_info1, bank_info2, bank_info3, transit_code,
        routing_number, account_number, start_check_no, current_check_no,
        check_width, check_height, offset_left, offset_right, offset_up, offset_down,
        company1, company2, company3, company4,
        blank_stock, check_position
      ) VALUES (
        @bank_name, @bank_info1, @bank_info2, @bank_info3, @transit_code,
        @routing_number, @account_number, @start_check_no, @current_check_no,
        @check_width, @check_height, @offset_left, @offset_right, @offset_up, @offset_down,
        @company1, @company2, @company3, @company4,
        @blank_stock, @check_position
      )
    `).run(accountData);
    const accountId = result.lastInsertRowid;
    console.log(`Account config imported (id=${accountId}).`);
    return accountId;
  } else {
    console.log('[dry-run] Would insert:', JSON.stringify(accountData, null, 2));
    return null;
  }
}

// ---- Import: Settings (logo image) ------------------------------------------

function importLogo(accountId) {
  console.log('\n--- Importing logo from Settings table ---');
  const rows = mdbExport('Settings');
  const logoRow = rows.find(r => r.SettingKey === 'LogoImg');

  if (!logoRow || !logoRow.SettingValue) {
    console.log('No logo found in Settings table.');
    return;
  }

  const base64Data = logoRow.SettingValue.trim();
  const dataUri = `data:image/gif;base64,${base64Data}`;

  if (!dryRun) {
    db.prepare('UPDATE account SET logo_data = ? WHERE id = ?').run(dataUri, accountId);
    console.log(`Logo imported (${Math.round(base64Data.length / 1024)} KB base64).`);
  } else {
    console.log(`[dry-run] Would import logo (${Math.round(base64Data.length / 1024)} KB base64).`);
  }
}

// ---- Import: T200 (check layout fields) -------------------------------------

function importLayoutFields(accountId) {
  console.log('\n--- Importing check layout fields (T200) ---');
  const rows = mdbExport('T200');
  console.log(`Found ${rows.length} layout fields.`);

  if (!dryRun) {
    db.prepare('DELETE FROM layout_fields WHERE account_id = ?').run(accountId);
  }

  const insert = db.prepare(`
    INSERT INTO layout_fields (
      account_id, field_name, field_text, font_name, font_size, font_bold,
      field_type, line_thick, x_pos, y_pos, x_end_pos, y_end_pos,
      visible, not_for_preprint
    ) VALUES (
      @account_id, @field_name, @field_text, @font_name, @font_size, @font_bold,
      @field_type, @line_thick, @x_pos, @y_pos, @x_end_pos, @y_end_pos,
      @visible, @not_for_preprint
    )
  `);

  let count = 0;
  for (const r of rows) {
    const isBold = r.FldFontType === '1';
    const fieldData = {
      account_id:       accountId,
      field_name:       r.FldName?.trim() || '',
      field_text:       r.FldText?.trim() || null,
      font_name:        normalizeFont(r.FldFontName?.trim(), isBold),
      font_size:        parseFloat(r.FldFontSize) || 10,
      font_bold:        isBold ? 1 : 0,
      field_type:       r.FldType?.trim() || 'Regular',
      line_thick:       parseInt(r.LnThick) || 1,
      x_pos:            parseFloat(r.XPos) || 0,
      y_pos:            parseFloat(r.YPos) || 0,
      x_end_pos:        parseFloat(r.XEndPos) || 0,
      y_end_pos:        parseFloat(r.YEndPos) || 0,
      visible:          r.Display === '1' ? 1 : 0,
      not_for_preprint: parseInt(r.NotForPreprint) || 0,
    };

    if (!dryRun) {
      insert.run(fieldData);
    } else {
      console.log(`  [dry-run] ${fieldData.field_name}: type=${fieldData.field_type} x=${fieldData.x_pos} y=${fieldData.y_pos}`);
    }
    count++;
  }

  console.log(`${dryRun ? '[dry-run] Would import' : 'Imported'} ${count} layout fields.`);
}

// ---- Import: T104 (check records) -------------------------------------------

function importChecks(accountId) {
  console.log('\n--- Importing check records (T104) ---');
  const rows = mdbExport('T104');
  console.log(`Found ${rows.length} check records.`);

  if (rows.length === 0) {
    console.log('No checks to import.');
    return;
  }

  if (!dryRun) {
    db.prepare('DELETE FROM checks WHERE account_id = ?').run(accountId);
  }

  const insert = db.prepare(`
    INSERT INTO checks (
      account_id, check_no, payee, amount, check_date, memo, note1, note2,
      payee_address1, payee_address2, payee_address3, payee_address4,
      printed, add_date, mdb_check_id
    ) VALUES (
      @account_id, @check_no, @payee, @amount, @check_date, @memo, @note1, @note2,
      @payee_address1, @payee_address2, @payee_address3, @payee_address4,
      @printed, @add_date, @mdb_check_id
    )
  `);

  let count = 0;
  let skipped = 0;
  for (const r of rows) {
    const rawDate = r.CheckDate?.trim() || '';
    const checkDate = normalizeDate(rawDate);
    const addDate = normalizeDate(r.AddDate?.trim() || '') || new Date().toISOString();

    const checkData = {
      account_id:     accountId,
      check_no:       parseInt(r.CheckNo),
      payee:          r.Payee?.trim() || '',
      amount:         parseFloat(r.Amount) || 0,
      check_date:     checkDate,
      memo:           r.Memo?.trim() || null,
      note1:          r.Note1?.trim() || null,
      note2:          r.Note2?.trim() || null,
      payee_address1: r.PayeeAddress1?.trim() || null,
      payee_address2: r.PayeeAddress2?.trim() || null,
      payee_address3: r.PayeeAddress3?.trim() || null,
      payee_address4: r.PayeeAddress4?.trim() || null,
      printed:        r.checked === 'true' || r.checked === '1' ? 1 : 0,
      add_date:       addDate,
      mdb_check_id:   parseInt(r.CheckID) || null,
    };

    if (!checkData.check_no || !checkData.payee) {
      console.warn(`  Skipping record with missing check_no or payee:`, r);
      skipped++;
      continue;
    }

    if (!dryRun) {
      try {
        insert.run(checkData);
      } catch (err) {
        console.warn(`  Skipping duplicate check #${checkData.check_no}:`, err.message);
        skipped++;
        continue;
      }
    } else {
      console.log(`  [dry-run] Check #${checkData.check_no}: ${checkData.payee} $${checkData.amount} ${checkData.check_date}`);
    }
    count++;
  }

  console.log(`${dryRun ? '[dry-run] Would import' : 'Imported'} ${count} checks.${skipped > 0 ? ` Skipped ${skipped}.` : ''}`);
}

// ---- Date normalization -----------------------------------------------------

function normalizeDate(raw) {
  if (!raw) return null;
  const mdyMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    const year = y.length === 2
      ? (parseInt(y, 10) >= 50 ? '19' : '20') + y
      : y;
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  return null;
}

// ---- Run --------------------------------------------------------------------

console.log(`\nImporting from: ${mdbFile}`);
console.log(`Target database: ${process.env.DB_PATH || 'data/ezcheck.db'}`);

try {
  const accountId = importAccount();
  if (!dryRun && accountId) {
    importLogo(accountId);
    importLayoutFields(accountId);
    importChecks(accountId);
  } else if (dryRun) {
    importLogo(null);
    importLayoutFields(null);
    importChecks(null);
  }
  console.log('\nMigration complete.');
} catch (err) {
  console.error('\nMigration failed:', err);
  process.exit(1);
}
