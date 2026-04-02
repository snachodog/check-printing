# check-printing

Self-hosted web app for printing checks and bank deposit slips. A containerized Node.js web app accessible on the local network.

## Stack

- **Runtime:** Node.js 20
- **Framework:** Express 4
- **Database:** SQLite via `better-sqlite3`
- **PDF generation:** PDFKit with embedded GnuMICR E-13B font (GPL-2.0)
- **Frontend:** Vanilla JS, no framework
- **Container:** Docker Compose pulling from Docker Hub

## Getting started

### Production (Docker)

```bash
docker compose pull
docker compose up -d
```

On first launch, the app detects no users are configured and opens a **setup wizard** in the browser. Create the first admin account, then configure checkwriter info, bank info, and account/routing numbers. If you have an existing ezCheckPrinting `.mdb` file, click **Import .mdb** instead.

### Development (local)

```bash
npm install
npm run dev        # nodemon src/app.js
```

## Authentication and user roles

All access requires login. The first run prompts you to create an admin account.

Three roles are available:

| Role | Access |
| --- | --- |
| **admin** | Full access to all accounts; create/edit/delete users and accounts |
| **editor** | Read and write access to assigned accounts |
| **viewer** | Read-only access to assigned accounts |

Admins have editor access to all accounts automatically. Non-admin users are assigned per-account roles individually. User management is available in the **Users** panel (admin only). Any user can change their own password from the account menu.

## Multi-account support

The app supports multiple checking accounts in a single instance. Each account has its own check ledger, deposit records, and layout configuration. Admins can create, edit, and delete accounts. Deleting an account removes all associated checks, deposits, and layout data.

## Printing

1. Select 1–3 checks from the ledger (checkbox column)
2. Click **Generate PDF**
3. A 3-up 8.5"×11" PDF opens in a new tab — three 3.5" check slots per page
4. Print from the browser; checks are marked as printed in the ledger

Use the **Reprint** button on printed checks to regenerate without re-marking them.

Multi-page PDFs are supported when more than 3 checks are selected.

## Deposit slips

Switch to the **Deposits** tab in the toolbar to manage bank deposits.

1. Click **+ New Deposit** to open the deposit entry panel
2. Enter the deposit date, currency, coin, and cash back amounts
3. Add each check being deposited (check number, payee, memo, amount) — totals update live
4. Click **Save Deposit**, then **Deposit Slip** or **Report** to generate a PDF

**Deposit Slip** generates a precisely positioned 3.375" × 8.5" PDF matching physical bank deposit slip stock, including:

- Style A background (form lines and labels drawn server-side — no preprinted stock required)
- Digit-column amount formatting
- Routing/account line in E-13B magnetic ink character recognition font, rotated 90°
- Rotated deposit total and check count in the left margin

**Deposit Report** generates a plain formatted ledger document listing all checks, cash totals, and the final deposit amount — suitable for filing.

Generating a deposit slip marks the deposit as printed in the ledger.

## Importing from QuickBooks Online (QBO CSV)

Checks and deposits can be imported from a QuickBooks Online CSV export. Click **Import QBO CSV** in the toolbar, select the file, choose whether to import checks or deposits, and review the parsed records before confirming.

The importer handles:

- Standard QBO export column layouts (`Date`, `Transaction Type`, `Num`, `Name`, `Memo/Description`, `Amount`, `Debit`, `Credit`)
- Automatic type filtering — checks are matched by transaction type `Check`, deposits by `Deposit`
- Duplicate detection — existing check numbers are skipped
- Auto-assignment of check numbers when the source CSV has no `Num` value
- Grouping of deposit rows by date into individual deposit records

## Importing from ezCheckPrinting (.mdb)

Two ways to import:

**Via the UI (recommended):** Click **Import .mdb** in the toolbar, select the file, and click Import. The server runs the migration and shows the log output.

**Via CLI** (inside the container or locally with `mdbtools` installed):

```bash
docker exec -it check-printing node migrations/import-mdb.js \
  --file "/app/data/YourAccount.mdb"

# Preview without writing:
node migrations/import-mdb.js --file YourAccount.mdb --dry-run
```

The script imports account config (T100), logo (Settings), check layout (T200), and check history (T104).

## Visual layout editor

Each account has an independently configurable check layout. Click the **⊞** button in the header (editors and above only) to open the layout editor.

- Full-screen canvas showing a single check slot at scale, with inch rulers on all edges
- All check elements are draggable — click to select, drag to reposition
- Selected field shows position in inches and fractions (¼, ½, ⅛, etc.) with numeric inputs and ±1/16" nudge buttons
- Line fields (payee line, amount box, memo line, signature line) can be repositioned as a unit
- Visibility toggle hides a field from PDFs without deleting it
- Auto-saves 600 ms after any change; immediate save on drag release
- **Reset to Defaults** restores the built-in layout for that account

The canvas renders actual check content at proportional size — company name, bank info, sample payee and amount — so positioning is WYSIWYG.

## Check layout

- Page: 8.5" × 11", zero margins
- Three check slots of 3.5" each; remaining ~0.5" is tear-off strip
- MICR line at 0.267" from bottom of each slot
- MICR format: `A{routing}A {account}C {checkNo}A` (GnuMICR E-13B encoding)

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `/app/data/check-printing.db` | SQLite database path |
| `SESSION_SECRET` | *(random)* | Secret for signing session cookies — set explicitly in production |
