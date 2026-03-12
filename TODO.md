# TODO

## MVP

- [ ] Build `public/index.html` -- app shell, header with company name and current check number
- [ ] Build `public/css/style.css` -- functional, dense layout; ledger table is primary view
- [ ] Build `public/js/app.js` -- all frontend logic via `fetch()`
- [ ] Check ledger table -- columns: check #, date, payee, amount, memo, printed status
- [ ] Ledger: filter by printed / unprinted
- [ ] Ledger: sort by check number and date
- [ ] New check form -- fields: payee, amount, date, memo, note1, note2; address fields collapsed by default
- [ ] New check form -- slide-in panel or modal, not a separate page
- [ ] Edit mode for unprinted checks (inline or same panel as new check form)
- [ ] Checkbox selection of 1--3 checks for print; enforce the 3-check maximum in the UI
- [ ] "Generate PDF" button -- POST to `/api/pdf`, open resulting PDF in a new browser tab
- [ ] Reprint flow -- allow re-generating PDF for already-printed checks without re-marking (`?mark_printed=false`)
- [ ] Delete confirmation for unprinted checks
- [ ] Basic error display for API failures (failed PDF generation, validation errors)
- [ ] Amount input validation -- numeric, two decimal places, greater than zero
- [ ] Date input defaults to today
- [ ] Check number display -- show next check number on new check form (read from account)
- [ ] Run migration against `Montana Dinosaur Center.mdb` and verify all check records import correctly
- [ ] Verify PDF output: spot-check field positions against a printed check from the original software
- [ ] Verify MICR line renders using GnuMICR.otf and lands at correct Y position
- [ ] Docker Compose smoke test -- confirm app starts, DB initializes, and PDF endpoint responds

---

## Post-MVP / Future Features

These exist in the original ezCheckPrinting software but are intentionally out of scope for MVP.

### Multi-account support
- [ ] Account switcher -- the original software has ~14 accounts across TMDC, Lions, District 37, etc.
- [ ] `account_id` foreign key on `checks` and `layout_fields` tables
- [ ] Account management UI -- create, edit, delete accounts
- [ ] Per-account logo and signature image upload
- [ ] Per-account bank configuration (routing, account number, transit code, company info)

### Check layout editor
- [ ] Visual layout editor -- drag or nudge field positions (X/Y in inches)
- [ ] Per-field font, size, and visibility toggles
- [ ] Printer offset calibration UI (offset left/right/up/down) for aligning to check stock
- [ ] Preview panel that reflects layout changes before saving

### Payee management
- [ ] Payee address book -- store and recall payee name + address lines
- [ ] Autocomplete payee field from address book on new check form

### Check stub
- [ ] 1-up with stub layout (alternative to 3-up) -- stub fields are already in `layout_fields`
- [ ] Stub field rendering in PDF service (fields prefixed `Stub` in `layout_fields`)

### Reporting and ledger features
- [ ] Date range filter on ledger
- [ ] Search/filter by payee name
- [ ] Total amount display for filtered ledger view
- [ ] CSV export of check ledger

### Import / migration
- [ ] Multi-account `.mdb` import -- run migration script per account, associate with account record
- [ ] Import logo from `.mdb` `Settings` table for accounts that have one (already implemented in script, needs UI trigger)

### Deposit slips

- [ ] Deposit slip data model -- deposits table (date, total, line items: source/amount)
- [ ] Deposit slip PDF generation -- standard bank deposit slip layout
- [ ] Deposit slip ledger -- list, filter by date range
- [ ] New deposit form -- slide-in panel, add multiple line items dynamically
- [ ] Print flow for deposit slips (similar to check flow, mark as printed)

### Authentication
- [ ] Basic auth or simple password gate for any deployment that leaves the local network
