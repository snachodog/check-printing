# check-printing

Self-hosted web app for printing checks and bank deposit slips on blank check stock. Runs as a containerized Node.js app accessible on your local network or behind a reverse proxy.

## Features

- Check ledger with search, filtering, and sorting
- Precise 3-up check PDFs (three checks per 8.5" x 11" letter page, multi-page supported)
- MICR E-13B encoding for routing/account lines (GnuMICR font, GPL-2.0)
- Bank deposit slips with digit-column formatting and MICR line
- Deposit reports for filing
- Visual drag-and-drop check layout editor
- Multi-account support with per-user access control
- OIDC / SSO login (OpenID Connect)
- Password reset via email (SMTP)
- QBO CSV import for checks and deposits
- ezCheckPrinting .mdb import

## Stack

- **Runtime:** Node.js 20
- **Framework:** Express 4
- **Database:** SQLite via `better-sqlite3`
- **PDF generation:** PDFKit with embedded GnuMICR E-13B font
- **Frontend:** Vanilla JS, no framework
- **Container:** Docker Compose pulling from Docker Hub (`dogiakos/check-printing`)

## Getting started

### Production (Docker)

1. Create a `.env` file (see `.env.example`):

```bash
SESSION_SECRET=$(openssl rand -hex 32)
```

2. Start the container:

```bash
docker compose pull
docker compose up -d
```

3. Open the app in your browser. On first launch, create the initial admin account when prompted.

4. Use the setup wizard to configure your first checking account (organization info, bank info, routing/account numbers), or import an existing ezCheckPrinting `.mdb` file.

### Development (local)

```bash
npm install
cp .env.example .env   # edit .env with your values
npm run dev             # nodemon with --env-file=.env
```

## Authentication

All access requires login. The first run prompts you to create an admin account.

### Roles

| Role | Access |
| --- | --- |
| **Admin** | Full access to all accounts; manage users, accounts, and app settings |
| **Editor** | Read and write access to assigned accounts |
| **Viewer** | Read-only access to assigned accounts |

Admins have editor access to all accounts automatically. Non-admin users are assigned per-account roles individually.

### User management

Available in the **Manage Users** panel (admin only):

- Create, edit, and delete users
- Assign per-account roles
- Configure SMTP for password reset emails
- Link/unlink OIDC identities

Any user can change their own password and link/unlink their OIDC identity from the account menu (click your username in the header).

### OIDC / SSO

OIDC login is configured via environment variables (see below). When enabled, a **Sign in with SSO** button appears on the login page.

Users must link their local account to their OIDC identity before SSO login will work. Two ways to link:

1. **Self-service:** Sign in with your password, click your username, then click **Link My Account** in the Single Sign-On section
2. **Admin:** Edit a user in the Manage Users panel and set the OIDC Subject and Issuer fields

OIDC uses the authorization code flow with PKCE. The provider must have the redirect URI registered: `https://your-app.example.com/api/auth/oidc/callback`

## Multi-account support

The app supports multiple checking accounts in a single instance. Each account has its own check ledger, deposit records, and layout configuration. Use the account switcher in the header to switch between accounts. Admins can create, edit, and delete accounts.

## Checks

1. Select 1 or more checks from the ledger (checkbox column)
2. Click **Generate PDF**
3. A 3-up 8.5" x 11" PDF opens in a new tab
4. Print from the browser; checks are marked as printed

Use **Reprint** on printed checks to regenerate without re-marking.

### Check layout

- Page: 8.5" x 11", zero margins
- Three check slots of 3.5" each
- MICR line at 0.267" from bottom of each slot
- MICR format: `A{routing}A {account}C {checkNo}A` (GnuMICR E-13B encoding)

## Deposit slips

1. Switch to the **Deposits** tab
2. Click **+ New Deposit**
3. Enter deposit date, currency, coin, and cash back amounts
4. Add each check (check number, payee, memo, amount) -- totals update live
5. **Save Deposit**, then click **Deposit Slip** or **Report** to generate a PDF

**Deposit Slip** generates a 3.375" x 8.5" PDF matching physical bank deposit slip stock with digit-column formatting, MICR line, and rotated totals.

**Deposit Report** generates a plain formatted ledger document for filing.

## Visual layout editor

Click the **layout** button in the header (editors and above) to open the layout editor.

- Full-screen canvas with inch rulers
- Drag any check element to reposition it
- Position readout in inches and fractions with nudge buttons
- Visibility toggle to hide fields from PDFs
- Auto-saves on change
- **Reset to Defaults** restores the built-in layout

## Importing

### QuickBooks Online (QBO CSV)

Click **Import QBO** in the toolbar. Supports standard QBO export columns, automatic type filtering (checks vs. deposits), duplicate detection, and auto-numbering.

### ezCheckPrinting (.mdb)

**Via the UI:** Click **Import .mdb** in the toolbar, select the file, and click Import.

**Via CLI** (inside the container):

```bash
docker exec -it check-printing node migrations/import-mdb.js \
  --file "/app/data/YourAccount.mdb"

# Preview without writing:
docker exec -it check-printing node migrations/import-mdb.js \
  --file "/app/data/YourAccount.mdb" --dry-run
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `SESSION_SECRET` | *(required)* | Secret for signing session cookies. Generate with `openssl rand -hex 32` |
| `SESSION_MAX_AGE_HOURS` | `168` | Session lifetime in hours (default 7 days) |
| `PORT` | `3000` | HTTP listen port |
| `DB_PATH` | `/app/data/check-printing.db` | SQLite database file path |
| `OIDC_ENABLED` | *(empty)* | Set to `true` or `1` to enable OIDC login |
| `OIDC_DISCOVERY_URL` | *(empty)* | Provider's `.well-known/openid-configuration` URL |
| `OIDC_CLIENT_ID` | *(empty)* | OIDC client ID |
| `OIDC_CLIENT_SECRET` | *(empty)* | OIDC client secret |
| `OIDC_REDIRECT_URI` | *(empty)* | Full callback URL, e.g. `https://checks.example.com/api/auth/oidc/callback` |
| `OIDC_BUTTON_LABEL` | `Sign in with SSO` | Text shown on the SSO login button |

SMTP settings for password reset emails are configured in the admin UI (Manage Users > Email Settings).

## Docker Compose

```yaml
services:
  check-printing:
    image: dogiakos/check-printing:latest
    container_name: check-printing
    restart: unless-stopped
    ports:
      - "3003:3000"
    volumes:
      - check-printing-data:/app/data
    environment:
      - SESSION_SECRET=${SESSION_SECRET}
      # Optional: OIDC / SSO
      - OIDC_ENABLED=${OIDC_ENABLED:-}
      - OIDC_DISCOVERY_URL=${OIDC_DISCOVERY_URL:-}
      - OIDC_CLIENT_ID=${OIDC_CLIENT_ID:-}
      - OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET:-}
      - OIDC_REDIRECT_URI=${OIDC_REDIRECT_URI:-}
      - OIDC_BUTTON_LABEL=${OIDC_BUTTON_LABEL:-Sign in with SSO}

volumes:
  check-printing-data:
```
