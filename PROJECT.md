# GitBot V4 — Project Guide

> Multi-tenant Discord bot that forwards GitHub events to Discord channels.
> Runs as one Node.js process: Discord gateway client + Express webhook server + optional poller.

---

## 1. What GitBot Does

```
GitHub ──(webhook POST, signed)──▶ your server ──▶ Discord channel (rich embed)
                                      │
                                      └─ Supabase (multi-tenant storage)
```

- Any Discord server can add the bot and monitor any number of GitHub repos with `/repo add`
- Each repo gets its own Discord channel + its own webhook endpoint with a **random 32-char token** and a unique **HMAC secret**
- Events (push, PR, issues, releases, CI…) arrive as formatted embeds in under a second
- Optional **polling mode** for users who cannot expose a public URL (needs a GitHub PAT)

---

## 2. The Three Core Flows

### Flow A — Webhook (main path, no token needed)

```
1. User runs:  /repo add owner/repo
2. Bot:        creates #github-owner-repo channel
               generates webhook_secret (64 hex) + webhook_token (32 hex)
               stores row in `repositories`
               replies with Payload URL: https://<base>/webhook/<webhook_token>
3. User pastes URL + secret into GitHub → Settings → Webhooks
4. GitHub sends every event:
      POST /webhook/<webhook_token>
      headers: X-GitHub-Event: push
               X-Hub-Signature-256: sha256=<HMAC of raw body>
5. src/web/webhook.js:
      a. rate limit check (30/min per IP)
      b. resolve repo by token (legacy: numeric ID or owner/repo path still work)
      c. verify HMAC signature  ── wrong → 401, never processed
      d. respond 200 immediately (GitHub timeout is 10s)
      e. check mutes → build embed (src/bot/embeds.js) → post to channel
      f. record stats + digest entry
```

Key rule: **signature is verified before the 200 response** — a forged event with a guessed ID can never reach Discord.

### Flow B — Polling (fallback, needs PAT)

Used only when a repo is created with `polling:true`. Every 60s per repo:

```
GET api.github.com/repos/<owner>/<repo>/commits   (Authorization: Bearer <PAT>)
compare newest SHA vs repositories.last_commit_sha
  ├─ never polled before → store SHA, wait for next cycle
  ├─ same SHA            → nothing new
  └─ different           → take up to 5 new commits → build push payloads
                           → handlePolledEvent() → same embed pipeline
                           → store new SHA + rate-limit counters
```

Limitations: only pushes on the default branch, 0–60s delay, max 5 commits/cycle,
needs a PAT (`/token add`), GitHub quota 5 000 req/h per token.
Poller **fallback is webhook mode** — webhook is real-time and covers all event types.

### Flow C — Discord interactions

```
Discord event → client.on("interactionCreate")
             → src/bot/handlers/interaction.js   (single choke point)
                 ├─ /help              → bot/help.js
                 ├─ slash commands     → handlers/slash.js
                 ├─ context menus      → handlers/contextMenus.js
                 └─ buttons            → handlers/buttons.js
             → any throw → errors.logError("interaction", …) + ephemeral user reply
```

---

## 3. Project Structure

```
index.js                     Entry point — wiring only (~60 lines)
src/
├── config.js                dotenv + env validation (exits if missing) + PORT + getBaseUrl()
├── errors.js                ⚠ error types + logError() — ALL errors go through here
├── stats.js                 shared counters (webhook + poller + /status + /events)
│
├── db/
│   └── database.js          Supabase layer — every SQL/query lives here, nothing else
│
├── github/
│   └── poller.js            GitHubPoller class, githubRequest(), rate-limit tracking
│
├── web/
│   ├── server.js            Express app assembly + start
│   └── webhook.js           routes, HMAC verify, event → embed pipeline, /health
│
└── bot/
    ├── client.js            shared discord.js Client
    ├── commands.js          ALL command definitions (data only) → Discord registry
    ├── register.js          pushes commands to Discord (global)
    ├── embeds.js            GitHub payload → embed, plus /status /events /digest embeds
    ├── components.js        button/row factories + chunks()
    ├── channels.js          getChannel(guildId, name) — cache first, then fetch
    ├── presence.js          rotating activity status
    ├── mutes.js             in-memory mute map (eventType → expiry)
    ├── digest.js            in-memory ring buffer of recent events
    ├── help.js              /help UI (paginated)
    ├── repoCommands.js      /repo + /admin handlers, admin permission check
    ├── tokenCommands.js     /token add|list|remove + PAT validation vs GitHub API
    └── handlers/
        ├── interaction.js   dispatcher + central error catch
        ├── slash.js         /ping /status /events /test /mute /watchlist /digest /clear-stats
        ├── buttons.js       all button callbacks (refresh, mute, dismiss, resend…)
        ├── contextMenus.js  "📌 Pin to GitHub log", "🔁 Resend this embed"
        ├── ready.js         startup: owner fetch, poller start, command register, presence
        └── guild.js         guild join/leave + welcome message
```

**Dependency rule of thumb:** `db` and `errors` are leaves (import nothing internal).
`web/*` may import `bot/embeds` + `bot/digest` + `bot/mutes`. Handlers import everything.
Never import a handler from `web/` or `db/`.

---

## 4. Data Model (Supabase)

| Table | Purpose | Key columns |
|---|---|---|
| `guilds` | one row per Discord server | `id` (Discord guild ID), `name`, `owner_id` |
| `repositories` | one row per monitored repo | `guild_id`, `owner`, `name`, `channel_id`, `webhook_secret`, **`webhook_token`** (random path), `poll_enabled`, `github_token_id`, `last_commit_sha`, `default_branch`, `is_active` |
| `admins` | per-guild bot admins | `guild_id`, `discord_user_id` |
| `github_tokens` | GitHub PATs for polling | `guild_id`, `token`, `is_default`, `rate_limit_*` |

Schema: `schema.sql`. Migrations run manually in Supabase SQL Editor
(e.g. `ALTER TABLE repositories ADD COLUMN IF NOT EXISTS webhook_token TEXT UNIQUE;`).

On every boot `db.init()` **backfills** `webhook_token` for any legacy row where it is NULL.

---

## 5. Security Model

| Threat | Defense |
|---|---|
| Forged GitHub event | HMAC-SHA256 `X-Hub-Signature-256` verified with `crypto.timingSafeEqual` **before** responding 200 (`src/web/webhook.js`) |
| Endpoint enumeration | webhook path is a random 32-hex token, not a sequential ID (legacy numeric IDs still accepted for old setups) |
| Cross-guild tampering | every query is `guild_id`-scoped (`deleteRepository`, `removeToken`, admin checks) |
| Command abuse | `/repo`, `/admin`, `/token` require admin (`isUserAdmin`: bot owner → DB admin → Discord Administrator) |
| Flooding | `express-rate-limit`: webhook 30/min/IP, health 60/min/IP (env-tunable) |
| Token leakage | PATs shown never again after `/token add`; `/token list` returns metadata only |

Rate-limit key uses `x-forwarded-for` first (set `trust proxy` for tunnel/cloudflare IPs).

---

## 6. Configuration

`.env` (see `.env.example`):

| Var | Required | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | bot token from Discord Developer Portal |
| `SUPABASE_URL` / `SUPABASE_KEY` | ✅ | Supabase project + service-role key |
| `WEBHOOK_BASE_URL` | recommended | public base URL shown in `/repo add` — e.g. `https://gitbot.nolimitzz.web.id` |
| `PORT` / `WEBHOOK_PORT` | default 3000 | HTTP port (`PORT` wins — for PaaS) |
| `WEBHOOK_RATE_LIMIT` | default 30 | webhook requests/min/IP |
| `HEALTH_RATE_LIMIT` | default 60 | `/health` requests/min/IP |

`src/config.js` validates required vars **at startup** and exits with a clear message if missing.

---

## 7. Commands (14 registered)

| Command | What it does |
|---|---|
| `/ping` | latency test |
| `/status` | uptime, WS ping, event counters, active mutes (refreshable) |
| `/events` | per-event-type bar chart of counters |
| `/test` | sends a test embed to a channel |
| `/mute <event> [reason]` | silences an event type (15m/1h/6h/24h via buttons) |
| `/watchlist` | active mutes + one-click unmute |
| `/digest [count]` | recent events ring buffer with load-more |
| `/clear-stats` | reset counters (confirm button, 30s timeout) |
| `/repo add\|remove\|list\|info\|enable` | manage repositories (admin) |
| `/admin add\|remove\|list` | manage per-guild admins |
| `/token add\|list\|remove` | manage GitHub PATs for polling (admin) — `add` validates PAT against `GET /user` first |
| `/help` | paginated help |
| 📌 Pin to GitHub log / 🔁 Resend this embed | context menus |

---

## 8. Error Handling Convention

All error types + logging live in **`src/errors.js`** — do not add ad-hoc `console.error`
for failures; use:

```js
const { logError, DatabaseError, WebhookError } = require("../errors");

try { await db.something(); }
catch (err) { logError("scope.name", err, { repo: "owner/repo" }); }
// → [error] scope=repo.add code=DB_ERROR status=500 msg="..." repo=owner/repo
```

- Throwing an `AppError` subclass (`.code`, `.status`, `.meta`) gives you structured logs for free
- Discord interactions: `handlers/interaction.js` catches **everything**, logs it, and replies ephemerally — command code may just throw
- Webhook HTTP errors: set `res.status(err.status)` where the route knows the error type

---

## 9. Running It

### Local (current setup)

```powershell
npm start                              # terminal 1 — bot + webhook server on :3000
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel run n8n   # terminal 2
```

Named tunnel config: `C:\Users\faizs\.cloudflared\config.yml`
(ingress: `gitbot.nolimitzz.web.id → localhost:3000`) — URL stays stable across restarts.

Health check: `https://gitbot.nolimitzz.web.id/health`
Root `/` returns JSON info; `/webhook/<token>` accepts **POST only** (opening it in a
browser = normal 404).

### Vercel / serverless? — No

This project **cannot run on Vercel** as one unit:

1. Discord bots need a **persistent WebSocket** process — serverless functions die after seconds
2. The poller's `setInterval(60s)` never runs on serverless
3. In-memory state (mutes, digest, stats) resets on every cold start
4. `app.listen()` long-running server doesn't match Vercel's handler model

Only the *webhook endpoint* could theoretically be split into a serverless function,
but the bot itself still needs an always-on process (VPS / PaaS with persistent dynos
such as Render, Railway, Fly.io, or a home server). Current setup = local process + Cloudflare tunnel.

---

## 10. Known Limitations / Roadmap

- [ ] In-memory state (`mutes`, `digest`, stats) lost on restart → move to Supabase
- [ ] Poller misses bursts (>5 commits/cycle) and non-push events by design
- [ ] GitHub PAT stored plaintext in DB (acceptable for personal use; consider Supabase Vault/encryption)
- [ ] No `/token` default-token display in `/repo add` reply (works, but not shown)
- [ ] `help.js` file-structure text may lag behind actual `src/` layout
- [ ] discord.js v15 will rename `ready` → `clientReady` (deprecation warning already visible)

---

## 11. How to Extend

### Add a new slash command
1. Definition → `src/bot/commands.js` (or a feature file like `repoCommands.js`)
2. Handler → `src/bot/handlers/slash.js` (`if (cmd === "mycommand") …`)
3. Restart → command auto-registers globally (`register.js`)

### Add a new GitHub event type
1. Formatter → `src/bot/embeds.js`: `formatMyEvent(payload)` + add `case` in `buildEmbed()`
2. Optional → `EVENT_CHOICES` in `src/bot/commands.js` if it should be mute-able
3. Test → `curl` a signed payload to `/webhook/<token>` (see §Flow A)

### Add a DB function
1. Only in `src/db/database.js` (never write queries elsewhere)
2. Always scope by `guild_id`; export in `module.exports`
3. For a new column: `schema.sql` + manual `ALTER TABLE` in Supabase, then add to
   `updateRepository()`'s allowlist if it's updatable

### Touch the webhook pipeline
Pipeline lives in **`src/web/webhook.js`** (`handleWebhook`):
resolve repo → verify signature → 200 → mutes → embed → post → stats/digest.
Insert new behavior between mutes and embed, and record outcomes via `recordEvent()` from `src/stats.js`.

---

*Version 4.0.0 — Discord.js v14, Supabase, Express 4. See `README.md` for user-facing docs.*
