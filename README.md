# GitBot V4 — Multi-tenant Discord GitHub Bot

Discord bot self-hosted yang meneruskan event GitHub ke server Discord sebagai rich embeds. Mendukung **multi-repo**, webhook HMAC-SHA256, rate limiting, dan DM setup flow.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen) ![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## Fitur

- **Push / commits** — branch, commit list dengan links dan authors
- **Pull requests** — open, merge, close, review requested
- **Issues** — opened, closed, commented, reopened
- **Releases** — release baru dipublikasikan
- **Stars & forks** — aktivitas komunitas
- **GitHub Actions** — workflow pass/fail
- **Multi-repo** — monitor unlimited repos, masing-masing punya channel sendiri
- **Per-repo webhook secrets** — HMAC-SHA256 auto-generated per repo
- **Rate Limiting** — `express-rate-limit` protect webhook dari abuse (tanpa nginx)
- **Guided DM setup** — admin tag repo owner, mereka terima instruksi via DM
- **Event muting** — silence event type 15 menit — 24 jam
- **Live digest** — scrollable feed event terakhir

---

## Cara Menggunakan

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/discord-github-bot.git
cd discord-github-bot
npm install
```

### 2. Buat Discord Bot

1. Buka [Discord Developer Portal](https://discord.com/developers/applications)
2. Klik **New Application** → beri nama
3. Buka **Bot** → klik **Add Bot**
4. Di bagian **Token** → klik **Reset Token** dan copy token-nya
5. Aktifkan **Server Members Intent** dan **Message Content Intent**

### 3. Invite Bot ke Server

1. Buka **OAuth2 → URL Generator**
2. Centang **Scopes:** `bot`
3. Centang **Permissions:** `Send Messages`, `Embed Links`, `View Channels`, `Manage Channels`
4. Copy URL yang di-generate, buka di browser

> `Manage Channels` dibutuhkan supaya bot bisa auto-create channel per repo.

### 4. Konfigurasi Environment Variables

```bash
cp .env.example .env
```

Edit `.env`:

```
DISCORD_TOKEN=token_bot_discord_kamu
SUPABASE_URL=https://project-kamu.supabase.co
SUPABASE_KEY=service_role_key_kamu
WEBHOOK_PORT=3000
WEBHOOK_BASE_URL=https://url-publik-kamu
WEBHOOK_RATE_LIMIT=30
HEALTH_RATE_LIMIT=60
```

| Variable | Default | Deskripsi |
|---|---|---|
| `DISCORD_TOKEN` | - | Token dari Discord Developer Portal |
| `SUPABASE_URL` | - | Supabase project URL (Settings → API) |
| `SUPABASE_KEY` | - | Supabase service role key |
| `WEBHOOK_PORT` | `3000` | Port Express server |
| `WEBHOOK_BASE_URL` | auto IP lokal | URL publik bot kamu (ngrok/Railway/domain) |
| `WEBHOOK_RATE_LIMIT` | `30` | Max webhook requests per menit per IP |
| `HEALTH_RATE_LIMIT` | `60` | Max health check requests per menit per IP |

> Jalankan `schema.sql` di Supabase SQL Editor sebelum pertama kali start.

### 5. Jalankan Bot

```bash
npm start
```

Untuk development (auto-reload):

```bash
npm run dev
```

Output yang diharapkan:

```
✅ GitBot V4 logged in as YourBot#1234
🌐 Webhook server on port 3000
🔗 Webhook base URL: http://YOUR_IP:3000
```

### 6. Tambah Repository Pertama

Di Discord, jalankan:

```
/repo add repository:owner/repo user:@RepoOwner
```

- Bot buat channel `#github-owner-repo` otomatis
- **Kamu** (admin) terima reply dengan Payload URL dan Secret
- **Repo owner** terima DM dengan instruksi setup langkah demi langkah

### 7. Repo Owner Setup Webhook di GitHub

DM-nya memandu untuk:

1. Buka repo → **Settings → Webhooks → Add webhook**
2. Paste **Payload URL** (contoh: `https://your-app.up.railway.app/webhook/1`)
3. Set **Content type** ke `application/json`
4. Paste **Secret**
5. Pilih events dan klik **Add webhook**
6. Klik **"I've added the webhook"** di DM

---

## Commands

### Repository Management

| Command | Deskripsi |
|---|---|
| `/repo add repository:owner/repo [channel:#name] [user:@user]` | Tambah repo. Buat channel, generate secret, DM setup ke owner |
| `/repo remove repository:owner/repo` | Hapus repo dari monitoring |
| `/repo list [detailed:true]` | List semua repo yang di-monitor |
| `/repo info repository:owner/repo` | Detail lengkap dengan Enable/Disable dan Delete buttons |
| `/repo enable repository:owner/repo enable:true\|false` | Toggle repo aktif/nonaktif |

### Admin

| Command | Deskripsi |
|---|---|
| `/admin add user:@user` | Tambah admin |
| `/admin remove user:@user` | Hapus admin |
| `/admin list` | List semua admin |

### Status & Monitoring

| Command | Deskripsi |
|---|---|
| `/ping` | Cek latency dengan color-coded bars |
| `/status` | Uptime, WS ping, event counters, active mutes |
| `/events` | Breakdown event types sejak bot mulai |
| `/digest [count:5-25]` | Feed event terakhir |
| `/test [channel:#name]` | Kirim test embed untuk verifikasi channel |

### Muting

| Command | Deskripsi |
|---|---|
| `/mute event:push [reason:...]` | Silence event type — pilih durasi: 15 min / 1 h / 6 h / 24 h |
| `/watchlist` | Lihat active mutes dengan Unmute buttons |

### Other

| Command | Deskripsi |
|---|---|
| `/clear-stats` | Reset semua event counters (dengan konfirmasi) |
| `/help` | Baca dokumentasi lengkap |

---

## Rate Limiting

Project ini menggunakan `express-rate-limit` tanpa nginx:

| Endpoint | Default Limit | Env Variable |
|---|---|---|
| `POST /webhook/*` | 30 req/menit per IP | `WEBHOOK_RATE_LIMIT` |
| `GET /health` | 60 req/menit per IP | `HEALTH_RATE_LIMIT` |

Ketika limit tercapai, response `429 Too Many Requests` dikirim. GitHub otomatis retry.

---

## Supported Events

| GitHub Event | Yang Triggered |
|---|---|
| `push` | Commits ke branch apapun |
| `pull_request` | PR opened, merged, closed, review requested |
| `issues` | Issue opened, closed, reopened |
| `issue_comment` | Comment baru di issue |
| `pull_request_review` | Review PR submitted |
| `release` | Release dipublikasikan |
| `workflow_run` | GitHub Actions workflow selesai |
| `star` | Repo starred/unstarred |
| `fork` | Repo di-fork |
| `create` | Branch/tag dibuat |
| `delete` | Branch/tag dihapus |
| `check_run` | CI check failed/anomalous |
| `deployment_status` | Deployment status updated |
| `ping` | GitHub connectivity test |

---

## Deploy

### Railway (Recommended)

1. Push repo ke GitHub
2. Buka [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Tambah environment variables di tab **Variables**:
   - `DISCORD_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
   - `WEBHOOK_PORT` = `3000`
   - `WEBHOOK_BASE_URL` = URL Railway (contoh: `https://gitbot.up.railway.app`)
   - `WEBHOOK_RATE_LIMIT` = `30`
   - `HEALTH_RATE_LIMIT` = `60`
4. Set **Health Check** di Settings ke `/health`
5. Deploy! Bot akan otomatis jalan

> Tidak perlu volume/disk — semua data disimpan di Supabase.

### Render (Free Tier)

1. Push ke GitHub → [render.com](https://render.com) → New Web Service → connect repo
2. Tambah environment variables termasuk `WEBHOOK_BASE_URL`
3. Free tier sleep setelah inactivity (~30 detik wake time)

### VPS (DigitalOcean, Hetzner, dll)

```bash
git clone https://github.com/YOUR_USERNAME/discord-github-bot.git
cd discord-github-bot
npm install
cp .env.example .env && nano .env   # isi semua values termasuk WEBHOOK_BASE_URL

npm install -g pm2
pm2 start index.js --name gitbot
pm2 save && pm2 startup
```

### Local (Laragon/XAMPP)

```bash
npm install
cp .env.example .env   # isi DISCORD_TOKEN, SUPABASE_URL, SUPABASE_KEY
npm start
```

Untuk terima webhook dari GitHub, jalankan ngrok:

```bash
ngrok http 3000
```

Copy URL `https://xxxx.ngrok-free.app` → set sebagai `WEBHOOK_BASE_URL` di `.env`.

---

## File Structure

```
discord-github-bot/
├ index.js           — Entry point: Discord client, slash commands, button handlers
├ multiWebhook.js    — Express webhook router + rate limiting per-repo
├ repoCommands.js    — /repo dan /admin slash commands + DM setup flow
├ embeds.js          — GitHub event → Discord embed formatters
├ database.js        — Supabase PostgreSQL store (repositories, admins, tokens)
├ schema.sql         — Skema database Supabase (jalankan di SQL Editor)
├ poller.js          — GitHub API polling untuk repos tanpa webhooks
├ digest.js          — In-memory ring buffer event terakhir
├ mutes.js           — In-memory event mute store
├ help.js            — /help command dengan category dropdown
├ .env               — Secrets kamu — jangan commit!
├ .env.example       — Template
├ .gitignore
├ package.json
└ README.md
```

---

## Health Check

```
GET http://localhost:3000/health
```

Response:

```json
{
  "status": "ok",
  "version": "4.0.0",
  "mode": "multi-tenant",
  "rateLimit": {
    "webhookMax": 30,
    "healthMax": 60
  },
  "bot": "connected",
  "uptime": 3600,
  "repos": 5,
  "stats": { ... }
}
```

---

## Contributing

Pull request welcome! Untuk menambah support GitHub event baru:

1. Tambah `formatEventName(payload)` di `embeds.js`
2. Tambah `case` di `buildEmbed()` switch di `embeds.js`
3. Tambah ke `EVENT_CHOICES` di `index.js` supaya muncul di `/mute`
4. Tambah ke supported events table di README ini

---

## License

MIT — gunakan sesuka hati.
