# check-printing

Self-hosted web app for printing checks on blank check stock. Replaces ezCheckPrinting (Halfpricesoft) — a Windows-only desktop app — with a Dockerized Node.js web app accessible on the local network.

## Stack

- **Runtime:** Node.js 20
- **Framework:** Express 4
- **Database:** SQLite via `better-sqlite3`
- **PDF generation:** PDFKit with embedded GnuMICR E-13B font (GPL-2.0)
- **Frontend:** Vanilla JS, no framework
- **Container:** Docker Compose pulling from Docker Hub

## Project structure

```
check-printing/
├── src/
│   ├── routes/
│   │   ├── checks.js       # CRUD for check records
│   │   └── pdf.js          # PDF generation endpoint
│   ├── services/
│   │   └── pdfService.js   # PDFKit rendering, MICR line, amount-to-words
│   ├── db/
│   │   ├── schema.sql      # SQLite schema
│   │   └── database.js     # DB connection + WAL mode
│   └── app.js              # Express app, all routes
├── migrations/
│   └── import-mdb.js       # One-time .mdb → SQLite migration script
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── fonts/
│   └── GnuMICR.otf
├── docker/
│   └── Dockerfile
├── docker-compose.yml
├── package.json
└── .env.example
```

## Getting started

### Production (Docker)

```bash
cp .env.example .env
# Edit .env with your NTFY_URL if desired
docker compose pull
docker compose up -d
```

On first launch, the app detects no account is configured and opens a **setup wizard** in the browser. Fill in three steps — checkwriter info, bank info, and account/routing numbers — then start entering checks.

If you have an existing ezCheckPrinting `.mdb` file, click **Import .mdb** instead.

### Development (local)

```bash
npm install
cp .env.example .env
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
3. A 3-up 8.5"×11" PDF opens in a new tab — three 3.667" check slots per page
4. Print from the browser; checks are marked as printed in the ledger

Use the **Reprint** button on printed checks to regenerate without re-marking them.

## Check layout

- Page: 8.5" × 11", zero margins
- Three slots of 3.667" each
- MICR line at Y = 3.4" from top of slot (0.267" from bottom)
- MICR format: `A{routing}A {account}C {checkNo}A` (GnuMICR E-13B encoding)

## CI/CD

Push to `main` triggers a GitHub Actions workflow that builds a multi-arch Docker image (amd64/arm64) and pushes it to Docker Hub as `dogiakos/check-printing:latest`. An ntfy notification is sent on success or failure.

## Environment variables

See `.env.example`. Key variables:

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/check-printing.db` | SQLite database path |
| `MICR_FONT_PATH` | *(see .env.example)* | Path to GnuMICR.otf inside container |
| `NTFY_URL` | — | ntfy topic URL for push notifications |
