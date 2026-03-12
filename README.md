# check-printing

Self-hosted web app for printing checks on blank check stock. A Dockerized Node.js web app accessible on the local network.

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

On first launch, the app detects no account is configured and opens a **setup wizard** in the browser. Fill in three steps — checkwriter info, bank info, and account/routing numbers — then start entering checks.

If you have an existing ezCheckPrinting `.mdb` file, click **Import .mdb** instead.

### Development (local)

```bash
npm install
npm run dev        # nodemon src/app.js
```

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

## Printing

1. Select 1–3 checks from the ledger (checkbox column)
2. Click **Generate PDF**
3. A 3-up 8.5"×11" PDF opens in a new tab — three 3.5" check slots per page
4. Print from the browser; checks are marked as printed in the ledger

Use the **Reprint** button on printed checks to regenerate without re-marking them.

## Check layout

- Page: 8.5" × 11", zero margins
- Three check slots of 3.5" each; remaining ~0.5" is tear-off strip
- MICR line at 0.267" from bottom of each slot
- MICR format: `A{routing}A {account}C {checkNo}A` (GnuMICR E-13B encoding)

## CI/CD

Push to `main` triggers a GitHub Actions workflow that builds a multi-arch Docker image (amd64/arm64) and pushes it to Docker Hub as `dogiakos/check-printing:latest`. An ntfy notification is sent on success or failure.

## Environment variables

The app has no required configuration. These are set in `docker-compose.yml`:

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `/app/data/check-printing.db` | SQLite database path |
