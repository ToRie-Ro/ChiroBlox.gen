# ChiroBlox

ChiroBlox is a Render-ready Telegram inventory/claim manager with a browser admin panel and PostgreSQL backend.

> Use this project only for inventory you own or are authorized to distribute. It does not automate Roblox account creation, bypass platform protections, or collect session cookies.

## Features

- Telegram bot named **ChiroBlox**
- `/start`, `/stock`, `/random`, `/help`
- Random claim with a database transaction so one item cannot be claimed twice
- Browser admin dashboard
- Add one stock item or extend the API for bulk import
- Live stock and claim events using Server-Sent Events
- PostgreSQL persistence
- AES-256-GCM encryption for stored secret/access values
- JWT-based admin authentication
- Rate limiting and Helmet security headers
- Render Blueprint for the web service + PostgreSQL
- Health endpoint at `/health`

## Important security model

The database never stores the raw secret/access value. The admin panel can submit it once, the backend encrypts it, and the claim endpoint decrypts it only when a successful claim is made.

Never commit `.env` or real secrets to GitHub.

## Local setup

1. Install Node.js 20+ and PostgreSQL.
2. Copy `.env.example` to `.env`.
3. Generate a 32-byte encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put the output in `ACCOUNT_ENCRYPTION_KEY_BASE64`.

4. Set `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `BOT_INTERNAL_TOKEN`, `JWT_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD`.
5. Install and start:

```bash
npm install
npm start
```

For local Telegram testing, expose the server over HTTPS and set `PUBLIC_URL` to that HTTPS URL. Render automatically gives a web service a public HTTPS URL.

## Render deployment

The included `render.yaml` creates a Node web service and a managed PostgreSQL database.

1. Push this project to GitHub.
2. Log in to [Render](https://render.com) and click **New > Blueprint**.
3. Connect your GitHub repository.
4. Render will read `render.yaml` and prompt you for the following environment variables:
   - `TELEGRAM_BOT_TOKEN`: Your Telegram Bot API token from [@BotFather](https://t.me/botfather).
   - `ADMIN_PASSWORD`: Password for your admin web dashboard.
   - `ADMIN_USERNAME`: Defaults to `chiroblox` (or your preferred username).

Render automatically configures:
- `DATABASE_URL`: Automatically created and linked to your free PostgreSQL instance.
- `RENDER_EXTERNAL_URL`: Automatically configures your Telegram webhook to `https://<your-service>.onrender.com/telegram/webhook`.
- `TELEGRAM_WEBHOOK_SECRET`, `ACCOUNT_ENCRYPTION_KEY_BASE64`, `JWT_SECRET`, `BOT_INTERNAL_TOKEN`: Automatically generated securely.

## API overview

### Admin

- `POST /api/admin/login`
- `GET /api/admin/stats`
- `GET /api/admin/accounts?status=all`
- `GET /api/admin/activity`
- `POST /api/admin/accounts`
- `POST /api/admin/accounts/bulk`
- `POST /api/admin/accounts/:id/disable`
- `POST /api/admin/accounts/:id/release`

Admin routes require `Authorization: Bearer <JWT>`.

### Bot internal

- `POST /api/bot/claim-random`

This route requires `X-Bot-Token` and is intended for ChiroBlox only.

### Telegram

- `POST /telegram/webhook`

Telegram's secret header is checked before updates are passed to the bot.

## Inventory payload

Add one item:

```json
{
  "username": "authorized-account-name",
  "secret": "authorized-access-value",
  "metadata": {
    "label": "Example"
  }
}
```

Bulk import:

```json
{
  "items": [
    { "username": "account-1", "secret": "value-1" },
    { "username": "account-2", "secret": "value-2" }
  ]
}
```

## Project structure

```text
ChiroBlox/
├── public/index.html          # Admin dashboard
├── src/server.js              # Express API + Telegram webhook
├── src/bot.js                 # ChiroBlox Telegram bot
├── src/db.js                  # PostgreSQL schema and queries
├── src/security.js            # Encryption, hashing, JWT helpers
├── .env.example
├── render.yaml
├── package.json
└── README.md
```
