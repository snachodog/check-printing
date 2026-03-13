'use strict';

const state = {
  checks: [],
  account: null,
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

async function loadAccount() {
  try {
    state.account = await apiFetch('GET', '/api/account');
    renderHeader();
  } catch (err) {
    if (err.message && err.message.includes('No account')) openWizard();
  }
}

async function loadChecks() {
  const tbody = document.getElementById('checks-tbody');
  tbody.innerHTML = '<tr class="loading-row"><td colspan="8">Loading…</td></tr>';
  try {
    state.checks = await apiFetch('GET', '/api/checks');
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
  document.getElementById('current-check-no').textContent = (a.current_check_no + 1).toLocaleString();
}

function renderTable() {
  const checks = filteredAndSortedChecks();
  const tbody = document.getElementById('checks-tbody');

  if (checks.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No checks found.</td></tr>';
    updateSortIndicators();
    return;
  }

  tbody.innerHTML = checks.map(renderRow).join('');
  updateSortIndicators();

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
      await apiFetch('POST', '/api/checks', data);
    }
    closePanel();
    await Promise.all([loadAccount(), loadChecks()]);
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
      body: JSON.stringify({ checkIds: ids }),
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
    await apiFetch('POST', '/api/account/setup', payload);
    closeWizard();
    await Promise.all([loadAccount(), loadChecks()]);
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
      await Promise.all([loadAccount(), loadChecks()]);
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

  // Initial data load
  loadAccount();
  loadChecks();
}

document.addEventListener('DOMContentLoaded', init);
