# ws-reporter

[English](README.md) | [فارسی](README.fa.md)

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot%20API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zero Runtime Dependencies](https://img.shields.io/badge/Dependencies-0%20runtime-brightgreen)](#how-it-works)

A serverless Windscribe bandwidth and quota monitor built on Cloudflare Workers, Workers KV, and Telegram. It checks multiple Windscribe accounts one by one on a 15-minute cron schedule, handles 2FA (TOTP) and rate limits automatically, and posts a consolidated report to your Telegram channel when a full rotation finishes.

## Why this exists

Checking dozens of Windscribe accounts in one burst usually triggers HTTP 429 rate limits and login blocks. `ws-reporter` avoids this by pacing checks across cron runs: each 15-minute trigger inspects a single account, saves the result in Cloudflare KV, and moves a pointer forward. Once every active account has been checked, it sends a chunked report to your Telegram channel and resets the cycle.

## Sample report output

```text
📊 گزارش کامل اکانت‌ها
✅ 2 سالم | ❌ 0 خطا | 👥 2 اکانت

✅ 1) example_user_1
█░░░░░░░░░ 7.6٪
▫️ کل: 10GB | مصرف شده: 782MB
▫️ حجم باقی‌مانده: 9.24GB
▫️ 14 روز تا ریست اکانت باقی مانده

⛔️ 2) example_user_2
██████████ 100.0٪
▫️ کل: 10GB | مصرف شده: 10.00GB
▫️ حجم باقی‌مانده: 0B
▫️ 10 روز تا ریست اکانت باقی مانده
```

## How it works

- **One account per cron tick:** Runs on `*/15 * * * *` and inspects the next unchecked account in the queue, keeping API traffic low and predictable.
- **Self-healing rotation:** Tracks results per cycle in `WS_KV`. If a run is interrupted or an account hits a rate limit, the next run picks up from the first unchecked account.
- **Rate-limit and cooldown handling:** Enforces request and login gaps, retries transient 5xx/429 errors with backoff, enters a 30-minute KV cooldown when rate-limited repeatedly, and alerts the channel after consecutive 429 streaks.
- **Built-in TOTP (2FA):** Generates 6-digit RFC 6238 TOTP codes via WebCrypto HMAC-SHA1 for accounts with 2FA enabled.
- **Encrypted password storage:** Optionally encrypts account passwords in KV using AES-256-GCM derived from `ENC_KEY`.
- **Telegram chunking:** Splits long reports automatically under Telegram's 4096-character message limit (3500-char safe threshold per message).
- **Zero runtime dependencies:** `src/worker.js` uses only standard Web APIs (`fetch`, `crypto.subtle`) and Cloudflare KV bindings.

## Telegram bot commands

All commands are restricted to user IDs listed in `ADMIN_IDS`.

| Command | Description |
| --- | --- |
| `/start`, `/help` | Show available bot commands |
| `/add <user> <pass> [totp]` | Add or update an account (deletes the source message in chat) |
| `/del <user>` | Remove an account and its cached cycle entry |
| `/list` | List all configured accounts and 2FA indicators |
| `/check <user>` | Immediately check a single account and return its status |
| `/next` | Manually run one queue step |
| `/resync` | Re-align the queue pointer with unchecked accounts in the current cycle |
| `/report` | Print the partial or complete report for the current cycle |
| `/status` | Show total accounts, cycle progress, next account, last run status, and cooldown state |

## HTTP endpoints

| Method & Path | Purpose | Auth |
| --- | --- | --- |
| `POST /tg/webhook` | Receives Telegram bot updates | `x-telegram-bot-api-secret-token` header matching `WEBHOOK_SECRET` |
| `GET /setup?key=...` | Registers the Telegram webhook URL automatically | `key` query param matching `WEBHOOK_SECRET` |
| `GET /run?key=...` | Triggers one cycle step manually | `key` query param matching `WEBHOOK_SECRET` |
| `GET /` | Health check response | Public |

## Prerequisites

- A [Cloudflare](https://dash.cloudflare.com/) account with Workers and KV enabled
- A Telegram bot token from [@BotFather](https://t.me/BotFather) and a target channel/chat ID
- Node.js 22.18+ (24+ recommended) and `npm`

## Setup and deployment

1. Clone the repository and install development dependencies:

   ```bash
   git clone https://github.com/mortezakalami/ws-reporter.git
   cd ws-reporter
   npm install
   ```

2. Create a Workers KV namespace on Cloudflare and note its namespace ID.

3. Copy `.env.example` to `.env` for local configuration (`.env` is gitignored):

   ```bash
   cp .env.example .env
   ```

4. Fill in `.env`:

   | Variable | Required | Description |
   | --- | --- | --- |
   | `WS_KV_ID` | Yes (deploy) | Cloudflare KV namespace ID for `WS_KV` |
   | `ADMIN_IDS` | Yes | Comma-separated Telegram numeric user IDs allowed to control the bot |
   | `TELEGRAM_CHANNEL_ID` | Yes | Target Telegram channel or chat ID (for example `-100...`) |
   | `SHOW_PASSWORDS` | No | Set `"true"` to include passwords in full reports (defaults to `"false"`) |
   | `TELEGRAM_BOT_TOKEN` | Yes (secret) | Bot token from `@BotFather` |
   | `ENC_KEY` | Recommended | Passphrase used to encrypt passwords in KV with AES-GCM |
   | `WEBHOOK_SECRET` | Yes (secret) | Secret token protecting `/tg/webhook`, `/setup`, and `/run` |

5. Test locally or build:

   ```bash
   npm run dev
   npm run build
   ```

6. Authenticate with Cloudflare (`cf auth login`) and deploy:

   ```bash
   npm run deploy
   ```

   Upload your secrets to Cloudflare Workers (either via the Cloudflare Dashboard or CLI):

   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN --name ws-reporter
   npx wrangler secret put ENC_KEY --name ws-reporter
   npx wrangler secret put WEBHOOK_SECRET --name ws-reporter
   ```

7. Register your Telegram webhook by opening:

   ```text
   https://<your-worker>.<your-subdomain>.workers.dev/setup?key=<YOUR_WEBHOOK_SECRET>
   ```

## Security model

- Passwords stored in `WS_KV` are encrypted with AES-256-GCM whenever `ENC_KEY` is configured.
- `/add` attempts to delete the incoming Telegram message containing your plaintext password immediately after saving.
- Bot commands verify `msg.from.id` against `ADMIN_IDS` and ignore non-admin callers.
- Secret values (`TELEGRAM_BOT_TOKEN`, `ENC_KEY`, `WEBHOOK_SECRET`) are declared as Worker secrets in `cloudflare.config.ts` and are never committed to Git.

## Project structure

```text
ws-reporter/
├── src/
│   └── worker.js           # Worker entrypoint (fetch + scheduled handlers)
├── cloudflare.config.ts    # Cloudflare Workers config (KV, cron, vars, secrets)
├── vite.config.ts          # Vite + @cloudflare/vite-plugin integration
├── .env.example            # Environment variable template
├── README.md               # English documentation
├── README.fa.md            # Persian documentation
└── LICENSE                 # MIT license
```

## License

Released under the [MIT License](LICENSE).
