'use strict';

const express = require('express');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api/checks', require('./routes/checks'));
app.use('/api/pdf',    require('./routes/pdf'));

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
