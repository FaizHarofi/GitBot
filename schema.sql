-- GitBot V5 — Supabase Schema
-- Run this in your Supabase SQL Editor to set up the database.
-- Safe to re-run (uses IF NOT EXISTS / upsert patterns).

-- ═══ Guilds (workspace per Discord server) ═══════════════════════════════════
CREATE TABLE IF NOT EXISTS guilds (
  id         TEXT PRIMARY KEY,           -- Discord guild ID
  name       TEXT,
  owner_id   TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ Repositories ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS repositories (
  id             BIGSERIAL PRIMARY KEY,
  guild_id       TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  owner          TEXT NOT NULL,
  name           TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  channel_id     TEXT,                   -- default Discord channel ID
  webhook_secret TEXT,
  webhook_token  TEXT UNIQUE,            -- random path token: /webhook/<token>
  webhook_id     TEXT,
  is_active      BOOLEAN DEFAULT TRUE,
  error_message  TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(guild_id, owner, name)
);

-- ═══ Admins ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS admins (
  id                BIGSERIAL PRIMARY KEY,
  guild_id          TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  discord_user_id   TEXT NOT NULL,
  username          TEXT,
  added_by          TEXT,
  added_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(guild_id, discord_user_id)
);

-- ═══ Per-Repository Event Configuration ══════════════════════════════════════
-- If a row doesn't exist for an event, the default is enabled=TRUE.
CREATE TABLE IF NOT EXISTS repository_events (
  id            BIGSERIAL PRIMARY KEY,
  repository_id BIGINT REFERENCES repositories(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,           -- 'push', 'pull_request', etc.
  enabled       BOOLEAN DEFAULT TRUE,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(repository_id, event_type)
);

-- ═══ Notification Destinations ═══════════════════════════════════════════════
-- Additional destinations beyond each repository's default Discord channel.
-- type: 'discord' | 'whatsapp'
CREATE TABLE IF NOT EXISTS notification_destinations (
  id         BIGSERIAL PRIMARY KEY,
  guild_id   TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('discord', 'whatsapp')),
  name       TEXT NOT NULL,             -- friendly display name
  identifier TEXT NOT NULL,             -- Discord channel ID or WhatsApp JID
  active     BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ Repository-Event-Destination Mappings ════════════════════════════════════
-- Maps repository + optional event_type to a destination.
-- event_type IS NULL means "all events for this repository".
CREATE TABLE IF NOT EXISTS repository_event_destinations (
  id             BIGSERIAL PRIMARY KEY,
  repository_id  BIGINT REFERENCES repositories(id) ON DELETE CASCADE,
  event_type     TEXT,                   -- NULL = all events
  destination_id BIGINT REFERENCES notification_destinations(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ Event Logs ══════════════════════════════════════════════════════════════
-- One row per received GitHub webhook event.
-- status: 'processed' | 'ignored' | 'failed'
CREATE TABLE IF NOT EXISTS event_logs (
  id            BIGSERIAL PRIMARY KEY,
  repository_id BIGINT REFERENCES repositories(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,
  action        TEXT,
  status        TEXT NOT NULL CHECK (status IN ('processed', 'ignored', 'failed')),
  reason        TEXT,                   -- why ignored/failed
  metadata      JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ Notification Logs ════════════════════════════════════════════════════════
-- One row per delivery attempt (one event can have multiple notifications).
-- status: 'sent' | 'failed' | 'skipped'
CREATE TABLE IF NOT EXISTS notification_logs (
  id               BIGSERIAL PRIMARY KEY,
  event_log_id     BIGINT REFERENCES event_logs(id) ON DELETE SET NULL,
  destination_id   BIGINT REFERENCES notification_destinations(id) ON DELETE SET NULL,
  destination_type TEXT NOT NULL,        -- 'discord' | 'whatsapp'
  status           TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error_message    TEXT,
  sent_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ Indexes ═════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_repos_guild       ON repositories(guild_id);
CREATE INDEX IF NOT EXISTS idx_repos_full_name   ON repositories(full_name);
CREATE INDEX IF NOT EXISTS idx_repos_active      ON repositories(is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_webhook_token ON repositories(webhook_token);
CREATE INDEX IF NOT EXISTS idx_admins_guild      ON admins(guild_id);
CREATE INDEX IF NOT EXISTS idx_repo_events_repo  ON repository_events(repository_id);
CREATE INDEX IF NOT EXISTS idx_destinations_guild ON notification_destinations(guild_id);
CREATE INDEX IF NOT EXISTS idx_dest_mappings_repo ON repository_event_destinations(repository_id);
CREATE INDEX IF NOT EXISTS idx_event_logs_repo   ON event_logs(repository_id);
CREATE INDEX IF NOT EXISTS idx_event_logs_status ON event_logs(status);
CREATE INDEX IF NOT EXISTS idx_event_logs_time   ON event_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_logs_event  ON notification_logs(event_log_id);
CREATE INDEX IF NOT EXISTS idx_notif_logs_time   ON notification_logs(sent_at DESC);

-- ═══ Migration: remove obsolete polling columns from existing databases ═══════
-- Run these once on databases created before V5:
--
-- ALTER TABLE repositories DROP COLUMN IF EXISTS github_token_id;
-- ALTER TABLE repositories DROP COLUMN IF EXISTS poll_enabled;
-- ALTER TABLE repositories DROP COLUMN IF EXISTS default_branch;
-- ALTER TABLE repositories DROP COLUMN IF EXISTS last_commit_sha;
-- ALTER TABLE repositories DROP COLUMN IF EXISTS last_polled_at;
-- DROP TABLE IF EXISTS github_tokens;

-- ═══ Row-Level Security (RLS) — Optional but recommended ═════════════════════
-- ALTER TABLE guilds                      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE repositories                ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE admins                      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE repository_events           ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE notification_destinations   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE repository_event_destinations ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE event_logs                  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE notification_logs           ENABLE ROW LEVEL SECURITY;
