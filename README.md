# ezcheck

Self-hosted web app for printing checks on blank check stock. Replaces ezCheckPrinting (Halfpricesoft).

## Stack

- **Runtime:** Node.js 20
- **Framework:** Express
- **Database:** SQLite via `better-sqlite3`
- **PDF generation:** PDFKit with embedded MICR E-13B font
- **Frontend:** Vanilla JS, no framework
- **Container:** Docker Compose

## Project Structure

```
ezcheck/
├── src/
│   ├── routes/
│   │   ├── checks.js       # CRUD for check records
│   │   ├── accounts.js     # Account config (Phase 2)
│   │   └── pdf.js          # PDF generation endpoint
│   ├── services/
│   │   └── pdfService.js   # PDFKit rendering logic
│   ├── db/
│   │   ├── schema.sql      # SQLite schema
│   │   └── database.js     # DB connection + helpers
│   └── app.js              # Express app
├── migrations/
│   └── import-mdb.js       # One-time .mdb import script
├── public/
│   ├── css/style.css
│   ├── js/app.js
│   └── index.html
├── fonts/                  # MICR E-13B TTF goes here
├── docker/
│   └── Dockerfile
├── docker-compose.yml
├── package.json
└── .env.example
```

## Getting Started

### Development (local)

```bash
npm install
cp .env.example .env
node migrations/import-mdb.js --file /path/to/YourAccount.mdb
npm run dev
```

### Production (Docker)

```bash
docker compose up -d
```

## Migration

The import script reads a single `.mdb` file and populates the SQLite database.
It requires `mdbtools` to be installed on the host or available in the container.

```bash
node migrations/import-mdb.js --file "Montana Dinosaur Center.mdb"
```

## Printing

- Select 1–3 checks from the ledger
- Click "Print PDF"
- App generates a 3-up 8.5"×11" PDF (three 3.667" check slots)
- PDF opens in browser, user sends to printer
- Checks are marked as printed in the ledger

## Check Layout Coordinate Space

Coordinates are in inches. Origin is top-left of each check slot.
Check slot dimensions: 8.5" wide × 3.667" tall (three per letter page).
MICR line is hardcoded at Y = 3.4" (0.267" from bottom of slot).

## MICR Font

Place `micrenc.ttf` or `GnuMICR.ttf` in the `fonts/` directory.
Update `MICR_FONT_PATH` in `.env` if using a different filename.
