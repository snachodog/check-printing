'use strict';

const state = {
  checks: [],
  account: null,
  accounts: [],
  activeAccountId: parseInt(localStorage.getItem('activeAccountId'), 10) || null,
  filterStatus: '',
  filterPayee: '',
  filterDateFrom: '',
  filterDateTo: '',
  sortCol: 'check_no',
  sortDir: 'desc',
  selected: new Set(),
  editingId: null,
  user: null,        // { id, username, role }
  accountRole: null, // 'editor' or 'viewer' for the current account
};

// ── API helpers ──────────────────────────────────────────────────────────────

async function apiFetch(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) { showLoginOverlay(); return null; }
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function showLoginOverlay() {
  document.getElementById('login-overlay').classList.remove('hidden');
}

function hideLoginOverlay() {
  document.getElementById('login-overlay').classList.add('hidden');
}

function showLoginSection(section) {
  ['login-setup-section', 'login-form-section', 'login-forgot-section', 'login-reset-section']
    .forEach(id => { document.getElementById(id).hidden = id !== section; });
}

async function checkAuth() {
  // Password reset link detection
  if (location.hash.startsWith('#reset?')) {
    showLoginSection('login-reset-section');
    showLoginOverlay();
    return false;
  }

  // OIDC callback error/success detection
  if (location.hash.startsWith('#oidc-error=')) {
    const msg = decodeURIComponent(location.hash.slice('#oidc-error='.length));
    history.replaceState(null, '', location.pathname);
    showLoginSection('login-form-section');
    const errEl = document.getElementById('login-error');
    errEl.textContent = msg;
    errEl.hidden = false;
    showLoginOverlay();
    return false;
  }
  if (location.hash === '#oidc-linked') {
    history.replaceState(null, '', location.pathname);
    // Fall through to normal auth check — user is still logged in
  }

  // Is there already a session?
  const res = await fetch('/api/auth/me');
  if (res.ok) {
    state.user = await res.json();
    hideLoginOverlay();
    applyRoleUI();
    return true;
  }
  // No session — check if this is first-run (no users at all)
  const setup = await fetch('/api/auth/setup-needed');
  const { setupNeeded } = await setup.json();
  if (setupNeeded) {
    showLoginSection('login-setup-section');
  } else {
    showLoginSection('login-form-section');
  }
  // Show SSO button if OIDC is enabled
  loadOidcLoginButton();
  showLoginOverlay();
  return false;
}

async function loadOidcLoginButton() {
  try {
    const res = await fetch('/api/auth/oidc/config');
    if (!res.ok) return;
    const cfg = await res.json();
    const section = document.getElementById('oidc-login-section');
    if (cfg.enabled) {
      document.getElementById('btn-oidc-login').textContent = cfg.button_label || 'Sign in with SSO';
      section.hidden = false;
    } else {
      section.hidden = true;
    }
  } catch { /* ignore */ }
}

async function submitLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('btn-login-submit');
  errEl.hidden   = true;
  btn.disabled   = true;
  btn.textContent = 'Signing in…';
  try {
    state.user = await apiFetch('POST', '/api/auth/login', { username, password });
    if (!state.user) return; // 401 already handled by apiFetch
    hideLoginOverlay();
    applyRoleUI();
    await loadAccounts();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

async function submitSetup() {
  const username  = document.getElementById('setup-username').value.trim();
  const password  = document.getElementById('setup-password').value;
  const password2 = document.getElementById('setup-password2').value;
  const errEl     = document.getElementById('setup-error');
  const btn       = document.getElementById('btn-setup-submit');
  errEl.hidden    = true;
  if (password !== password2) { errEl.textContent = 'Passwords do not match.'; errEl.hidden = false; return; }
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    state.user = await apiFetch('POST', '/api/auth/setup', { username, password });
    hideLoginOverlay();
    applyRoleUI();
    await loadAccounts();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Admin & Sign In';
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  state.user = null;
  state.checks = [];
  state.accounts = [];
  state.account = null;
  state.activeAccountId = null;
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').hidden = true;
  document.getElementById('login-setup-section').hidden = true;
  document.getElementById('login-form-section').hidden  = false;
  showLoginOverlay();
}

// Hide/show elements based on role
function applyRoleUI() {
  const role = state.user ? state.user.role : 'viewer';
  const isAdmin  = role === 'admin';
  // For editor-only elements, use per-account role when available
  const isEditor = state.accountRole === 'editor' || (!state.accountRole && (role === 'admin' || role === 'editor'));

  document.getElementById('header-username').textContent = state.user ? state.user.username : '';

  // Admin-only elements
  document.querySelectorAll('[data-admin-only]').forEach(el => { el.hidden = !isAdmin; });

  // Editor+ elements (hide for viewers)
  document.querySelectorAll('[data-editor-only]').forEach(el => { el.hidden = !isEditor; });

  // Users button (admin only)
  document.getElementById('btn-users').hidden = !isAdmin;
}

// ── User management ────────────────────────────────────────────────────────────

let usersState = { users: [], editingId: null };

function openUsersModal() {
  const isAdmin = state.user && state.user.role === 'admin';
  document.getElementById('user-form-error').hidden = true;
  document.getElementById('users-title').textContent = isAdmin ? 'Manage Users' : 'My Account';
  document.getElementById('users-overlay').classList.add('open');
  document.getElementById('users-modal').classList.add('open');
  // Admin-only sections
  document.getElementById('users-list').hidden = !isAdmin;
  document.getElementById('user-form-section').hidden = !isAdmin;
  document.getElementById('smtp-settings-section').hidden = !isAdmin;
  document.getElementById('oidc-settings-section').hidden = !isAdmin;
  if (isAdmin) {
    loadUsers();
    renderUfAccountCheckboxes();
    loadSmtpSettings();
    loadOidcSettings();
  }
  loadOidcLinkStatus();
}

function closeUsersModal() {
  document.getElementById('users-overlay').classList.remove('open');
  document.getElementById('users-modal').classList.remove('open');
  cancelUserEdit();
}

async function loadUsers() {
  try {
    usersState.users = await apiFetch('GET', '/api/users');
    renderUsersList();
  } catch (err) {
    document.getElementById('users-list').innerHTML =
      `<p style="color:var(--danger)">${escHtml(err.message)}</p>`;
  }
}

function roleBadge(role) {
  const colors = { admin: '#2563eb', editor: '#16a34a', viewer: '#6b7280' };
  return `<span style="background:${colors[role]};color:#fff;font-size:10px;font-weight:600;padding:1px 6px;border-radius:3px;text-transform:uppercase">${role}</span>`;
}

function renderUsersList() {
  const el = document.getElementById('users-list');
  const { users } = usersState;
  if (!users.length) { el.innerHTML = '<p style="color:var(--text-muted)">No users.</p>'; return; }

  el.innerHTML = `<table class="qbo-preview-table" style="width:100%">
    <thead><tr><th>Username</th><th>Role</th><th>Account Access</th><th></th></tr></thead>
    <tbody>
    ${users.map(u => {
      const isSelf = u.id === state.user.id;
      const accountsLabel = u.role === 'admin'
        ? '<em style="color:var(--text-muted)">All accounts (editor)</em>'
        : (u.accounts.length ? u.accounts.map(ua => {
            const a = state.accounts.find(x => x.id === ua.account_id);
            const name = escHtml(a ? (a.company1 || `Account ${a.account_id}`) : `#${ua.account_id}`);
            return `${name} <span style="font-size:10px;color:${ua.role === 'editor' ? '#16a34a' : '#6b7280'};font-weight:600;text-transform:uppercase">${ua.role}</span>`;
          }).join(', ') : '<em style="color:var(--text-muted)">None</em>');
      const oidcTag = u.oidc_sub ? ' <span style="font-size:10px;color:#2563eb;font-weight:600" title="OIDC linked">SSO</span>' : '';
      return `<tr>
        <td><strong>${escHtml(u.username)}</strong>${isSelf ? ' <em style="color:var(--text-muted)">(you)</em>' : ''}${oidcTag}</td>
        <td>${roleBadge(u.role)}</td>
        <td style="font-size:12px">${accountsLabel}</td>
        <td style="white-space:nowrap">
          <button class="btn-sm btn-secondary user-btn-edit" data-id="${u.id}">Edit</button>
          ${!isSelf ? `<button class="btn-sm btn-danger user-btn-delete" style="margin-left:4px" data-id="${u.id}">Delete</button>` : ''}
        </td>
      </tr>`;
    }).join('')}
    </tbody></table>`;
}

function renderUfAccountCheckboxes() {
  const role = document.getElementById('uf-role').value;
  const group = document.getElementById('uf-accounts-group');
  group.hidden = role === 'admin';
  const container = document.getElementById('uf-accounts-checkboxes');
  const currentAccounts = usersState.editingId
    ? (usersState.users.find(u => u.id === usersState.editingId) || {}).accounts || []
    : [];
  container.innerHTML = state.accounts.map(a => {
    const assignment = currentAccounts.find(x => x.account_id === a.id);
    const checked = !!assignment;
    const acctRole = assignment ? assignment.role : 'viewer';
    return `<label class="account-checkbox-label">
      <input type="checkbox" name="uf-account" value="${a.id}"${checked ? ' checked' : ''}>
      ${escHtml(a.company1 || a.bank_name || `Account ${a.id}`)}
      <select name="uf-account-role" data-account-id="${a.id}" style="margin-left:6px;font-size:12px">
        <option value="editor"${acctRole === 'editor' ? ' selected' : ''}>Editor</option>
        <option value="viewer"${acctRole === 'viewer' ? ' selected' : ''}>Viewer</option>
      </select>
    </label>`;
  }).join('');
}

function startUserEdit(userId) {
  const u = usersState.users.find(x => x.id === userId);
  if (!u) return;
  usersState.editingId = userId;
  document.getElementById('user-form-title').textContent = `Edit User: ${u.username}`;
  document.getElementById('uf-username').value  = u.username;
  document.getElementById('uf-email').value     = u.email || '';
  document.getElementById('uf-password').value  = '';
  document.getElementById('uf-password-hint').textContent = '(leave blank to keep)';
  document.getElementById('uf-role').value       = u.role;
  document.getElementById('btn-save-user').textContent   = 'Save Changes';
  document.getElementById('btn-cancel-user-edit').hidden = false;
  document.getElementById('user-form-error').hidden = true;
  // OIDC fields
  document.getElementById('uf-oidc-sub').value    = u.oidc_sub || '';
  document.getElementById('uf-oidc-issuer').value = u.oidc_issuer || '';
  document.getElementById('uf-oidc-group').hidden = false;
  renderUfAccountCheckboxes();
  document.getElementById('uf-username').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelUserEdit() {
  usersState.editingId = null;
  document.getElementById('user-form-title').textContent    = 'Add User';
  document.getElementById('uf-username').value  = '';
  document.getElementById('uf-email').value     = '';
  document.getElementById('uf-password').value  = '';
  document.getElementById('uf-password-hint').textContent = '(min 10 chars, include a digit or symbol)';
  document.getElementById('uf-role').value       = 'viewer';
  document.getElementById('btn-save-user').textContent     = 'Add User';
  document.getElementById('btn-cancel-user-edit').hidden   = true;
  document.getElementById('user-form-error').hidden = true;
  // OIDC fields
  document.getElementById('uf-oidc-sub').value    = '';
  document.getElementById('uf-oidc-issuer').value = '';
  document.getElementById('uf-oidc-group').hidden = true;
  renderUfAccountCheckboxes();
}

async function saveUser() {
  const errEl    = document.getElementById('user-form-error');
  const btn      = document.getElementById('btn-save-user');
  errEl.hidden   = true;
  const username = document.getElementById('uf-username').value.trim();
  const email    = document.getElementById('uf-email').value.trim();
  const password = document.getElementById('uf-password').value;
  const role     = document.getElementById('uf-role').value;
  const accounts = Array.from(document.querySelectorAll('input[name="uf-account"]:checked'))
    .map(cb => {
      const accountId = parseInt(cb.value, 10);
      const roleSelect = document.querySelector(`select[name="uf-account-role"][data-account-id="${accountId}"]`);
      return { id: accountId, role: roleSelect ? roleSelect.value : 'viewer' };
    });

  if (!username) { errEl.textContent = 'Username required.'; errEl.hidden = false; return; }
  if (!usersState.editingId && !password) { errEl.textContent = 'Password required.'; errEl.hidden = false; return; }

  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = 'Saving…';
  try {
    const body = { username, email, role, accounts };
    if (password) body.password = password;
    if (usersState.editingId) {
      body.oidc_sub    = document.getElementById('uf-oidc-sub').value.trim();
      body.oidc_issuer = document.getElementById('uf-oidc-issuer').value.trim();
      await apiFetch('PUT', `/api/users/${usersState.editingId}`, body);
    } else {
      await apiFetch('POST', '/api/users', body);
    }
    cancelUserEdit();
    await loadUsers();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function deleteUser(userId) {
  const u = usersState.users.find(x => x.id === userId);
  if (!u) return;
  if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
  try {
    await apiFetch('DELETE', `/api/users/${userId}`);
    if (usersState.editingId === userId) cancelUserEdit();
    await loadUsers();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

async function changeOwnPassword() {
  const errEl   = document.getElementById('cp-error');
  const successEl = document.getElementById('cp-success');
  const btn     = document.getElementById('btn-change-password');
  errEl.hidden    = true;
  successEl.hidden = true;
  const current = document.getElementById('cp-current').value;
  const next    = document.getElementById('cp-new').value;
  const confirm2 = document.getElementById('cp-confirm').value;
  if (next !== confirm2) { errEl.textContent = 'New passwords do not match.'; errEl.hidden = false; return; }
  btn.disabled = true;
  try {
    await apiFetch('POST', '/api/auth/change-password', { current_password: current, new_password: next });
    document.getElementById('cp-current').value = '';
    document.getElementById('cp-new').value     = '';
    document.getElementById('cp-confirm').value  = '';
    successEl.hidden = false;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadAccounts() {
  try {
    state.accounts = await apiFetch('GET', '/api/accounts');
    if (!state.accounts) return; // 401 redirect handled by apiFetch
    if (state.accounts.length === 0) {
      // Only admins can create accounts; non-admins just see an empty state
      if (state.user && state.user.role === 'admin') openWizard();
      return;
    }
    // Use stored account or default to first
    const stored = state.activeAccountId;
    const valid = stored && state.accounts.find(a => a.id === stored);
    state.activeAccountId = valid ? stored : state.accounts[0].id;
    localStorage.setItem('activeAccountId', state.activeAccountId);

    populateAccountSwitcher();
    const activeAcct = state.accounts.find(a => a.id === state.activeAccountId);
    state.accountRole = activeAcct ? activeAcct.user_role : null;
    applyRoleUI();
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
  const activeAcct = state.accounts.find(a => a.id === accountId);
  state.accountRole = activeAcct ? activeAcct.user_role : null;
  applyRoleUI();
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

  const isEditor = state.accountRole === 'editor' ||
    (!state.accountRole && state.user && (state.user.role === 'admin' || state.user.role === 'editor'));

  const checkbox = isEditor
    ? `<td class="col-select"><input type="checkbox" data-id="${c.id}"${selected ? ' checked' : ''}></td>`
    : `<td class="col-select"></td>`;

  const statusBadge = printed
    ? '<span class="status-badge status-printed">Printed</span>'
    : '<span class="status-badge status-unprinted">Unprinted</span>';
  const actions = isEditor
    ? `<button class="btn-sm btn-edit" data-id="${c.id}">Edit</button>` +
      `<button class="btn-sm btn-delete" data-id="${c.id}">Delete</button>`
    : '';

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
  document.getElementById('as-second-sig').checked = !!a.second_signature;

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
    offset_down:      parseFloat(f.elements.offset_down.value)  || 0,
    second_signature: document.getElementById('as-second-sig').checked ? 1 : 0,
    logo_data:        acctSettings.logoData || null,
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

// ── Delete account ────────────────────────────────────────────────────────────

function openDeleteAccount() {
  const name = (state.account && state.account.company1) || 'this account';
  document.getElementById('delete-account-name').textContent = name;
  document.getElementById('delete-account-overlay').classList.add('open');
  document.getElementById('delete-account-modal').classList.add('open');
}

function closeDeleteAccount() {
  document.getElementById('delete-account-overlay').classList.remove('open');
  document.getElementById('delete-account-modal').classList.remove('open');
}

async function confirmDeleteAccount() {
  const btn = document.getElementById('btn-confirm-delete-account');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    await apiFetch('DELETE', `/api/account/${state.activeAccountId}`);
    closeDeleteAccount();
    closeAccountSettings();
    state.account = null;
    state.activeAccountId = null;
    state.checks = [];
    localStorage.removeItem('activeAccountId');
    await loadAccounts(); // will open wizard if no accounts remain
  } catch (err) {
    alert('Delete failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Yes, Delete Account';
  }
}

// ── QBO Import ────────────────────────────────────────────────────────────────

let qboChecksRecords = null;
let qboDepositsRecords = null;

function openQboImport(tab) {
  switchQboTab(tab || 'checks');
  resetQboPane('checks');
  resetQboPane('deposits');
  document.getElementById('qbo-import-overlay').classList.add('open');
  document.getElementById('qbo-import-modal').classList.add('open');
}

function closeQboImport() {
  document.getElementById('qbo-import-overlay').classList.remove('open');
  document.getElementById('qbo-import-modal').classList.remove('open');
}

function resetQboPane(type) {
  document.getElementById(`qbo-${type}-file`).value = '';
  document.getElementById(`qbo-${type}-preview`).hidden = true;
  document.getElementById(`qbo-${type}-preview`).innerHTML = '';
  document.getElementById(`qbo-${type}-result`).hidden = true;
  document.getElementById(`qbo-${type}-result`).textContent = '';
  document.getElementById(`qbo-${type}-error`).hidden = true;
  document.getElementById(`qbo-${type}-error`).textContent = '';
  document.getElementById(`btn-qbo-${type}-import`).hidden = true;
  document.getElementById(`btn-qbo-${type}-import`).disabled = true;
  if (type === 'checks') qboChecksRecords = null;
  else qboDepositsRecords = null;
}

function switchQboTab(tab) {
  document.querySelectorAll('.qbo-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('qbo-pane-checks').hidden = tab !== 'checks';
  document.getElementById('qbo-pane-deposits').hidden = tab !== 'deposits';
}

async function qboParseFile(type) {
  const fileInput = document.getElementById(`qbo-${type}-file`);
  const errEl     = document.getElementById(`qbo-${type}-error`);
  const previewEl = document.getElementById(`qbo-${type}-preview`);
  const resultEl  = document.getElementById(`qbo-${type}-result`);
  const importBtn = document.getElementById(`btn-qbo-${type}-import`);
  const parseBtn  = document.getElementById(`btn-qbo-${type}-parse`);

  errEl.hidden = true;
  previewEl.hidden = true;
  previewEl.innerHTML = '';
  resultEl.hidden = true;
  importBtn.hidden = true;
  importBtn.disabled = true;

  const file = fileInput.files[0];
  if (!file) { errEl.textContent = 'Select a CSV file first.'; errEl.hidden = false; return; }

  parseBtn.disabled = true;
  parseBtn.textContent = 'Parsing\u2026';

  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('type', type);
    const resp = await fetch('/api/qbo-import/parse', { method: 'POST', body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Parse failed');

    if (type === 'checks') {
      qboChecksRecords = data.records;
      previewEl.innerHTML = buildChecksPreviewHTML(data.records, data.warnings);
    } else {
      qboDepositsRecords = data.records;
      previewEl.innerHTML = buildDepositsPreviewHTML(data.records, data.warnings);
    }
    previewEl.hidden = false;
    const depCount = type === 'deposits' ? countDepositDates(data.records) : 0;
    importBtn.textContent = type === 'checks'
      ? `Import ${data.records.length} Check${data.records.length !== 1 ? 's' : ''}`
      : `Import ${depCount} Deposit${depCount !== 1 ? 's' : ''}`;
    importBtn.hidden = false;
    importBtn.disabled = false;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    parseBtn.disabled = false;
    parseBtn.textContent = 'Preview';
  }
}

function countDepositDates(records) {
  return new Set(records.map(r => r.date)).size;
}

const fmtCurrency = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const fmtDateDisp = iso => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };

function buildChecksPreviewHTML(records, warnings) {
  let html = `<div class="qbo-preview-count">${records.length} check${records.length !== 1 ? 's' : ''} found</div>`;
  if (warnings && warnings.length) {
    html += `<div class="qbo-warnings">${warnings.map(w => escHtml(w)).join('<br>')}</div>`;
  }
  html += `<div class="qbo-preview-scroll"><table class="qbo-preview-table">
    <thead><tr><th>Date</th><th>Payee</th><th style="text-align:right">Amount</th><th>Memo</th><th>Check #</th></tr></thead>
    <tbody>`;
  for (const r of records) {
    html += `<tr>
      <td>${escHtml(fmtDateDisp(r.date))}</td>
      <td>${escHtml(r.payee || '')}</td>
      <td style="text-align:right;font-family:monospace">${escHtml(fmtCurrency(r.amount))}</td>
      <td class="text-muted">${escHtml(r.memo || '')}</td>
      <td class="text-muted">${r.check_no ? escHtml(String(r.check_no)) : '<em>auto</em>'}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  return html;
}

function buildDepositsPreviewHTML(records, warnings) {
  const byDate = new Map();
  for (const r of records) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const dateCount = byDate.size;
  let html = `<div class="qbo-preview-count">${records.length} item${records.length !== 1 ? 's' : ''} across ${dateCount} deposit${dateCount !== 1 ? 's' : ''}</div>`;
  if (warnings && warnings.length) {
    html += `<div class="qbo-warnings">${warnings.map(w => escHtml(w)).join('<br>')}</div>`;
  }
  html += `<div class="qbo-preview-scroll"><table class="qbo-preview-table">
    <thead><tr><th>Date</th><th>Items</th><th style="text-align:right">Total</th></tr></thead>
    <tbody>`;
  for (const [date, items] of byDate) {
    const total = items.reduce((s, i) => s + i.amount, 0);
    html += `<tr>
      <td>${escHtml(fmtDateDisp(date))}</td>
      <td class="text-muted">${items.length} item${items.length !== 1 ? 's' : ''}</td>
      <td style="text-align:right;font-family:monospace">${escHtml(fmtCurrency(total))}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  return html;
}

async function qboConfirmImport(type) {
  const records = type === 'checks' ? qboChecksRecords : qboDepositsRecords;
  const errEl    = document.getElementById(`qbo-${type}-error`);
  const resultEl = document.getElementById(`qbo-${type}-result`);
  const importBtn = document.getElementById(`btn-qbo-${type}-import`);

  errEl.hidden = true;
  importBtn.disabled = true;
  importBtn.textContent = 'Importing\u2026';

  try {
    const data = await apiFetch('POST', '/api/qbo-import/confirm', {
      type, records, account_id: state.activeAccountId,
    });

    if (type === 'checks') {
      resultEl.textContent = `Imported ${data.imported} check${data.imported !== 1 ? 's' : ''}${data.skipped ? `, skipped ${data.skipped} duplicate${data.skipped !== 1 ? 's' : ''}` : ''}.`;
      await loadChecks();
      await loadAccounts();
      renderHeader();
    } else {
      resultEl.textContent = `Imported ${data.imported} deposit${data.imported !== 1 ? 's' : ''} (${data.itemCount} items).`;
      if (typeof loadDeposits === 'function') await loadDeposits();
    }
    resultEl.hidden = false;
    importBtn.hidden = true;

    document.getElementById(`qbo-${type}-file`).value = '';
    if (type === 'checks') qboChecksRecords = null;
    else qboDepositsRecords = null;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    importBtn.disabled = false;
    importBtn.textContent = type === 'checks' ? 'Import Checks' : 'Import Deposits';
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

  const isEditor = state.accountRole === 'editor' ||
    (!state.accountRole && state.user && (state.user.role === 'admin' || state.user.role === 'editor'));

  tbody.innerHTML = list.map(d => {
    const cashTotal    = (d.currency || 0) + (d.coin || 0);
    const checksTotal  = d.checks_total || 0;
    const depositTotal = cashTotal + checksTotal - (d.cash_back || 0);
    const printed      = !!d.printed;
    const badge        = printed
      ? '<span class="status-badge status-printed">Printed</span>'
      : '<span class="status-badge status-unprinted">Unprinted</span>';
    const actions = isEditor
      ? `<button class="btn-sm btn-edit dep-btn-edit" data-id="${d.id}">Edit</button>` +
        `<button class="btn-sm btn-delete dep-btn-delete" data-id="${d.id}">Delete</button>`
      : '';
    return `<tr class="${printed ? 'printed' : ''}">
      <td class="col-date">${fmtDate(d.deposit_date)}</td>
      <td class="col-amount" style="text-align:right">${fmt(checksTotal)}</td>
      <td class="col-amount" style="text-align:right">${fmt(cashTotal)}</td>
      <td class="col-amount" style="text-align:right">${fmt(d.cash_back)}</td>
      <td class="col-amount" style="text-align:right"><strong>${fmt(depositTotal)}</strong></td>
      <td style="text-align:center">${d.item_count || 0}</td>
      <td class="col-status">${badge}</td>
      <td class="col-actions">${actions}</td>
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

// ── Forgot / Reset password ──────────────────────────────────────────────────

async function submitForgotPassword() {
  const errEl     = document.getElementById('forgot-error');
  const successEl = document.getElementById('forgot-success');
  const btn       = document.getElementById('btn-forgot-submit');
  errEl.hidden = true; successEl.hidden = true;
  const email = document.getElementById('forgot-email').value.trim();
  if (!email) { errEl.textContent = 'Email is required.'; errEl.hidden = false; return; }
  btn.disabled = true;
  try {
    const data = await apiFetch('POST', '/api/auth/forgot-password', { email });
    if (data) { successEl.textContent = data.message; successEl.hidden = false; }
  } catch (err) {
    errEl.textContent = err.message; errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function submitResetPassword() {
  const errEl     = document.getElementById('reset-error');
  const successEl = document.getElementById('reset-success');
  const btn       = document.getElementById('btn-reset-submit');
  errEl.hidden = true; successEl.hidden = true;
  const password  = document.getElementById('reset-password').value;
  const password2 = document.getElementById('reset-password2').value;
  if (password !== password2) { errEl.textContent = 'Passwords do not match.'; errEl.hidden = false; return; }
  const token = new URLSearchParams(location.hash.slice(location.hash.indexOf('?'))).get('token');
  if (!token) { errEl.textContent = 'No reset token found.'; errEl.hidden = false; return; }
  btn.disabled = true;
  try {
    await apiFetch('POST', '/api/auth/reset-password', { token, new_password: password });
    successEl.textContent = 'Password updated. You can now sign in.';
    successEl.hidden = false;
    btn.disabled = true;
    history.replaceState(null, '', '/');
    setTimeout(() => showLoginSection('login-form-section'), 2000);
  } catch (err) {
    errEl.textContent = err.message; errEl.hidden = false;
    btn.disabled = false;
  }
}

// ── SMTP Settings ─────────────────────────────────────────────────────────────

async function loadSmtpSettings() {
  try {
    const s = await apiFetch('GET', '/api/settings/smtp');
    if (!s) return;
    document.getElementById('smtp-host').value   = s.host;
    document.getElementById('smtp-port').value   = s.port;
    document.getElementById('smtp-secure').value = s.secure ? '1' : '0';
    document.getElementById('smtp-user').value   = s.user;
    document.getElementById('smtp-from').value   = s.from;
    document.getElementById('smtp-pass-hint').textContent = s.has_password ? '(leave blank to keep)' : '';
  } catch (_) {}
}

async function saveSmtpSettings() {
  const errEl     = document.getElementById('smtp-error');
  const successEl = document.getElementById('smtp-success');
  const btn       = document.getElementById('btn-save-smtp');
  errEl.hidden = true; successEl.hidden = true;
  btn.disabled = true;
  try {
    await apiFetch('PUT', '/api/settings/smtp', {
      host:   document.getElementById('smtp-host').value.trim(),
      port:   document.getElementById('smtp-port').value,
      secure: document.getElementById('smtp-secure').value === '1',
      user:   document.getElementById('smtp-user').value.trim(),
      pass:   document.getElementById('smtp-pass').value,
      from:   document.getElementById('smtp-from').value.trim(),
    });
    successEl.textContent = 'Saved.'; successEl.hidden = false;
    document.getElementById('smtp-pass').value = '';
    await loadSmtpSettings();
    setTimeout(() => { successEl.hidden = true; }, 3000);
  } catch (err) {
    errEl.textContent = err.message; errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

// ── OIDC settings ────────────────────────────────────────────────────────────

async function loadOidcSettings() {
  try {
    const s = await apiFetch('GET', '/api/settings/oidc');
    if (!s) return;
    document.getElementById('oidc-enabled').value        = s.enabled ? '1' : '0';
    document.getElementById('oidc-discovery-url').value   = s.discovery_url;
    document.getElementById('oidc-client-id').value       = s.client_id;
    document.getElementById('oidc-redirect-uri').value    = s.redirect_uri;
    document.getElementById('oidc-button-label').value    = s.button_label;
    document.getElementById('oidc-secret-hint').textContent = s.has_secret ? '(leave blank to keep)' : '';
  } catch (_) {}
}

async function saveOidcSettings() {
  const errEl     = document.getElementById('oidc-error');
  const successEl = document.getElementById('oidc-success');
  const btn       = document.getElementById('btn-save-oidc');
  errEl.hidden = true; successEl.hidden = true;
  btn.disabled = true;
  try {
    await apiFetch('PUT', '/api/settings/oidc', {
      enabled:       document.getElementById('oidc-enabled').value === '1',
      discovery_url: document.getElementById('oidc-discovery-url').value.trim(),
      client_id:     document.getElementById('oidc-client-id').value.trim(),
      client_secret: document.getElementById('oidc-client-secret').value,
      redirect_uri:  document.getElementById('oidc-redirect-uri').value.trim(),
      button_label:  document.getElementById('oidc-button-label').value.trim(),
    });
    successEl.textContent = 'Saved.'; successEl.hidden = false;
    document.getElementById('oidc-client-secret').value = '';
    await loadOidcSettings();
    setTimeout(() => { successEl.hidden = true; }, 3000);
  } catch (err) {
    errEl.textContent = err.message; errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

// ── OIDC self-service linking ────────────────────────────────────────────────

async function loadOidcLinkStatus() {
  try {
    const cfg = await fetch('/api/auth/oidc/config').then(r => r.json());
    const section = document.getElementById('oidc-link-section');
    if (!cfg.enabled) { section.hidden = true; return; }
    section.hidden = false;

    const me = await apiFetch('GET', '/api/auth/me');
    const statusEl  = document.getElementById('oidc-link-status');
    const linkBtn   = document.getElementById('btn-oidc-link');
    const unlinkBtn = document.getElementById('btn-oidc-unlink');

    if (me.oidc_linked) {
      statusEl.textContent = 'Your account is linked to SSO.';
      linkBtn.hidden  = true;
      unlinkBtn.hidden = false;
    } else {
      statusEl.textContent = 'Link your account to sign in with SSO.';
      linkBtn.hidden  = false;
      unlinkBtn.hidden = true;
    }
  } catch (_) {}
}

async function unlinkOidc() {
  if (!confirm('Unlink your SSO identity? You will need to use your password to sign in.')) return;
  try {
    await apiFetch('POST', '/api/auth/oidc/unlink');
    await loadOidcLinkStatus();
  } catch (err) {
    alert(err.message);
  }
}

// ── Initialization ───────────────────────────────────────────────────────────

async function init() {
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

  document.getElementById('btn-delete-account').addEventListener('click', openDeleteAccount);
  document.getElementById('btn-close-delete-account').addEventListener('click', closeDeleteAccount);
  document.getElementById('btn-cancel-delete-account').addEventListener('click', closeDeleteAccount);
  document.getElementById('delete-account-overlay').addEventListener('click', closeDeleteAccount);
  document.getElementById('btn-confirm-delete-account').addEventListener('click', confirmDeleteAccount);

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

  // QBO Import
  document.querySelectorAll('[data-open-qbo]').forEach(btn =>
    btn.addEventListener('click', () => openQboImport(btn.dataset.openQbo))
  );
  document.getElementById('btn-close-qbo-import').addEventListener('click', closeQboImport);
  document.getElementById('qbo-import-overlay').addEventListener('click', closeQboImport);
  document.querySelectorAll('.qbo-tab').forEach(t =>
    t.addEventListener('click', () => switchQboTab(t.dataset.tab))
  );
  document.getElementById('btn-qbo-checks-parse').addEventListener('click', () => qboParseFile('checks'));
  document.getElementById('btn-qbo-deposits-parse').addEventListener('click', () => qboParseFile('deposits'));
  document.getElementById('btn-qbo-checks-import').addEventListener('click', () => qboConfirmImport('checks'));
  document.getElementById('btn-qbo-deposits-import').addEventListener('click', () => qboConfirmImport('deposits'));
  document.getElementById('btn-qbo-checks-cancel').addEventListener('click', closeQboImport);
  document.getElementById('btn-qbo-deposits-cancel').addEventListener('click', closeQboImport);

  // Auth event listeners
  document.getElementById('btn-login-submit').addEventListener('click', submitLogin);
  document.getElementById('btn-setup-submit').addEventListener('click', submitSetup);
  document.getElementById('btn-logout').addEventListener('click', logout);
  document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') submitLogin(); });
  document.getElementById('setup-password2').addEventListener('keydown', e => { if (e.key === 'Enter') submitSetup(); });

  // Forgot / reset password
  document.getElementById('link-forgot-password').addEventListener('click', e => { e.preventDefault(); showLoginSection('login-forgot-section'); });
  document.getElementById('link-back-to-login').addEventListener('click', e => { e.preventDefault(); showLoginSection('login-form-section'); });
  document.getElementById('btn-forgot-submit').addEventListener('click', submitForgotPassword);
  document.getElementById('forgot-email').addEventListener('keydown', e => { if (e.key === 'Enter') submitForgotPassword(); });
  document.getElementById('btn-reset-submit').addEventListener('click', submitResetPassword);
  document.getElementById('reset-password2').addEventListener('keydown', e => { if (e.key === 'Enter') submitResetPassword(); });

  // User management
  document.getElementById('btn-users').addEventListener('click', openUsersModal);
  document.getElementById('header-username').addEventListener('click', openUsersModal);
  document.getElementById('btn-close-users').addEventListener('click', closeUsersModal);
  document.getElementById('users-overlay').addEventListener('click', closeUsersModal);
  document.getElementById('users-list').addEventListener('click', e => {
    const editBtn   = e.target.closest('.user-btn-edit');
    const deleteBtn = e.target.closest('.user-btn-delete');
    if (editBtn)   startUserEdit(parseInt(editBtn.dataset.id, 10));
    if (deleteBtn) deleteUser(parseInt(deleteBtn.dataset.id, 10));
  });
  document.getElementById('btn-save-user').addEventListener('click', saveUser);
  document.getElementById('btn-cancel-user-edit').addEventListener('click', cancelUserEdit);
  document.getElementById('uf-role').addEventListener('change', renderUfAccountCheckboxes);
  document.getElementById('btn-change-password').addEventListener('click', changeOwnPassword);
  document.getElementById('btn-save-smtp').addEventListener('click', saveSmtpSettings);
  document.getElementById('btn-save-oidc').addEventListener('click', saveOidcSettings);
  document.getElementById('btn-oidc-unlink').addEventListener('click', unlinkOidc);

  // Add checking account
  document.getElementById('btn-add-account').addEventListener('click', openWizard);

  // Layout editor
  document.getElementById('btn-layout-editor').addEventListener('click', openLayoutEditor);
  document.getElementById('btn-close-layout-editor').addEventListener('click', closeLayoutEditor);
  document.getElementById('layout-editor-overlay').addEventListener('click', closeLayoutEditor);
  document.getElementById('layout-field-select').addEventListener('change', e => selectLayoutField(parseInt(e.target.value, 10)));
  document.getElementById('layout-field-x').addEventListener('input', onLayoutSidebarChange);
  document.getElementById('layout-field-y').addEventListener('input', onLayoutSidebarChange);
  document.getElementById('layout-field-x2').addEventListener('input', onLayoutSidebarChange);
  document.getElementById('layout-field-y2').addEventListener('input', onLayoutSidebarChange);
  document.getElementById('layout-field-visible').addEventListener('change', onLayoutSidebarChange);
  document.getElementById('nudge-up').addEventListener('click',    () => nudgeLayoutField( 0, -1));
  document.getElementById('nudge-down').addEventListener('click',  () => nudgeLayoutField( 0,  1));
  document.getElementById('nudge-left').addEventListener('click',  () => nudgeLayoutField(-1,  0));
  document.getElementById('nudge-right').addEventListener('click', () => nudgeLayoutField( 1,  0));
  document.getElementById('btn-layout-reset').addEventListener('click', resetLayoutToDefault);

  // Initial auth check → loads app if already signed in
  const authed = await checkAuth();
  if (authed) await loadAccounts();
}

// ── Layout Editor ─────────────────────────────────────────────────────────────

let layoutState = { fields: [], selectedId: null, scale: 80 };
let layoutDrag = null;
let layoutSaveTimer = null;

const FIELD_LABELS = {
  'Company Name':         'Account Name (line 1)',
  'Company Name2':        'Account Address (line 2)',
  'Company Name3':        'Account City/State (line 3)',
  'Company Name4':        'Account Phone/Web (line 4)',
  'Check Number':         'Check Number',
  'Date Label':           'Date Label',
  'Date':                 'Date',
  'Pay To Label':         '"Pay To" Label',
  'Payee Name':           'Payee Name',
  'Dollar Sign':          'Dollar Sign ($)',
  'Amount':               'Amount (numeric)',
  'Text Amount':          'Amount (written)',
  'Dollars Label':        '"Dollars" Label',
  'Bank Information':     'Bank Information',
  'Bank Transit Code':    'Transit Code',
  'Payee Address':        'Payee Address',
  'Memo Label':           'Memo Label',
  'Memo':                 'Memo',
  'Auth Signature Label': '"Authorized Signature" Label',
  'Payee Line':           'Line: Payee',
  'Amount Box Top':       'Line: Amount Box (top)',
  'Amount Box Left':      'Line: Amount Box (left)',
  'Amount Box Bottom':    'Line: Amount Box (bottom)',
  'Text Amount Line':     'Line: Written Amount',
  'Memo Line':            'Line: Memo',
  'Signature Line':       'Line: Signature',
};
const FIELD_COLORS = { Regular: '#2563eb', Text: '#16a34a', Line: '#b45309', Graph: '#7c3aed' };

function fieldLabel(f)        { return FIELD_LABELS[f.field_name] || f.field_name; }
function round16(v)           { return Math.round(v * 16) / 16; }
function clampIn(v, lo, hi)   { return Math.max(lo, Math.min(hi, v)); }

const FRAC_MAP = [
  [0,''], [1/16,'¹⁄₁₆'], [1/8,'⅛'], [3/16,'³⁄₁₆'],
  [1/4,'¼'], [5/16,'⁵⁄₁₆'], [3/8,'⅜'], [7/16,'⁷⁄₁₆'],
  [1/2,'½'], [9/16,'⁹⁄₁₆'], [5/8,'⅝'], [11/16,'¹¹⁄₁₆'],
  [3/4,'¾'], [13/16,'¹³⁄₁₆'], [7/8,'⅞'], [15/16,'¹⁵⁄₁₆'],
];
function toFracStr(val) {
  const w = Math.floor(val);
  const dec = val - w;
  const fr = FRAC_MAP.reduce((a, b) => Math.abs(b[0] - dec) < Math.abs(a[0] - dec) ? b : a);
  const parts = [];
  if (w) parts.push(w);
  if (fr[1]) parts.push(fr[1]);
  return (parts.length ? parts.join(' ') : '0') + '"';
}
function setFracEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = toFracStr(val || 0);
}

function openLayoutEditor() {
  if (!state.activeAccountId) return;
  document.getElementById('layout-editor-overlay').classList.add('open');
  document.getElementById('layout-editor-modal').classList.add('open');
  loadLayoutFields();
}

function closeLayoutEditor() {
  document.getElementById('layout-editor-overlay').classList.remove('open');
  document.getElementById('layout-editor-modal').classList.remove('open');
  layoutState = { fields: [], selectedId: null, scale: 80 };
  clearTimeout(layoutSaveTimer);
}

async function loadLayoutFields() {
  try {
    layoutState.fields = await apiFetch('GET', `/api/layout/${state.activeAccountId}`);
    populateLayoutDropdown();
    requestAnimationFrame(() => {
      renderLayoutCanvas();
      if (layoutState.fields.length > 0) selectLayoutField(layoutState.fields[0].id);
    });
  } catch (err) {
    console.error('Failed to load layout fields:', err);
  }
}

function populateLayoutDropdown() {
  const sel = document.getElementById('layout-field-select');
  sel.innerHTML = layoutState.fields.map(f =>
    `<option value="${f.id}">${escHtml(fieldLabel(f))}</option>`
  ).join('');
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

function renderLayoutCanvas() {
  const container = document.getElementById('layout-canvas-container');
  const W = container.offsetWidth;
  if (W <= 0) return;
  const SCALE = W / 8.5;
  layoutState.scale = SCALE;
  const H = 3.5 * SCALE;

  container.innerHTML = '';
  const svg = svgEl('svg', { width: W, height: H, style: 'display:block;user-select:none' });

  // White check background
  svg.appendChild(svgEl('rect', { x:0, y:0, width:W, height:H, fill:'#fff', stroke:'#bbb', 'stroke-width':1 }));

  // MICR reference line
  const micrY = (3.5 - 0.267) * SCALE;
  svg.appendChild(svgEl('line', { x1:0, y1:micrY, x2:W, y2:micrY, stroke:'#ccc', 'stroke-width':1, 'stroke-dasharray':'4,4' }));
  svg.appendChild(svgEl('text', { x:4, y:micrY - 3, 'font-size':9, fill:'#bbb', 'font-family':'sans-serif' }, 'MICR'));

  for (const f of layoutState.fields) {
    const g = createFieldSvgElement(f, SCALE, layoutState.selectedId === f.id);
    svg.appendChild(g);
    attachFieldEvents(g, f);
  }

  container.appendChild(svg);
  renderRulers(W, H, SCALE);
}

function renderRulers(W, H, scale) {
  const RULER = 24;
  const topEl  = document.getElementById('layout-ruler-top');
  const leftEl = document.getElementById('layout-ruler-left');
  if (!topEl || !leftEl) return;

  // ── Horizontal ruler (top) ──────────────────────────────────────
  const topSvg = svgEl('svg', { width: W, height: RULER, style: 'display:block' });
  topSvg.appendChild(svgEl('rect', { x:0, y:0, width:W, height:RULER, fill:'var(--surface)' }));

  for (let n8 = 0; n8 <= Math.ceil(8.5 * 8); n8++) {
    const inches = n8 / 8;
    if (inches > 8.5) break;
    const x = inches * scale;
    const isInch = n8 % 8 === 0;
    const isHalf = n8 % 4 === 0;
    const isQtr  = n8 % 2 === 0;
    const tickH  = isInch ? RULER - 2 : isHalf ? 14 : isQtr ? 9 : 5;
    topSvg.appendChild(svgEl('line', { x1:x, y1:RULER, x2:x, y2:RULER - tickH, stroke:'#999', 'stroke-width': isInch ? 1 : 0.5 }));
    if (isInch && inches > 0) {
      topSvg.appendChild(svgEl('text', { x:x + 2, y:RULER - tickH - 1, 'font-size':8, fill:'#666', 'font-family':'sans-serif' }, inches + '"'));
    }
  }
  topEl.innerHTML = '';
  topEl.appendChild(topSvg);

  // ── Vertical ruler (left) ───────────────────────────────────────
  const leftSvg = svgEl('svg', { width: RULER, height: H, style: 'display:block' });
  leftSvg.appendChild(svgEl('rect', { x:0, y:0, width:RULER, height:H, fill:'var(--surface)' }));

  for (let n8 = 0; n8 <= Math.ceil(3.5 * 8); n8++) {
    const inches = n8 / 8;
    if (inches > 3.5) break;
    const y = inches * scale;
    const isInch = n8 % 8 === 0;
    const isHalf = n8 % 4 === 0;
    const isQtr  = n8 % 2 === 0;
    const tickW  = isInch ? RULER - 2 : isHalf ? 14 : isQtr ? 9 : 5;
    leftSvg.appendChild(svgEl('line', { x1:RULER, y1:y, x2:RULER - tickW, y2:y, stroke:'#999', 'stroke-width': isInch ? 1 : 0.5 }));
    if (isInch && inches > 0) {
      const t = svgEl('text', { 'font-size':8, fill:'#666', 'font-family':'sans-serif',
        'text-anchor':'end', x: RULER - tickW - 2, y: y + 3 }, inches + '"');
      leftSvg.appendChild(t);
    }
  }
  leftEl.innerHTML = '';
  leftEl.appendChild(leftSvg);
}

function getFieldDisplayValue(f) {
  const a = state.account || {};
  switch (f.field_name) {
    case 'Company Name':      return a.company1 || 'Company Name';
    case 'Company Name2':     return a.company2 || '';
    case 'Company Name3':     return a.company3 || '';
    case 'Company Name4':     return a.company4 || '';
    case 'Check Number':      return '1001';
    case 'Date':              return '01/01/2025';
    case 'Payee Name':        return 'Sample Payee';
    case 'Amount':            return '1,234.56';
    case 'Text Amount':       return 'One Thousand Two Hundred Thirty Four and 56/100---';
    case 'Bank Information':  return [a.bank_name, a.bank_info1, a.bank_info2, a.bank_info3].filter(Boolean);
    case 'Bank Transit Code': return a.transit_code || '';
    case 'Payee Address':     return ['123 Sample St', 'City, ST 12345'];
    case 'Memo':              return 'Sample Memo';
    default:
      if (f.field_type === 'Text') return f.field_text || '';
      return f.field_name;
  }
}

function createFieldSvgElement(f, scale, selected) {
  const g = svgEl('g', { 'data-field-id': f.id, style: `cursor:grab;opacity:${f.visible ? 1 : 0.35}` });
  const x = f.x_pos * scale;
  const y = f.y_pos * scale;

  if (f.field_type === 'Line') {
    const x1 = f.x_pos * scale, y1 = f.y_pos * scale;
    const x2 = f.x_end_pos * scale, y2 = f.y_end_pos * scale;
    g.appendChild(svgEl('line', { x1, y1, x2, y2, stroke:'transparent', 'stroke-width':10 }));
    g.appendChild(svgEl('line', { x1, y1, x2, y2, stroke: selected ? '#2563eb' : '#333', 'stroke-width': selected ? 2 : 1.5 }));
    if (selected) {
      g.appendChild(svgEl('circle', { cx:x1, cy:y1, r:3, fill:'#2563eb' }));
      g.appendChild(svgEl('circle', { cx:x2, cy:y2, r:3, fill:'#2563eb' }));
    }
    return g;
  }

  if (f.field_type === 'Graph') {
    const w = Math.max(4, (f.x_end_pos - f.x_pos) * scale);
    const h = Math.max(4, (f.y_end_pos - f.y_pos) * scale);
    g.appendChild(svgEl('rect', { x, y, width:w, height:h, fill:'#f0f0f0', stroke: selected ? '#2563eb' : '#aaa', 'stroke-width':1, 'stroke-dasharray':'4,3' }));
    g.appendChild(svgEl('text', { x:x+2, y:y+10, 'font-size':7, fill:'#999', 'font-family':'sans-serif' }, '[image]'));
    return g;
  }

  // Regular and Text fields — render actual content at proportional size
  const fontSize   = Math.max(6, (f.font_size || 10) / 72 * scale);
  const fontWeight = f.font_bold ? 'bold' : 'normal';
  const displayVal = getFieldDisplayValue(f);
  const lines      = Array.isArray(displayVal) ? displayVal : [String(displayVal)];
  const lineHeight = fontSize * 1.3;

  // Invisible hit area so the element is always draggable
  const approxCharW = fontSize * 0.58;
  const hitW = Math.max(20, lines.reduce((m, l) => Math.max(m, l.length * approxCharW), 0));
  const hitH = lines.length * lineHeight + 2;
  g.appendChild(svgEl('rect', { x, y: y - fontSize, width: hitW, height: hitH, fill: 'transparent' }));

  // Selection highlight
  if (selected) {
    g.appendChild(svgEl('rect', {
      x: x - 2, y: y - fontSize - 2,
      width: hitW + 4, height: hitH + 4,
      fill: 'rgba(37,99,235,0.06)', stroke: '#2563eb',
      'stroke-width': 1, 'stroke-dasharray': '4,3', rx: 2,
    }));
  }

  // Text content
  if (lines.length === 1) {
    g.appendChild(svgEl('text', {
      x, y,
      'font-size': fontSize,
      'font-family': 'Helvetica, Arial, sans-serif',
      'font-weight': fontWeight,
      fill: '#111',
    }, lines[0]));
  } else {
    const textEl = svgEl('text', {
      x, y,
      'font-size': fontSize,
      'font-family': 'Helvetica, Arial, sans-serif',
      'font-weight': fontWeight,
      fill: '#111',
    });
    lines.forEach((line, i) => {
      textEl.appendChild(svgEl('tspan', { x, dy: i === 0 ? 0 : lineHeight }, line));
    });
    g.appendChild(textEl);
  }

  return g;
}

function attachFieldEvents(g, f) {
  g.addEventListener('mousedown', e => {
    selectLayoutField(f.id);
    startLayoutDrag(e, f);
    e.stopPropagation();
    e.preventDefault();
  });
}

function selectLayoutField(id) {
  layoutState.selectedId = id;
  const sel = document.getElementById('layout-field-select');
  if (sel) sel.value = id;
  const f = layoutState.fields.find(x => x.id === id);
  if (f) updateLayoutSidebar(f);
  renderLayoutCanvas();
}

function updateLayoutSidebar(f) {
  const fmt = x => (x || 0).toFixed(4);
  document.getElementById('layout-field-visible').checked = !!f.visible;
  document.getElementById('layout-field-x').value  = fmt(f.x_pos);
  document.getElementById('layout-field-y').value  = fmt(f.y_pos);
  document.getElementById('layout-field-x2').value = fmt(f.x_end_pos);
  document.getElementById('layout-field-y2').value = fmt(f.y_end_pos);
  setFracEl('layout-field-x-frac',  f.x_pos);
  setFracEl('layout-field-y-frac',  f.y_pos);
  setFracEl('layout-field-x2-frac', f.x_end_pos);
  setFracEl('layout-field-y2-frac', f.y_end_pos);
  document.getElementById('layout-end-pos-group').hidden =
    f.field_type !== 'Line' && f.field_type !== 'Graph';
}

function onLayoutSidebarChange() {
  const f = layoutState.fields.find(x => x.id === layoutState.selectedId);
  if (!f) return;
  f.x_pos     = clampIn(parseFloat(document.getElementById('layout-field-x').value)  || 0, 0, 8.5);
  f.y_pos     = clampIn(parseFloat(document.getElementById('layout-field-y').value)  || 0, 0, 3.5);
  f.x_end_pos = clampIn(parseFloat(document.getElementById('layout-field-x2').value) || 0, 0, 8.5);
  f.y_end_pos = clampIn(parseFloat(document.getElementById('layout-field-y2').value) || 0, 0, 3.5);
  f.visible   = document.getElementById('layout-field-visible').checked ? 1 : 0;
  setFracEl('layout-field-x-frac',  f.x_pos);
  setFracEl('layout-field-y-frac',  f.y_pos);
  setFracEl('layout-field-x2-frac', f.x_end_pos);
  setFracEl('layout-field-y2-frac', f.y_end_pos);
  renderLayoutCanvas();
  debounceLayoutSave(f);
}

function startLayoutDrag(e, f) {
  layoutDrag = {
    fieldId: f.id,
    origX: f.x_pos, origY: f.y_pos,
    origX2: f.x_end_pos, origY2: f.y_end_pos,
    mouseX: e.clientX, mouseY: e.clientY,
    moveEnd: f.field_type === 'Line' || f.field_type === 'Graph',
  };
  const onMove = ev => onLayoutDragMove(ev);
  const onUp   = ev => { onLayoutDragEnd(ev); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

function onLayoutDragMove(e) {
  if (!layoutDrag) return;
  const dx = (e.clientX - layoutDrag.mouseX) / layoutState.scale;
  const dy = (e.clientY - layoutDrag.mouseY) / layoutState.scale;
  const f  = layoutState.fields.find(x => x.id === layoutDrag.fieldId);
  if (!f) return;
  f.x_pos = clampIn(round16(layoutDrag.origX  + dx), 0, 8.5);
  f.y_pos = clampIn(round16(layoutDrag.origY  + dy), 0, 3.5);
  if (layoutDrag.moveEnd) {
    f.x_end_pos = clampIn(round16(layoutDrag.origX2 + dx), 0, 8.5);
    f.y_end_pos = clampIn(round16(layoutDrag.origY2 + dy), 0, 3.5);
  }
  // Update just the dragged element for smooth performance
  const svg = document.querySelector('#layout-canvas-container svg');
  if (svg) {
    const old = svg.querySelector(`[data-field-id="${f.id}"]`);
    if (old) {
      const g = createFieldSvgElement(f, layoutState.scale, true);
      old.replaceWith(g);
      attachFieldEvents(g, f);
    }
  }
  updateLayoutSidebar(f);
}

async function onLayoutDragEnd(e) {
  if (!layoutDrag) return;
  const id = layoutDrag.fieldId;
  layoutDrag = null;
  const f = layoutState.fields.find(x => x.id === id);
  if (f) await saveLayoutField(f);
}

function nudgeLayoutField(dx, dy) {
  const f = layoutState.fields.find(x => x.id === layoutState.selectedId);
  if (!f) return;
  const S = 1 / 16;
  f.x_pos = clampIn(round16(f.x_pos + dx * S), 0, 8.5);
  f.y_pos = clampIn(round16(f.y_pos + dy * S), 0, 3.5);
  if (f.field_type === 'Line' || f.field_type === 'Graph') {
    f.x_end_pos = clampIn(round16(f.x_end_pos + dx * S), 0, 8.5);
    f.y_end_pos = clampIn(round16(f.y_end_pos + dy * S), 0, 3.5);
  }
  updateLayoutSidebar(f);
  renderLayoutCanvas();
  debounceLayoutSave(f);
}

function debounceLayoutSave(f) {
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => saveLayoutField(f), 600);
}

async function saveLayoutField(f) {
  try {
    await apiFetch('PUT', `/api/layout/${state.activeAccountId}/${f.id}`, {
      x_pos: f.x_pos, y_pos: f.y_pos,
      x_end_pos: f.x_end_pos, y_end_pos: f.y_end_pos,
      visible: f.visible,
    });
    const el = document.getElementById('layout-save-status');
    if (el) { el.textContent = 'Saved ✓'; setTimeout(() => { if (el) el.textContent = ''; }, 1500); }
  } catch (err) {
    const el = document.getElementById('layout-save-status');
    if (el) el.textContent = 'Save failed';
  }
}

async function resetLayoutToDefault() {
  if (!confirm('Reset all layout fields to default positions? This cannot be undone.')) return;
  try {
    await apiFetch('POST', `/api/layout/${state.activeAccountId}/reset`);
    await loadLayoutFields();
  } catch (err) {
    alert('Reset failed: ' + err.message);
  }
}

document.addEventListener('DOMContentLoaded', init);
