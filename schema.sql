-- GitBot V4 — Supabase Schema
-- Run this in your Supabase SQL Editor to set up the database

-- ═══ Guilds (workspace per Discord server) ═══
CREATE TABLE IF NOT EXISTS guilds (
  id TEXT PRIMARY KEY,                    -- Discord guild ID
  name TEXT,                              -- Server name
  owner_id TEXT,                          -- Discord user ID who invited the bot
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ Repositories ═══
CREATE TABLE IF NOT EXISTS repositories (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  channel_id TEXT,                        -- Discord channel ID for notifications
  webhook_secret TEXT,
  webhook_id TEXT,
  github_token_id BIGINT,
  poll_enabled BOOLEAN DEFAULT FALSE,
  default_branch TEXT DEFAULT 'main',
  last_commit_sha TEXT,
  last_polled_at BIGINT,
  is_active BOOLEAN DEFAULT TRUE,
  error_message TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(guild_id, owner, name)
);

-- ═══ GitHub Tokens ═══
CREATE TABLE IF NOT EXISTS github_tokens (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  user_id TEXT,
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE,
  rate_limit_remaining INT DEFAULT 5000,
  rate_limit_reset BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ Admins ═══
CREATE TABLE IF NOT EXISTS admins (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL,
  username TEXT,
  added_by TEXT,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(guild_id, discord_user_id)
);

-- ═══ Indexes ═══
CREATE INDEX IF NOT EXISTS idx_repos_guild ON repositories(guild_id);
CREATE INDEX IF NOT EXISTS idx_repos_full_name ON repositories(full_name);
CREATE INDEX IF NOT EXISTS idx_repos_active ON repositories(is_active);
CREATE INDEX IF NOT EXISTS idx_tokens_guild ON github_tokens(guild_id);
CREATE INDEX IF NOT EXISTS idx_tokens_default ON github_tokens(is_default);
CREATE INDEX IF NOT EXISTS idx_admins_guild ON admins(guild_id);

-- ═══ Row-Level Security (RLS) — Optional but recommended ═══
-- Uncomment these to enable RLS for extra security
--
-- ALTER TABLE guilds ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE github_tokens ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
