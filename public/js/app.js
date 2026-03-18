'use strict';

const state = {
  checks: [],
  account: null,
  accounts: [],
  activeAccountId: parseInt(localStorage.getItem('activeAccountId'), 10) || null,
  filterStatus: '',   // '' = all, '0' = unprinted, '1' = printed
  filterPayee: '',
  filterDateFrom: '',
  filterDateTo: '',
  sortCol: 'check_no',
  sortDir: 'desc',
  selected: new Set(),
  editingId: null,
};

// ── API helpers ──────────────────────────────────────────────────────────────

async function apiFetch(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadAccounts() {
  try {
    state.accounts = await apiFetch('GET', '/api/accounts');
    if (state.accounts.length === 0) {
      openWizard();
      return;
    }
    // Use stored account or default to first
    const stored = state.activeAccountId;
    const valid = stored && state.accounts.find(a => a.id === stored);
    state.activeAccountId = valid ? stored : state.accounts[0].id;
    localStorage.setItem('activeAccountId', state.activeAccountId);

    populateAccountSwitcher();
    state.account = await apiFetch('GET', `/api/account/${state.activeAccountId}`);
    renderHeader();
    await loadChecks();
  } catch (err) {
    console.error('Failed to load accounts:', err);
  }
}

function populateAccountSwitcher() {
  const sel = document.getElementById('account-switcher');
  sel.innerHTML = state.accounts.map(a =>
    `<option value="${a.id}"${a.id === state.activeAccountId ? ' selected' : ''}>${escHtml(a.company1 || a.bank_name || `Account ${a.id}`)}</option>`
  ).join('');
}

async function switchAccount(accountId) {
  state.activeAccountId = accountId;
  localStorage.setItem('activeAccountId', accountId);
  state.selected.clear();
  state.account = await apiFetch('GET', `/api/account/${accountId}`);
  renderHeader();
  await loadChecks();
}

async function loadChecks() {
  if (!state.activeAccountId) return;
  const tbody = document.getElementById('checks-tbody');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="8">Loading…</td></tr>';
  try {
    state.checks = await apiFetch('GET', `/api/checks?account_id=${state.activeAccountId}`);
    state.selected.clear();
    renderTable();
    refreshPdfButton();
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">Error loading checks: ${escHtml(err.message)}</td></tr>`;
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderHeader() {
  const a = state.account;
  if (!a) return;
  document.getElementById('company-name').textContent = a.company1 || 'ezcheck';
  document.getElementById('current-check-no').textContent = a.current_check_no + 1;
}

function renderTable() {
  const checks = filteredAndSortedChecks();
  const tbody = document.getElementById('checks-tbody');

  if (checks.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No checks found.</td></tr>';
    updateSortIndicators();
    updateSelectAll();
    updateChecksSummary();
    return;
  }

  tbody.innerHTML = checks.map(renderRow).join('');
  updateSortIndicators();
  updateSelectAll();
  updateChecksSummary();

  // Attach row-level event listeners
  tbody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => onCheckboxChange(cb));
  });
  tbody.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', () => openPanel(parseInt(btn.dataset.id, 10)));
  });
  tbody.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteCheck(parseInt(btn.dataset.id, 10)));
  });
}

function renderRow(c) {
  const printed = !!c.printed;
  const selected = state.selected.has(c.id);

  const fmtAmount = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
  }).format(c.amount);

  const fmtDate = c.check_date
    ? new Date(c.check_date + 'T12:00:00').toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
    : '—';

  const checkbox = `<td class="col-select"><input type="checkbox" data-id="${c.id}"${selected ? ' checked' : ''}></td>`;

  const statusBadge = printed
    ? '<span class="status-badge status-printed">Printed</span>'
    : '<span class="status-badge status-unprinted">Unprinted</span>';

  const actions = `<button class="btn-sm btn-edit" data-id="${c.id}">Edit</button>` +
                  `<button class="btn-sm btn-delete" data-id="${c.id}">Delete</button>`;

  return `<tr class="${printed ? 'printed' : ''}">
    ${checkbox}
    <td class="col-no">${c.check_no}</td>
    <td class="col-date">${fmtDate}</td>
    <td class="col-payee">${escHtml(c.payee)}</td>
    <td class="col-amount">${fmtAmount}</td>
    <td class="col-memo" title="${escHtml(c.memo || '')}">${escHtml(c.memo || '')}</td>
    <td class="col-status">${statusBadge}</td>
    <td class="col-actions">${actions}</td>
  </tr>`;
}

function filteredAndSortedChecks() {
  const payee = state.filterPayee.toLowerCase();
  const from  = state.filterDateFrom;
  const to    = state.filterDateTo;
  const status = state.filterStatus;

  let list = state.checks.filter(c => {
    if (payee  && !c.payee.toLowerCase().includes(payee)) return false;
    if (from   && c.check_date < from) return false;
    if (to     && c.check_date > to)   return false;
    if (status === '0' &&  c.printed)  return false;
    if (status === '1' && !c.printed)  return false;
    return true;
  });

  const col = state.sortCol;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  return list.sort((a, b) => {
    let av = a[col];
    let bv = b[col];
    if (col === 'amount') { av = parseFloat(av); bv = parseFloat(bv); }
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  });
}

function updateSortIndicators() {
  document.querySelectorAll('thead th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === state.sortCol) {
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function updateSelectAll() {
  const selectAll = document.getElementById('select-all-checks');
  const checks = filteredAndSortedChecks();
  if (checks.length === 0) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }
  const nSelected = checks.filter(c => state.selected.has(c.id)).length;
  selectAll.indeterminate = nSelected > 0 && nSelected < checks.length;
  selectAll.checked = nSelected === checks.length;
}

function updateChecksSummary() {
  const el = document.getElementById('checks-summary');
  const filtered = filteredAndSortedChecks();
  const all = state.checks.length;
  const fmt = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  if (all === 0) { el.textContent = ''; return; }

  const filteredTotal = filtered.reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);
  const isFiltered = filtered.length < all;
  if (isFiltered) {
    el.textContent = `${filtered.length} of ${all} checks  ·  ${fmt(filteredTotal)}`;
  } else {
    el.textContent = `${all} check${all !== 1 ? 's' : ''}  ·  ${fmt(filteredTotal)}`;
  }
}


function refreshPdfButton() {
  const n = state.selected.size;
  const btn = document.getElementById('btn-generate-pdf');
  btn.disabled = n === 0;
  document.getElementById('selected-count').textContent = n;
}

// ── Checkbox handling ────────────────────────────────────────────────────────

function onCheckboxChange(cb) {
  const id = parseInt(cb.dataset.id, 10);
  if (cb.checked) {
    state.selected.add(id);
  } else {
    state.selected.delete(id);
  }
  refreshPdfButton();
  updateSelectAll();
}

// ── Slide-in panel ───────────────────────────────────────────────────────────

function openPanel(id = null) {
  state.editingId = id;
  const form = document.getElementById('check-form');
  const title = document.getElementById('panel-title');

  form.reset();
  clearFormErrors();
  document.querySelector('.address-section').removeAttribute('open');

  if (id !== null) {
    const check = state.checks.find(c => c.id === id);
    if (!check) return;
    title.textContent = `Edit Check #${check.check_no}`;
    form.payee.value = check.payee || '';
    form.amount.value = check.amount != null ? check.amount : '';
    form.check_date.value = check.check_date || '';
    form.memo.value = check.memo || '';
    form.note1.value = check.note1 || '';
    form.note2.value = check.note2 || '';
    form.payee_address1.value = check.payee_address1 || '';
    form.payee_address2.value = check.payee_address2 || '';
    form.payee_address3.value = check.payee_address3 || '';
    form.payee_address4.value = check.payee_address4 || '';
    if (check.payee_address1) {
      document.querySelector('.address-section').setAttribute('open', '');
    }
  } else {
    title.textContent = 'New Check';
    form.check_date.value = new Date().toISOString().slice(0, 10);
  }

  document.getElementById('panel-overlay').classList.add('open');
  document.getElementById('check-panel').classList.add('open');
  form.payee.focus();
}

function closePanel() {
  document.getElementById('panel-overlay').classList.remove('open');
  document.getElementById('check-panel').classList.remove('open');
  state.editingId = null;
}

function clearFormErrors() {
  document.querySelectorAll('#check-form .error').forEach(el => el.classList.remove('error'));
}

// ── CRUD actions ─────────────────────────────────────────────────────────────

async function saveCheck(e) {
  e.preventDefault();
  clearFormErrors();

  const form = e.target;
  const data = {
    payee:           form.payee.value.trim(),
    amount:          parseFloat(form.amount.value),
    check_date:      form.check_date.value,
    memo:            form.memo.value.trim() || null,
    note1:           form.note1.value.trim() || null,
    note2:           form.note2.value.trim() || null,
    payee_address1:  form.payee_address1.value.trim() || null,
    payee_address2:  form.payee_address2.value.trim() || null,
    payee_address3:  form.payee_address3.value.trim() || null,
    payee_address4:  form.payee_address4.value.trim() || null,
  };

  let valid = true;
  if (!data.payee)                             { form.payee.classList.add('error');      valid = false; }
  if (!data.amount || isNaN(data.amount) || data.amount <= 0) { form.amount.classList.add('error');     valid = false; }
  if (!data.check_date)                        { form.check_date.classList.add('error'); valid = false; }
  if (!valid) return;

  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    if (state.editingId !== null) {
      await apiFetch('PUT', `/api/checks/${state.editingId}`, data);
    } else {
      await apiFetch('POST', '/api/checks', { ...data, account_id: state.activeAccountId });
    }
    closePanel();
    await Promise.all([loadAccounts(), loadChecks()]);
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Check';
  }
}

async function deleteCheck(id) {
  const check = state.checks.find(c => c.id === id);
  if (!check) return;
  if (!confirm(`Delete check #${check.check_no} payable to "${check.payee}"?`)) return;
  try {
    await apiFetch('DELETE', `/api/checks/${id}`);
    await loadChecks();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function generatePdf() {
  const ids = [...state.selected];
  if (ids.length === 0) return;

  const btn = document.getElementById('btn-generate-pdf');
  btn.disabled = true;
  const countSpan = document.getElementById('selected-count');
  const savedCount = countSpan.textContent;
  countSpan.textContent = '…';

  try {
    const res = await fetch('/api/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkIds: ids, account_id: state.activeAccountId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), '_blank');
    await loadChecks(); // refresh to show printed status
  } catch (err) {
    countSpan.textContent = savedCount;
    btn.disabled = false;
    alert(`PDF error: ${err.message}`);
  }
}


// ── Setup wizard ─────────────────────────────────────────────────────────────

const wizard = { step: 1, logoData: null };

function openWizard() {
  wizard.step = 1;
  wizard.logoData = null;
  document.getElementById('w-logo').value = '';
  document.getElementById('wizard-error').hidden = true;
  goToWizardStep(1);
  document.getElementById('wizard-overlay').classList.add('open');
  document.getElementById('wizard-modal').classList.add('open');
  document.getElementById('w-company1').focus();
}

function closeWizard() {
  document.getElementById('wizard-overlay').classList.remove('open');
  document.getElementById('wizard-modal').classList.remove('open');
}

function goToWizardStep(n) {
  wizard.step = n;
  [1, 2, 3].forEach(i => {
    document.getElementById(`wizard-step-${i}`).hidden = i !== n;
    const dot = document.querySelector(`.wizard-step-dot[data-step="${i}"]`);
    dot.classList.toggle('active', i === n);
    dot.classList.toggle('done', i < n);
  });
  document.querySelectorAll('.wizard-step-line').forEach((line, idx) => {
    line.classList.toggle('done', idx < n - 1);
  });
  document.getElementById('btn-wizard-prev').hidden = n === 1;
  document.getElementById('btn-wizard-next').hidden = n === 3;
  document.getElementById('btn-wizard-finish').hidden = n !== 3;
  document.getElementById('wizard-error').hidden = true;
}

function validateWizardStep() {
  const err = document.getElementById('wizard-error');
  if (wizard.step === 1) {
    if (!document.getElementById('w-company1').value.trim()) {
      err.textContent = 'Organization name is required.';
      err.hidden = false;
      document.getElementById('w-company1').focus();
      return false;
    }
  }
  if (wizard.step === 2) {
    if (!document.getElementById('w-bank-name').value.trim()) {
      err.textContent = 'Bank name is required.';
      err.hidden = false;
      document.getElementById('w-bank-name').focus();
      return false;
    }
  }
  if (wizard.step === 3) {
    const routing = document.getElementById('w-routing').value.trim();
    const account = document.getElementById('w-account').value.trim();
    const startNo = document.getElementById('w-start-check').value.trim();
    if (!routing) { err.textContent = 'Routing number is required.'; err.hidden = false; return false; }
    if (!account) { err.textContent = 'Account number is required.'; err.hidden = false; return false; }
    if (!startNo || parseInt(startNo, 10) < 1) { err.textContent = 'Starting check number is required.'; err.hidden = false; return false; }
  }
  return true;
}

async function finishWizard() {
  if (!validateWizardStep()) return;

  const city    = document.getElementById('w-city').value.trim();
  const state_  = document.getElementById('w-state').value.trim().toUpperCase();
  const zip     = document.getElementById('w-zip').value.trim();
  const cityLine = [city, state_ ? (zip ? `${state_} ${zip}` : state_) : zip].filter(Boolean).join(', ');

  const payload = {
    company1:    document.getElementById('w-company1').value.trim(),
    company2:    document.getElementById('w-addr1').value.trim() || null,
    company3:    cityLine || null,
    company4:    document.getElementById('w-contact').value.trim() || null,
    bank_name:   document.getElementById('w-bank-name').value.trim(),
    bank_info1:  document.getElementById('w-bank-addr').value.trim() || null,
    bank_info2:  document.getElementById('w-bank-contact').value.trim() || null,
    transit_code: document.getElementById('w-transit').value.trim() || null,
    routing_number: document.getElementById('w-routing').value.trim(),
    account_number: document.getElementById('w-account').value.trim(),
    start_check_no: parseInt(document.getElementById('w-start-check').value, 10),
    logo_data:   wizard.logoData || null,
  };

  const btn = document.getElementById('btn-wizard-finish');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const result = await apiFetch('POST', '/api/account/setup', payload);
    closeWizard();
    await loadAccounts();
    if (result.accountId) await switchAccount(result.accountId);
  } catch (err) {
    const errEl = document.getElementById('wizard-error');
    errEl.textContent = err.message;
    errEl.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Save & Start';
  }
}

// ── Import modal ─────────────────────────────────────────────────────────────

function openImportModal() {
  document.getElementById('import-file').value = '';
  const log = document.getElementById('import-log');
  log.hidden = true;
  log.textContent = '';
  log.className = 'import-log';
  document.getElementById('btn-run-import').disabled = false;
  document.getElementById('btn-run-import').textContent = 'Import';
  document.getElementById('import-modal-overlay').classList.add('open');
  document.getElementById('import-modal').classList.add('open');
}

function closeImportModal() {
  document.getElementById('import-modal-overlay').classList.remove('open');
  document.getElementById('import-modal').classList.remove('open');
}

async function runImport() {
  const fileInput = document.getElementById('import-file');
  if (!fileInput.files.length) {
    alert('Select an .mdb file first.');
    return;
  }

  const btn = document.getElementById('btn-run-import');
  btn.disabled = true;
  btn.textContent = 'Importing…';

  const log = document.getElementById('import-log');
  log.hidden = false;
  log.className = 'import-log';
  log.textContent = 'Running import…';

  const form = new FormData();
  form.append('mdbfile', fileInput.files[0]);

  try {
    const res = await fetch('/api/import', { method: 'POST', body: form });
    const data = await res.json();
    log.textContent = data.log || '';
    if (res.ok) {
      log.classList.add('success');
      btn.textContent = 'Done';
      await loadAccounts();
      if (data.newAccountId) await switchAccount(data.newAccountId);
    } else {
      log.classList.add('error');
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  } catch (err) {
    log.classList.add('error');
    log.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Retry';
  }
}

// ── Account settings modal ───────────────────────────────────────────────────

const acctSettings = { logoData: null };

function openAccountSettings() {
  const a = state.account;
  if (!a) return;

  acctSettings.logoData = null;

  const f = document.getElementById('acct-settings-form');
  f.elements.company1.value    = a.company1 || '';
  f.elements.company2.value    = a.company2 || '';
  f.elements.company3.value    = a.company3 || '';
  f.elements.company4.value    = a.company4 || '';
  f.elements.bank_name.value   = a.bank_name || '';
  f.elements.bank_info1.value  = a.bank_info1 || '';
  f.elements.bank_info2.value  = a.bank_info2 || '';
  f.elements.transit_code.value = a.transit_code || '';
  f.elements.routing_number.value = a.routing_number || '';
  f.elements.account_number.value = a.account_number || '';
  f.elements.offset_left.value  = a.offset_left  || 0;
  f.elements.offset_right.value = a.offset_right || 0;
  f.elements.offset_up.value    = a.offset_up    || 0;
  f.elements.offset_down.value  = a.offset_down  || 0;

  document.getElementById('as-logo').value = '';
  document.getElementById('as-logo-preview').hidden = true;
  document.getElementById('acct-settings-error').hidden = true;
  document.getElementById('btn-save-acct-settings').disabled = false;
  document.getElementById('btn-save-acct-settings').textContent = 'Save Changes';

  document.getElementById('acct-settings-overlay').classList.add('open');
  document.getElementById('acct-settings-modal').classList.add('open');
  f.elements.company1.focus();
}

function closeAccountSettings() {
  document.getElementById('acct-settings-overlay').classList.remove('open');
  document.getElementById('acct-settings-modal').classList.remove('open');
}

async function saveAccountSettings() {
  const f = document.getElementById('acct-settings-form');
  const errEl = document.getElementById('acct-settings-error');
  errEl.hidden = true;

  const payload = {
    company1:       f.elements.company1.value.trim(),
    company2:       f.elements.company2.value.trim() || null,
    company3:       f.elements.company3.value.trim() || null,
    company4:       f.elements.company4.value.trim() || null,
    bank_name:      f.elements.bank_name.value.trim(),
    bank_info1:     f.elements.bank_info1.value.trim() || null,
    bank_info2:     f.elements.bank_info2.value.trim() || null,
    transit_code:   f.elements.transit_code.value.trim() || null,
    routing_number: f.elements.routing_number.value.trim(),
    account_number: f.elements.account_number.value.trim(),
    offset_left:    parseFloat(f.elements.offset_left.value)  || 0,
    offset_right:   parseFloat(f.elements.offset_right.value) || 0,
    offset_up:      parseFloat(f.elements.offset_up.value)    || 0,
    offset_down:    parseFloat(f.elements.offset_down.value)  || 0,
    logo_data:      acctSettings.logoData || null,
  };

  if (!payload.company1) {
    errEl.textContent = 'Organization name is required.';
    errEl.hidden = false;
    f.elements.company1.focus();
    return;
  }
  if (!payload.routing_number || !payload.account_number) {
    errEl.textContent = 'Routing number and account number are required.';
    errEl.hidden = false;
    return;
  }

  const btn = document.getElementById('btn-save-acct-settings');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    state.account = await apiFetch('PUT', `/api/account/${state.activeAccountId}`, payload);
    // Refresh account in the accounts list (for the switcher label)
    await loadAccounts();
    renderHeader();
    closeAccountSettings();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

// ── Set next check number ─────────────────────────────────────────────────────

function openSetCheckNo() {
  const current = state.account ? state.account.current_check_no + 1 : 1;
  document.getElementById('set-check-no-input').value = current;
  document.getElementById('set-check-no-error').hidden = true;
  document.getElementById('set-check-no-overlay').classList.add('open');
  document.getElementById('set-check-no-modal').classList.add('open');
  document.getElementById('set-check-no-input').focus();
  document.getElementById('set-check-no-input').select();
}

function closeSetCheckNo() {
  document.getElementById('set-check-no-overlay').classList.remove('open');
  document.getElementById('set-check-no-modal').classList.remove('open');
}

async function saveSetCheckNo() {
  const errEl = document.getElementById('set-check-no-error');
  const input = document.getElementById('set-check-no-input');
  const next = parseInt(input.value, 10);
  if (isNaN(next) || next < 1) {
    errEl.textContent = 'Enter a valid check number (1 or higher).';
    errEl.hidden = false;
    return;
  }
  const btn = document.getElementById('btn-confirm-set-check-no');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await apiFetch('PUT', `/api/account/${state.activeAccountId}/check-no`, { next_check_no: next });
    state.account.current_check_no = next - 1;
    renderHeader();
    closeSetCheckNo();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Set Number';
  }
}

// ── Deposits ─────────────────────────────────────────────────────────────────

const depState = {
  deposits: [],
  editingId: null,
  items: [],   // working list of check rows in the panel
};

async function loadDeposits() {
  if (!state.activeAccountId) return;
  const tbody = document.getElementById('deposits-tbody');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="8">Loading…</td></tr>';
  try {
    depState.deposits = await apiFetch('GET', `/api/deposits?account_id=${state.activeAccountId}`);
    renderDepositsTable();
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">Error: ${escHtml(err.message)}</td></tr>`;
  }
}

function renderDepositsTable() {
  const tbody  = document.getElementById('deposits-tbody');
  const from   = document.getElementById('dep-filter-from').value;
  const to     = document.getElementById('dep-filter-to').value;
  const status = document.getElementById('dep-filter-status').value;

  const fmt = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
  const fmtDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  let list = depState.deposits.filter(d => {
    if (from   && d.deposit_date < from) return false;
    if (to     && d.deposit_date > to)   return false;
    if (status === '0' &&  d.printed) return false;
    if (status === '1' && !d.printed) return false;
    return true;
  });

  if (list.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No deposits found.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(d => {
    const cashTotal    = (d.currency || 0) + (d.coin || 0);
    const checksTotal  = d.checks_total || 0;
    const depositTotal = cashTotal + checksTotal - (d.cash_back || 0);
    const printed      = !!d.printed;
    const badge        = printed
      ? '<span class="status-badge status-printed">Printed</span>'
      : '<span class="status-badge status-unprinted">Unprinted</span>';
    return `<tr class="${printed ? 'printed' : ''}">
      <td class="col-date">${fmtDate(d.deposit_date)}</td>
      <td class="col-amount" style="text-align:right">${fmt(checksTotal)}</td>
      <td class="col-amount" style="text-align:right">${fmt(cashTotal)}</td>
      <td class="col-amount" style="text-align:right">${fmt(d.cash_back)}</td>
      <td class="col-amount" style="text-align:right"><strong>${fmt(depositTotal)}</strong></td>
      <td style="text-align:center">${d.item_count || 0}</td>
      <td class="col-status">${badge}</td>
      <td class="col-actions">
        <button class="btn-sm btn-edit dep-btn-edit" data-id="${d.id}">Edit</button>
        <button class="btn-sm btn-delete dep-btn-delete" data-id="${d.id}">Delete</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.dep-btn-edit').forEach(btn =>
    btn.addEventListener('click', () => openDepositPanel(parseInt(btn.dataset.id, 10))));
  tbody.querySelectorAll('.dep-btn-delete').forEach(btn =>
    btn.addEventListener('click', () => deleteDeposit(parseInt(btn.dataset.id, 10))));
}

async function openDepositPanel(id = null) {
  depState.editingId = id;
  depState.items = [];

  document.getElementById('dep-panel-error').hidden = true;
  document.getElementById('dep-panel-title').textContent = id ? 'Edit Deposit' : 'New Deposit';
  document.getElementById('dep-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('dep-currency').value = '';
  document.getElementById('dep-coin').value = '';
  document.getElementById('dep-cashback').value = '';

  if (id !== null) {
    try {
      const dep = await apiFetch('GET', `/api/deposits/${id}`);
      document.getElementById('dep-date').value     = dep.deposit_date || '';
      document.getElementById('dep-currency').value = dep.currency  || '';
      document.getElementById('dep-coin').value     = dep.coin      || '';
      document.getElementById('dep-cashback').value = dep.cash_back || '';
      depState.items = (dep.items || []).map(it => ({ ...it }));
    } catch (err) {
      alert('Error loading deposit: ' + err.message);
      return;
    }
  } else {
    depState.items = [newDepItem()];
  }

  renderDepItems();
  recalcDepTotals();

  const slipBtn   = document.getElementById('btn-dep-slip');
  const reportBtn = document.getElementById('btn-dep-report');
  slipBtn.disabled   = id === null;
  reportBtn.disabled = id === null;

  document.getElementById('dep-panel-overlay').classList.add('open');
  document.getElementById('deposit-panel').classList.add('open');
  document.getElementById('dep-date').focus();
}

function closeDepositPanel() {
  document.getElementById('dep-panel-overlay').classList.remove('open');
  document.getElementById('deposit-panel').classList.remove('open');
  depState.editingId = null;
  depState.items = [];
}

function newDepItem() {
  return { _key: Math.random(), check_no: '', bank_no: '', payee: '', memo: '', amount: '' };
}

function renderDepItems() {
  const tbody = document.getElementById('dep-items-tbody');
  tbody.innerHTML = depState.items.map((item, i) => `
    <tr data-idx="${i}">
      <td><input class="dep-item-input" data-field="check_no" value="${escHtml(item.check_no || '')}" placeholder="Check #" style="width:70px"></td>
      <td><input class="dep-item-input" data-field="payee"    value="${escHtml(item.payee    || '')}" placeholder="Payee"   style="width:110px"></td>
      <td><input class="dep-item-input" data-field="memo"     value="${escHtml(item.memo     || '')}" placeholder="Memo"    style="width:90px"></td>
      <td><input class="dep-item-input dep-amount-input" data-field="amount" value="${item.amount !== '' ? item.amount : ''}" placeholder="0.00" style="width:80px;text-align:right" type="number" min="0" step="0.01"></td>
      <td><button class="btn-sm btn-delete dep-item-remove" data-idx="${i}" tabindex="-1">✕</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.dep-item-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const row = e.target.closest('tr');
      const idx = parseInt(row.dataset.idx, 10);
      depState.items[idx][e.target.dataset.field] = e.target.value;
      if (e.target.dataset.field === 'amount') recalcDepTotals();
    });
  });
  tbody.querySelectorAll('.dep-item-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      depState.items.splice(parseInt(btn.dataset.idx, 10), 1);
      renderDepItems();
      recalcDepTotals();
    });
  });
}

function recalcDepTotals() {
  const fmt = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
  const currency    = parseFloat(document.getElementById('dep-currency').value)  || 0;
  const coin        = parseFloat(document.getElementById('dep-coin').value)       || 0;
  const cashBack    = parseFloat(document.getElementById('dep-cashback').value)   || 0;
  const cashTotal   = currency + coin;
  const checksTotal = depState.items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0);
  const subTotal    = cashTotal + checksTotal;
  const grand       = subTotal - cashBack;

  document.getElementById('dep-cash-total').textContent       = fmt(cashTotal);
  document.getElementById('dep-checks-total').textContent     = fmt(checksTotal);
  document.getElementById('dep-subtotal').textContent         = fmt(subTotal);
  document.getElementById('dep-cashback-display').textContent = fmt(cashBack);
  document.getElementById('dep-grand-total').textContent      = fmt(grand);
}

async function saveDeposit() {
  const errEl = document.getElementById('dep-panel-error');
  errEl.hidden = true;

  const deposit_date = document.getElementById('dep-date').value;
  if (!deposit_date) {
    errEl.textContent = 'Deposit date is required.';
    errEl.hidden = false;
    return;
  }

  const payload = {
    account_id:   state.activeAccountId,
    deposit_date,
    currency:  parseFloat(document.getElementById('dep-currency').value)  || 0,
    coin:      parseFloat(document.getElementById('dep-coin').value)       || 0,
    cash_back: parseFloat(document.getElementById('dep-cashback').value)   || 0,
    items: depState.items
      .filter(it => parseFloat(it.amount) > 0 || it.check_no || it.payee)
      .map((it, i) => ({
        sort_order: i,
        check_no: it.check_no || null,
        bank_no:  it.bank_no  || null,
        payee:    it.payee    || null,
        memo:     it.memo     || null,
        amount:   parseFloat(it.amount) || 0,
      })),
  };

  const btn = document.getElementById('btn-save-deposit');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    let saved;
    if (depState.editingId !== null) {
      saved = await apiFetch('PUT', `/api/deposits/${depState.editingId}`, payload);
    } else {
      saved = await apiFetch('POST', '/api/deposits', payload);
    }
    depState.editingId = saved.id;
    // Enable PDF buttons now that deposit is saved
    document.getElementById('btn-dep-slip').disabled   = false;
    document.getElementById('btn-dep-report').disabled = false;
    document.getElementById('dep-panel-title').textContent = 'Edit Deposit';
    await loadDeposits();
    btn.disabled = false;
    btn.textContent = 'Save Deposit';
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Save Deposit';
  }
}

async function deleteDeposit(id) {
  const dep = depState.deposits.find(d => d.id === id);
  const label = dep ? dep.deposit_date : `#${id}`;
  if (!confirm(`Delete deposit from ${label}?`)) return;
  try {
    await apiFetch('DELETE', `/api/deposits/${id}`);
    await loadDeposits();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function generateDepositPdf(type) {
  if (!depState.editingId) return;
  const btn = type === 'slip'
    ? document.getElementById('btn-dep-slip')
    : document.getElementById('btn-dep-report');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '…';
  try {
    const res = await fetch('/api/deposit-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositId: depState.editingId, type, mark_printed: type === 'slip' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), '_blank');
    if (type === 'slip') await loadDeposits();
  } catch (err) {
    alert('PDF error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Initialization ───────────────────────────────────────────────────────────

function init() {
  // Column sort
  document.querySelectorAll('thead th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      if (state.sortCol === th.dataset.col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortCol = th.dataset.col;
        state.sortDir = th.dataset.col === 'check_no' ? 'desc' : 'asc';
      }
      renderTable();
    });
  });

  // Filters (client-side; just re-render)
  document.getElementById('filter-payee').addEventListener('input', e => {
    state.filterPayee = e.target.value;
    renderTable();
  });
  document.getElementById('filter-date-from').addEventListener('change', e => {
    state.filterDateFrom = e.target.value;
    renderTable();
  });
  document.getElementById('filter-date-to').addEventListener('change', e => {
    state.filterDateTo = e.target.value;
    renderTable();
  });
  document.getElementById('filter-status').addEventListener('change', e => {
    state.filterStatus = e.target.value;
    renderTable();
  });

  // Select-all checkbox
  document.getElementById('select-all-checks').addEventListener('change', e => {
    const checks = filteredAndSortedChecks();
    if (e.target.checked) {
      checks.forEach(c => state.selected.add(c.id));
    } else {
      checks.forEach(c => state.selected.delete(c.id));
    }
    renderTable();
    refreshPdfButton();
  });

  // New check
  document.getElementById('btn-new-check').addEventListener('click', () => openPanel());

  // Panel close
  document.getElementById('btn-close-panel').addEventListener('click', closePanel);
  document.getElementById('btn-cancel').addEventListener('click', closePanel);
  document.getElementById('panel-overlay').addEventListener('click', closePanel);

  // Form submit
  document.getElementById('check-form').addEventListener('submit', saveCheck);

  // Generate PDF
  document.getElementById('btn-generate-pdf').addEventListener('click', generatePdf);

  // Wizard
  document.getElementById('btn-wizard-next').addEventListener('click', () => {
    if (validateWizardStep()) goToWizardStep(wizard.step + 1);
  });
  document.getElementById('btn-wizard-prev').addEventListener('click', () => goToWizardStep(wizard.step - 1));
  document.getElementById('btn-wizard-finish').addEventListener('click', finishWizard);
  document.getElementById('btn-wizard-skip').addEventListener('click', () => {
    closeWizard();
    openImportModal();
  });
  document.getElementById('w-logo').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) { wizard.logoData = null; return; }
    const reader = new FileReader();
    reader.onload = ev => { wizard.logoData = ev.target.result; };
    reader.readAsDataURL(file);
  });

  // Import modal
  document.getElementById('btn-import').addEventListener('click', openImportModal);
  document.getElementById('btn-close-import').addEventListener('click', closeImportModal);
  document.getElementById('btn-cancel-import').addEventListener('click', closeImportModal);
  document.getElementById('import-modal-overlay').addEventListener('click', closeImportModal);
  document.getElementById('btn-run-import').addEventListener('click', runImport);

  // Account switcher
  document.getElementById('account-switcher').addEventListener('change', e => {
    switchAccount(parseInt(e.target.value, 10));
  });

  // Account settings modal
  document.getElementById('btn-account-settings').addEventListener('click', openAccountSettings);
  document.getElementById('btn-close-acct-settings').addEventListener('click', closeAccountSettings);
  document.getElementById('btn-cancel-acct-settings').addEventListener('click', closeAccountSettings);
  document.getElementById('acct-settings-overlay').addEventListener('click', closeAccountSettings);
  document.getElementById('btn-save-acct-settings').addEventListener('click', saveAccountSettings);

  document.getElementById('btn-set-check-no').addEventListener('click', openSetCheckNo);
  document.getElementById('btn-close-set-check-no').addEventListener('click', closeSetCheckNo);
  document.getElementById('btn-cancel-set-check-no').addEventListener('click', closeSetCheckNo);
  document.getElementById('set-check-no-overlay').addEventListener('click', closeSetCheckNo);
  document.getElementById('btn-confirm-set-check-no').addEventListener('click', saveSetCheckNo);
  document.getElementById('set-check-no-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveSetCheckNo();
    if (e.key === 'Escape') closeSetCheckNo();
  });
  document.getElementById('as-logo').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) { acctSettings.logoData = null; return; }
    const reader = new FileReader();
    reader.onload = ev => {
      acctSettings.logoData = ev.target.result;
      const preview = document.getElementById('as-logo-preview');
      preview.innerHTML = `<img src="${ev.target.result}" alt="Logo preview">`;
      preview.hidden = false;
    };
    reader.readAsDataURL(file);
  });

  // View tabs (Checks / Deposits)
  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const view = tab.dataset.view;
      document.getElementById('view-checks').hidden   = view !== 'checks';
      document.getElementById('view-deposits').hidden = view !== 'deposits';
      if (view === 'deposits') loadDeposits();
    });
  });

  // Deposit filters
  document.getElementById('dep-filter-from').addEventListener('change', renderDepositsTable);
  document.getElementById('dep-filter-to').addEventListener('change', renderDepositsTable);
  document.getElementById('dep-filter-status').addEventListener('change', renderDepositsTable);

  // Deposit panel
  document.getElementById('btn-new-deposit').addEventListener('click', () => openDepositPanel());
  document.getElementById('btn-close-dep-panel').addEventListener('click', closeDepositPanel);
  document.getElementById('btn-cancel-deposit').addEventListener('click', closeDepositPanel);
  document.getElementById('dep-panel-overlay').addEventListener('click', closeDepositPanel);
  document.getElementById('btn-save-deposit').addEventListener('click', saveDeposit);
  document.getElementById('btn-add-dep-item').addEventListener('click', () => {
    depState.items.push(newDepItem());
    renderDepItems();
  });
  document.getElementById('btn-dep-slip').addEventListener('click',   () => generateDepositPdf('slip'));
  document.getElementById('btn-dep-report').addEventListener('click', () => generateDepositPdf('report'));

  // Deposit panel live recalc
  ['dep-currency', 'dep-coin', 'dep-cashback'].forEach(id => {
    document.getElementById(id).addEventListener('input', recalcDepTotals);
  });

  // Initial data load
  loadAccounts();
}

document.addEventListener('DOMContentLoaded', init);
