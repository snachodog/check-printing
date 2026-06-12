'use strict';

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const os      = require('os');
const fs      = require('fs');

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });
const { isEditorForAccount } = require('../middleware/auth');

// ── CSV helpers ───────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        fields.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  fields.push(cur);
  return fields;
}

function findColumns(rows) {
  const aliases = {
    date:   ['date'],
    type:   ['transaction type', 'type'],
    num:    ['num', 'no.', 'check no', 'check#', 'ref no.', 'reference no'],
    name:   ['name', 'payee', 'vendor', 'received from', 'customer'],
    memo:   ['memo/description', 'description', 'memo', 'memo description'],
    amount: ['amount'],
    debit:  ['debit'],
    credit: ['credit'],
  };

  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const row = rows[i];
    const lower = row.map(c => c.trim().toLowerCase());
    if (!lower.includes('date')) continue;

    const cols = {};
    for (const [key, names] of Object.entries(aliases)) {
      for (const name of names) {
        const idx = lower.indexOf(name);
        if (idx !== -1) { cols[key] = idx; break; }
      }
    }
    if (cols.date === undefined) continue;
    return { headerRow: i, cols };
  }
  return null;
}

function parseAmount(str) {
  if (!str && str !== 0) return null;
  const s = String(str).replace(/[$,\s]/g, '');
  if (s === '' || s === '-') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function parseDate(str) {
  if (!str) return null;
  str = str.trim();
  // MM/DD/YYYY
  const slash = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;
  // ISO already
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // Try Date parse as last resort
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return null;
}

function extractRows(text, type) {
  const lines = text.split(/\r?\n/);
  const rows = lines.map(l => parseCSVLine(l));

  const found = findColumns(rows);
  if (!found) return { records: [], warnings: ['Could not find a header row with a Date column in the first 25 rows.'] };

  const { headerRow, cols } = found;
  const warnings = [];
  const records = [];

  const skipPrefixes = ['total', 'subtotal', 'grand total', 'net total', 'balance'];

  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => !c.trim())) continue;

    const rawDate = cols.date !== undefined ? (row[cols.date] || '').trim() : '';
    if (!rawDate) continue;

    // Skip summary/total rows
    const firstCell = rawDate.toLowerCase();
    if (skipPrefixes.some(p => firstCell.startsWith(p))) continue;

    const date = parseDate(rawDate);
    if (!date) continue;

    // Type filtering
    if (cols.type !== undefined) {
      const rowType = (row[cols.type] || '').toLowerCase();
      if (type === 'checks' && !rowType.includes('check')) continue;
      if (type === 'deposits' && !rowType.includes('deposit')) continue;
    }

    let amount = null;
    if (cols.amount !== undefined) {
      amount = parseAmount(row[cols.amount]);
    }
    if ((amount === null || amount === 0) && type === 'checks' && cols.debit !== undefined) {
      amount = parseAmount(row[cols.debit]);
    }
    if ((amount === null || amount === 0) && type === 'deposits' && cols.credit !== undefined) {
      amount = parseAmount(row[cols.credit]);
    }
    if (amount === null || amount === 0) continue;
    amount = Math.abs(amount);

    const payee = cols.name  !== undefined ? (row[cols.name]  || '').trim() : '';
    const memo  = cols.memo  !== undefined ? (row[cols.memo]  || '').trim() : '';
    const numRaw = cols.num  !== undefined ? (row[cols.num]   || '').trim() : '';

    if (type === 'checks') {
      const check_no = numRaw ? (parseInt(numRaw, 10) || null) : null;
      records.push({ date, payee, memo, amount, check_no });
    } else {
      const ref = numRaw || null;
      records.push({ date, payee, memo, amount, ref });
    }
  }

  if (records.length === 0) {
    warnings.push('No matching records found after filtering.');
  }

  return { records, warnings };
}

// ── Confirm helpers ───────────────────────────────────────────────────────────

// Records come back from the client as JSON, not from the parsed file —
// re-validate them server-side. Normalizes amount/check_no in place.
// Returns an error string, or null if all records are valid.
function validateRecords(records, type) {
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') return 'Invalid record.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.date || '')) {
      return 'Each record must have a date in YYYY-MM-DD format.';
    }
    const amount = Number(rec.amount);
    if (!isFinite(amount) || amount <= 0) {
      return 'Each record amount must be a positive number.';
    }
    rec.amount = Math.round(amount * 100) / 100;
    if (type === 'checks' && rec.check_no !== null && rec.check_no !== undefined) {
      const n = parseInt(rec.check_no, 10);
      if (!Number.isInteger(n) || n < 1) return 'Check numbers must be positive integers.';
      rec.check_no = n;
    }
  }
  return null;
}

function confirmChecks(db, records, account_id) {
  const existing = new Set(
    db.prepare('SELECT check_no FROM checks WHERE account_id = ?').all(account_id).map(r => r.check_no)
  );

  const account = db.prepare('SELECT current_check_no FROM account WHERE id = ?').get(account_id);
  if (!account) throw new Error('Account not found.');

  let nextAuto = account.current_check_no + 1;
  let imported = 0;
  let skipped  = 0;
  let highestUsed = account.current_check_no;

  const insertCheck = db.prepare(`
    INSERT INTO checks (account_id, check_no, payee, amount, check_date, memo, printed)
    VALUES (@account_id, @check_no, @payee, @amount, @check_date, @memo, 0)
  `);

  db.transaction(() => {
    for (const rec of records) {
      let checkNo;
      if (rec.check_no !== null && rec.check_no !== undefined) {
        if (existing.has(rec.check_no)) { skipped++; continue; }
        checkNo = rec.check_no;
      } else {
        while (existing.has(nextAuto)) nextAuto++;
        checkNo = nextAuto++;
      }
      existing.add(checkNo);
      insertCheck.run({
        account_id: account_id,
        check_no:   checkNo,
        payee:      rec.payee || '',
        amount:     rec.amount,
        check_date: rec.date,
        memo:       rec.memo || null,
      });
      if (checkNo > highestUsed) highestUsed = checkNo;
      imported++;
    }

    if (highestUsed > account.current_check_no) {
      db.prepare("UPDATE account SET current_check_no = ?, updated_at = datetime('now') WHERE id = ?")
        .run(highestUsed, account_id);
    }
  })();

  return { imported, skipped };
}

function confirmDeposits(db, records, account_id) {
  // Group by date
  const byDate = new Map();
  for (const rec of records) {
    if (!byDate.has(rec.date)) byDate.set(rec.date, []);
    byDate.get(rec.date).push(rec);
  }

  const insertDeposit = db.prepare(`
    INSERT INTO deposits (account_id, deposit_date, currency, coin, cash_back)
    VALUES (@account_id, @deposit_date, 0, 0, 0)
  `);
  const insertItem = db.prepare(`
    INSERT INTO deposit_items (deposit_id, sort_order, check_no, payee, memo, amount)
    VALUES (@deposit_id, @sort_order, @check_no, @payee, @memo, @amount)
  `);

  let imported = 0;
  let itemCount = 0;

  db.transaction(() => {
    for (const [date, items] of byDate) {
      const result = insertDeposit.run({ account_id, deposit_date: date });
      const depositId = result.lastInsertRowid;
      items.forEach((item, idx) => {
        insertItem.run({
          deposit_id: depositId,
          sort_order: idx,
          check_no:   item.ref || null,
          payee:      item.payee || null,
          memo:       item.memo  || null,
          amount:     item.amount,
        });
        itemCount++;
      });
      imported++;
    }
  })();

  return { imported, itemCount };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/qbo-import/parse
router.post('/parse', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const type = req.body.type;
  if (type !== 'checks' && type !== 'deposits') {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Invalid type. Must be "checks" or "deposits".' });
  }

  // Reject non-text MIME types — only CSV/plain text is expected
  const mime = (req.file.mimetype || '').toLowerCase();
  if (!mime.startsWith('text/') && mime !== 'application/csv' && mime !== 'application/vnd.ms-excel') {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'File must be a CSV text file.' });
  }

  let text;
  try {
    text = fs.readFileSync(req.file.path, 'utf8');
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read uploaded file.' });
  } finally {
    fs.unlink(req.file.path, () => {});
  }

  const { records, warnings } = extractRows(text, type);

  if (records.length === 0) {
    return res.status(422).json({ error: warnings.length ? warnings[0] : 'No matching records found in file.' });
  }

  res.json({ records, warnings: warnings.length ? warnings : undefined });
});

// POST /api/qbo-import/confirm
router.post('/confirm', express.json(), (req, res) => {
  const { type, records, account_id } = req.body;
  if (!type || !records || !account_id) {
    return res.status(400).json({ error: 'Missing required fields: type, records, account_id.' });
  }
  if (!isEditorForAccount(req.session, parseInt(account_id, 10))) {
    return res.status(403).json({ error: 'Write access required.' });
  }
  if (type !== 'checks' && type !== 'deposits') {
    return res.status(400).json({ error: 'Invalid type.' });
  }
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'No records provided.' });
  }
  if (records.length > 1000) {
    return res.status(400).json({ error: 'Cannot import more than 1000 records at a time.' });
  }
  const validationError = validateRecords(records, type);
  if (validationError) return res.status(400).json({ error: validationError });

  const db = require('../db/database');
  try {
    if (type === 'checks') {
      const result = confirmChecks(db, records, account_id);
      res.json(result);
    } else {
      const result = confirmDeposits(db, records, account_id);
      res.json(result);
    }
  } catch (err) {
    res.status(500).json({ error: err.message || 'Import failed.' });
  }
});

module.exports = router;
