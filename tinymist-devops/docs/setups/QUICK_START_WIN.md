# Tinymist DevOps – Windows Localhost Setup

This guide helps a developer run BookStack with the Tinymist editor locally on Windows.

## Prerequisites

- Windows 10/11
- Git
- PHP 8.2+ with extensions: curl, dom, fileinfo, gd, json, mbstring, xml, zip
- Composer
- Node.js 20.x (required by BookStack)
- MariaDB 10.6+ (or MySQL 8.x)

## Clone and install

1) Clone the repo and enter the folder.
2) Copy the environment file and set values:

- APP_URL (example: http://localhost:8000)
- DB_HOST, DB_DATABASE, DB_USERNAME, DB_PASSWORD
- TINYMIST_WS_SECRET (required for WebSocket auth; see below)

3) Install backend dependencies:

- composer install

4) Install frontend dependencies (also downloads Typst/Tinymist binaries into vendor/bin):

- npm install
	- or: npm ci

## Database setup

Create a database (example: bookstack_dev), then run:

- php artisan key:generate
- php artisan migrate

Optional seed data:

- php artisan db:seed --class=DummyContentSeeder

## Required .env additions for Tinymist

Add these to .env (if not already present):

- TINYMIST_ENABLED=true
- TINYMIST_LSP_ENABLED=true
- TINYMIST_WS_SECRET=<random 64-hex string>

Tip: generate a secret with Node:

- node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

## Run the services

Open separate terminals for each:

- Laravel app: php artisan serve
- Asset watcher: npm run dev
- File sync + LSP WebSocket: npm run ws:dev
- Preview bridge WebSocket: npm run preview:dev

Default ports:

- 8000 – Laravel (php artisan serve)
- 4000 – File sync WebSocket (tinymist-devops/node/file-sync/server.ts)
- 4020 – Preview bridge WebSocket (tinymist-devops/node/preview/preview-server.ts)

## Verify Tinymist binaries

The npm postinstall step installs these into vendor/bin:

- vendor/bin/typst.exe
- vendor/bin/tinymist.exe

If missing, re-run npm install.

## Useful tips

### Clear Laravel caches

- php artisan cache:clear
- php artisan config:clear
- php artisan route:clear
- php artisan view:clear

### Clear Tinymist working files


Note: The editor content is loaded from storage/app/tinymist/page_<id>/entry.typ if it exists and is newer than DB. Delete the file to force DB content.
- The file sync service writes to `storage/app/tinymist/page_<id>/entry.typ`.
### Find or kill stray Tinymist processes (Windows)

PowerShell:

- Get-Process tinymist -ErrorAction SilentlyContinue
- Stop-Process -Name tinymist -Force

CMD:

- tasklist | findstr tinymist
- taskkill /F /IM tinymist.exe

### Check logs

- Laravel: storage/logs/laravel.log
- Tinymist preview: storage/logs/tinymist_preview_<pageId>.log

## Common issues

- WebSocket auth errors: ensure TINYMIST_WS_SECRET is set in .env and matches the Node server environment (both load .env from project root).
- Preview not updating: confirm both npm run ws:dev and npm run preview:dev are running.
- Missing Typst/Tinymist binaries: re-run npm install to trigger the download scripts.

## Lint and test before push

```bash
# Run linting
npm run lint

# Run TypeScript checks
npm run ts:lint

# Run tests
npm test

composer lint

# or php -l, all the mess to make it recursive
find . -name '*.php' -print0 | xargs -0 -n1 php -l

php artisan test
```
