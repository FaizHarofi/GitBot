// database.js — Supabase PostgreSQL database for multi-tenant GitBot
// Stores guilds, repositories, users, tokens, and settings

"use strict";

const { createClient } = require("@supabase/supabase-js");

let supabase;

// ─── Initialization ─────────────────────────────────────────────────────────

/**
 * Initialize Supabase client
 */
function init() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_KEY must be set in .env");
  }

  supabase = createClient(url, key);
  console.log("[db] Supabase connected");
}

/**
 * Ensure a guild exists (upsert). Called on guildCreate or first interaction.
 */
async function ensureGuild(guildId, guildName, ownerId) {
  const { error } = await supabase
    .from("guilds")
    .upsert({ id: guildId, name: guildName, owner_id: ownerId }, { onConflict: "id" });
  if (error) throw error;
}

// ─── Repository Operations ──────────────────────────────────────────────────

/**
 * Add a new repository to monitor
 */
async function addRepository(guildId, owner, name, channelId, createdBy, options = {}) {
  const fullName = `${owner}/${name}`;

  const { data, error } = await supabase
    .from("repositories")
    .insert({
      guild_id: guildId,
      owner,
      name,
      full_name: fullName,
      channel_id: channelId,
      created_by: createdBy,
      github_token_id: options.tokenId || null,
      webhook_secret: options.webhookSecret || null,
      poll_enabled: options.pollEnabled || false,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error(`Repository ${fullName} is already registered`);
    }
    throw error;
  }
  return data;
}

/**
 * Get repository by ID
 */
async function getRepositoryById(id) {
  const { data, error } = await supabase
    .from("repositories")
    .select("*")
    .eq("id", id)
    .single();

  if (error && error.code !== "PGRST116") throw error;
  return data;
}

/**
 * Get repository by full_name (owner/name) within a guild
 */
async function getRepositoryByFullName(guildId, fullName) {
  const { data, error } = await supabase
    .from("repositories")
    .select("*")
    .eq("guild_id", guildId)
    .eq("full_name", fullName)
    .single();

  if (error && error.code !== "PGRST116") throw error;
  return data;
}

/**
 * Get all active repositories for a guild
 */
async function getAllRepositories(guildId) {
  const { data, error } = await supabase
    .from("repositories")
    .select("*")
    .eq("guild_id", guildId)
    .eq("is_active", true)
    .order("full_name");

  if (error) throw error;
  return data || [];
}

/**
 * Get all guilds (used by health check and webhook routing)
 */
async function getAllGuilds() {
  const { data, error } = await supabase.from("guilds").select("*");
  if (error) throw error;
  return data || [];
}

/**
 * Get all pollable repositories across all guilds
 */
async function getAllPollableRepositories() {
  const { data, error } = await supabase
    .from("repositories")
    .select("*, guilds!inner(id, name)")
    .eq("is_active", true)
    .eq("poll_enabled", true);

  if (error) throw error;
  return data || [];
}

/**
 * Get all pollable repositories for a specific guild
 */
async function getPollableRepositories(guildId) {
  const { data, error } = await supabase
    .from("repositories")
    .select("*")
    .eq("guild_id", guildId)
    .eq("is_active", true)
    .eq("poll_enabled", true);

  if (error) throw error;
  return data || [];
}

/**
 * Update repository settings
 */
async function updateRepository(id, updates) {
  const allowed = [
    "channel_id", "webhook_secret", "github_token_id",
    "poll_enabled", "default_branch", "last_commit_sha", "last_polled_at",
    "is_active", "error_message",
  ];

  const patch = {};
  for (const [key, value] of Object.entries(updates)) {
    if (allowed.includes(key)) {
      patch[key] = value;
    }
  }

  if (Object.keys(patch).length === 0) return;

  const { error } = await supabase
    .from("repositories")
    .update(patch)
    .eq("id", id);

  if (error) throw error;
}

/**
  * Hard delete a repository (guild-scoped)
  */
  async function deleteRepository(idOrFullName, guildId) {
    const isNumeric = /^\d+$/.test(String(idOrFullName));
    const col = isNumeric ? "id" : "full_name";

    const query = supabase
      .from("repositories")
      .delete()
      .eq(col, idOrFullName);

    if (!isNumeric && guildId) {
      query.eq("guild_id", guildId);
    }

    const { error } = await query;

    if (error) throw error;
  }

// ─── Admin Operations ───────────────────────────────────────────────────────

/**
 * Add an admin (per guild)
 */
async function addAdmin(guildId, discordUserId, username, addedBy) {
  const { error } = await supabase
    .from("admins")
    .upsert({
      guild_id: guildId,
      discord_user_id: discordUserId,
      username,
      added_by: addedBy,
    }, { onConflict: "guild_id,discord_user_id" });

  if (error) throw error;
}

/**
 * Remove an admin (per guild)
 */
async function removeAdmin(guildId, discordUserId) {
  const { error } = await supabase
    .from("admins")
    .delete()
    .eq("guild_id", guildId)
    .eq("discord_user_id", discordUserId);

  if (error) throw error;
}

/**
 * Check if user is an admin in a guild
 */
async function isAdmin(guildId, discordUserId) {
  const { data, error } = await supabase
    .from("admins")
    .select("id")
    .eq("guild_id", guildId)
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

/**
 * Get all admins for a guild
 */
async function getAllAdmins(guildId) {
  const { data, error } = await supabase
    .from("admins")
    .select("*")
    .eq("guild_id", guildId)
    .order("username");

  if (error) throw error;
  return data || [];
}

// ─── GitHub Token Operations ────────────────────────────────────────────────

/**
 * Add a GitHub token (per guild)
 */
async function addToken(guildId, token, userId, description, isDefault = false) {
  if (isDefault) {
    await supabase
      .from("github_tokens")
      .update({ is_default: false })
      .eq("guild_id", guildId);
  }

  const { error } = await supabase
    .from("github_tokens")
    .insert({
      guild_id: guildId,
      token,
      user_id: userId,
      description,
      is_default: isDefault,
    });

  if (error) throw error;
}

/**
 * Get the default token for a guild
 */
async function getDefaultToken(guildId) {
  const { data, error } = await supabase
    .from("github_tokens")
    .select("*")
    .eq("guild_id", guildId)
    .eq("is_default", true)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Get token by ID
 */
async function getTokenById(id) {
  const { data, error } = await supabase
    .from("github_tokens")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Update token rate limit info
 */
async function updateTokenRateLimit(tokenId, remaining, resetTime) {
  const { error } = await supabase
    .from("github_tokens")
    .update({ rate_limit_remaining: remaining, rate_limit_reset: resetTime })
    .eq("id", tokenId);

  if (error) throw error;
}

/**
 * Get all tokens for a guild (without exposing the token value)
 */
async function getAllTokens(guildId) {
  const { data, error } = await supabase
    .from("github_tokens")
    .select("id, user_id, description, rate_limit_remaining, rate_limit_reset, created_at, is_default")
    .eq("guild_id", guildId);

  if (error) throw error;
  return data || [];
}

/**
 * Remove a token
 */
async function removeToken(id) {
  const { error } = await supabase
    .from("github_tokens")
    .delete()
    .eq("id", id);

  if (error) throw error;
}

// ─── Guild Operations ───────────────────────────────────────────────────────

/**
 * Get a guild by ID
 */
async function getGuild(guildId) {
  const { data, error } = await supabase
    .from("guilds")
    .select("*")
    .eq("id", guildId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Get guild webhook URL (for display)
 */
async function getGuildStats(guildId) {
  const [repos, pollable, admins, tokens] = await Promise.all([
    getAllRepositories(guildId),
    getPollableRepositories(guildId),
    getAllAdmins(guildId),
    getAllTokens(guildId),
  ]);

  return {
    repos: repos.length,
    pollable: pollable.length,
    admins: admins.length,
    tokens: tokens.length,
  };
}

module.exports = {
  init,
  ensureGuild,
  // Guild
  getGuild,
  getAllGuilds,
  getGuildStats,
  // Repository
  addRepository,
  getRepositoryById,
  getRepositoryByFullName,
  getAllRepositories,
  getPollableRepositories,
  getAllPollableRepositories,
  updateRepository,
  deleteRepository,
  // Admin
  addAdmin,
  removeAdmin,
  isAdmin,
  getAllAdmins,
  // Token
  addToken,
  getDefaultToken,
  getTokenById,
  updateTokenRateLimit,
  getAllTokens,
  removeToken,
};
