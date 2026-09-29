// database.js — Supabase PostgreSQL database for GitBot V5
// Stores guilds, repositories, admins, event config,
// notification destinations, event logs, and notification logs.

"use strict";

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

let supabase;

// ─── Initialization ─────────────────────────────────────────────────────────

function init() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_KEY must be set in .env");
  }

  supabase = createClient(url, key);
  console.log("[db] Supabase connected");

  backfillWebhookTokens().catch(err => {
    const { logError } = require("../errors");
    logError("db", err, { step: "backfill-webhook-tokens" });
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateWebhookToken() {
  return crypto.randomBytes(16).toString("hex");
}

async function backfillWebhookTokens() {
  const { data, error } = await supabase
    .from("repositories")
    .select("id")
    .or("webhook_token.is.null,webhook_token.eq.");
  if (error) throw error;

  for (const row of data || []) {
    const { error: updErr } = await supabase
      .from("repositories")
      .update({ webhook_token: generateWebhookToken() })
      .eq("id", row.id);
    if (updErr) throw updErr;
    console.log(`[db] Generated webhook token for repository #${row.id}`);
  }
}

// ─── Guild Operations ───────────────────────────────────────────────────────

async function ensureGuild(guildId, guildName, ownerId) {
  const { error } = await supabase
    .from("guilds")
    .upsert({ id: guildId, name: guildName, owner_id: ownerId }, { onConflict: "id" });
  if (error) throw error;
}

async function getGuild(guildId) {
  const { data, error } = await supabase
    .from("guilds")
    .select("*")
    .eq("id", guildId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getAllGuilds() {
  const { data, error } = await supabase.from("guilds").select("*");
  if (error) throw error;
  return data || [];
}

async function getGuildStats(guildId) {
  const [repos, admins] = await Promise.all([
    getAllRepositories(guildId),
    getAllAdmins(guildId),
  ]);
  return {
    repos: repos.length,
    admins: admins.length,
  };
}

// ─── Repository Operations ──────────────────────────────────────────────────

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
      webhook_secret: options.webhookSecret || null,
      webhook_token: options.webhookToken || generateWebhookToken(),
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

async function getRepositoryById(id) {
  const { data, error } = await supabase
    .from("repositories")
    .select("*")
    .eq("id", id)
    .single();
  if (error && error.code !== "PGRST116") throw error;
  return data;
}

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

async function getRepositoryByWebhookToken(token) {
  if (!token || typeof token !== "string") return null;
  const { data, error } = await supabase
    .from("repositories")
    .select("*")
    .eq("webhook_token", token)
    .maybeSingle();
  if (error) throw error;
  return data;
}

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

async function getAllRepositoriesAcrossGuilds() {
  const { data, error } = await supabase
    .from("repositories")
    .select("*")
    .eq("is_active", true)
    .order("full_name");
  if (error) throw error;
  return data || [];
}

async function updateRepository(id, updates) {
  const allowed = [
    "channel_id", "webhook_secret", "is_active", "error_message",
  ];
  const patch = {};
  for (const [key, value] of Object.entries(updates)) {
    if (allowed.includes(key)) patch[key] = value;
  }
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase.from("repositories").update(patch).eq("id", id);
  if (error) throw error;
}

async function deleteRepository(idOrFullName, guildId) {
  const isNumeric = /^\d+$/.test(String(idOrFullName));
  const col = isNumeric ? "id" : "full_name";

  const query = supabase.from("repositories").delete().eq(col, idOrFullName);
  if (!isNumeric && guildId) query.eq("guild_id", guildId);

  const { error } = await query;
  if (error) throw error;
}

// ─── Admin Operations ───────────────────────────────────────────────────────

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

async function removeAdmin(guildId, discordUserId) {
  const { error } = await supabase
    .from("admins")
    .delete()
    .eq("guild_id", guildId)
    .eq("discord_user_id", discordUserId);
  if (error) throw error;
}

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

async function getAllAdmins(guildId) {
  const { data, error } = await supabase
    .from("admins")
    .select("*")
    .eq("guild_id", guildId)
    .order("username");
  if (error) throw error;
  return data || [];
}

// ─── Per-Repository Event Configuration ────────────────────────────────────

const SUPPORTED_EVENTS = [
  "push", "pull_request", "issues", "issue_comment",
  "pull_request_review", "release", "workflow_run",
  "star", "fork", "create", "delete", "check_run", "deployment_status",
];

/**
 * Get event configuration for a repository.
 * Returns a Map of { eventType → enabled (boolean) }.
 * If a row doesn't exist for an event, it defaults to enabled=true.
 */
async function getRepositoryEventConfig(repositoryId) {
  const { data, error } = await supabase
    .from("repository_events")
    .select("*")
    .eq("repository_id", repositoryId);
  if (error) throw error;

  const config = {};
  // Default all events to enabled
  for (const evt of SUPPORTED_EVENTS) {
    config[evt] = true;
  }
  // Override with stored values
  for (const row of (data || [])) {
    config[row.event_type] = row.enabled;
  }
  return config;
}

/**
 * Check if a specific event is enabled for a repository.
 * Defaults to true if no row exists.
 */
async function isEventEnabled(repositoryId, eventType) {
  const { data, error } = await supabase
    .from("repository_events")
    .select("enabled")
    .eq("repository_id", repositoryId)
    .eq("event_type", eventType)
    .maybeSingle();
  if (error) throw error;
  if (!data) return true; // default: enabled
  return data.enabled;
}

/**
 * Set event enabled/disabled for a repository.
 * Uses upsert — creates the row if it doesn't exist.
 */
async function setEventEnabled(repositoryId, eventType, enabled) {
  const { error } = await supabase
    .from("repository_events")
    .upsert(
      { repository_id: repositoryId, event_type: eventType, enabled },
      { onConflict: "repository_id,event_type" }
    );
  if (error) throw error;
}

/**
 * Bulk update all event types for a repository from a config object.
 * config = { push: true, pull_request: false, ... }
 */
async function setRepositoryEventConfig(repositoryId, config) {
  const rows = Object.entries(config).map(([event_type, enabled]) => ({
    repository_id: repositoryId,
    event_type,
    enabled: !!enabled,
  }));

  const { error } = await supabase
    .from("repository_events")
    .upsert(rows, { onConflict: "repository_id,event_type" });
  if (error) throw error;
}

// ─── Notification Destinations ──────────────────────────────────────────────

/**
 * Add a notification destination (WhatsApp group or Discord channel override).
 * type: 'whatsapp' | 'discord'
 * identifier: WhatsApp group JID or Discord channel ID
 */
async function addDestination(guildId, type, name, identifier) {
  const { data, error } = await supabase
    .from("notification_destinations")
    .insert({ guild_id: guildId, type, name, identifier })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getDestination(id) {
  const { data, error } = await supabase
    .from("notification_destinations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getAllDestinations(guildId) {
  const { data, error } = await supabase
    .from("notification_destinations")
    .select("*")
    .eq("guild_id", guildId)
    .eq("active", true)
    .order("name");
  if (error) throw error;
  return data || [];
}

async function updateDestination(id, updates) {
  const allowed = ["name", "identifier", "active"];
  const patch = {};
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.includes(k)) patch[k] = v;
  }
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase
    .from("notification_destinations")
    .update(patch)
    .eq("id", id);
  if (error) throw error;
}

async function deleteDestination(id) {
  const { error } = await supabase
    .from("notification_destinations")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

// ─── Repository-Event-Destination Mappings ──────────────────────────────────

/**
 * Add a mapping: repository + event_type → destination.
 * Pass event_type = null to apply to ALL events.
 */
async function addDestinationMapping(repositoryId, eventType, destinationId) {
  const { data, error } = await supabase
    .from("repository_event_destinations")
    .insert({
      repository_id: repositoryId,
      event_type: eventType || null,
      destination_id: destinationId,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function removeDestinationMapping(id) {
  const { error } = await supabase
    .from("repository_event_destinations")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

/**
 * Get all destination mappings for a repository + event combo.
 * Falls back to repo-level mappings (event_type IS NULL) if no event-specific ones exist.
 */
async function getDestinationsForEvent(repositoryId, eventType) {
  // Try event-specific first
  const { data: specific, error: e1 } = await supabase
    .from("repository_event_destinations")
    .select("*, notification_destinations(*)")
    .eq("repository_id", repositoryId)
    .eq("event_type", eventType);
  if (e1) throw e1;

  if (specific && specific.length > 0) {
    return specific
      .filter(m => m.notification_destinations?.active)
      .map(m => m.notification_destinations);
  }

  // Fall back to repo-level (event_type IS NULL)
  const { data: general, error: e2 } = await supabase
    .from("repository_event_destinations")
    .select("*, notification_destinations(*)")
    .eq("repository_id", repositoryId)
    .is("event_type", null);
  if (e2) throw e2;

  return (general || [])
    .filter(m => m.notification_destinations?.active)
    .map(m => m.notification_destinations);
}

async function getAllMappingsForRepository(repositoryId) {
  const { data, error } = await supabase
    .from("repository_event_destinations")
    .select("*, notification_destinations(*)")
    .eq("repository_id", repositoryId);
  if (error) throw error;
  return data || [];
}

// ─── Event Logging ──────────────────────────────────────────────────────────

/**
 * Log a received GitHub event.
 * status: 'processed' | 'ignored' | 'failed'
 */
async function logEvent(repositoryId, eventType, action, status, reason, metadata) {
  const { data, error } = await supabase
    .from("event_logs")
    .insert({
      repository_id: repositoryId,
      event_type: eventType,
      action: action || null,
      status,
      reason: reason || null,
      metadata: metadata || null,
    })
    .select("id")
    .single();
  if (error) {
    // Non-fatal — log to console but don't crash webhook handling
    console.error("[db] Failed to write event log:", error.message);
    return null;
  }
  return data.id;
}

/**
 * Get recent event logs, optionally filtered by repository.
 */
async function getEventLogs(options = {}) {
  let query = supabase
    .from("event_logs")
    .select("*, repositories(full_name, guild_id)")
    .order("created_at", { ascending: false })
    .limit(options.limit || 50);

  if (options.repositoryId) query = query.eq("repository_id", options.repositoryId);
  if (options.guildId) {
    query = query.eq("repositories.guild_id", options.guildId);
  }
  if (options.status) query = query.eq("status", options.status);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ─── Notification Logging ────────────────────────────────────────────────────

/**
 * Log a notification delivery attempt.
 * status: 'sent' | 'failed' | 'skipped'
 */
async function logNotification(eventLogId, destinationId, destinationType, status, errorMessage) {
  const { error } = await supabase
    .from("notification_logs")
    .insert({
      event_log_id: eventLogId || null,
      destination_id: destinationId || null,
      destination_type: destinationType,
      status,
      error_message: errorMessage || null,
    });
  if (error) {
    // Non-fatal
    console.error("[db] Failed to write notification log:", error.message);
  }
}

async function getNotificationLogs(options = {}) {
  let query = supabase
    .from("notification_logs")
    .select("*, notification_destinations(name, type)")
    .order("sent_at", { ascending: false })
    .limit(options.limit || 50);

  if (options.eventLogId) query = query.eq("event_log_id", options.eventLogId);
  if (options.destinationId) query = query.eq("destination_id", options.destinationId);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// ─── Dashboard Stats ────────────────────────────────────────────────────────

async function getDashboardStats(guildId) {
  const [repos, admins, destinations] = await Promise.all([
    getAllRepositories(guildId),
    getAllAdmins(guildId),
    getAllDestinations(guildId),
  ]);

  // Event log counts
  const { data: logCounts, error: logErr } = await supabase
    .from("event_logs")
    .select("status, repositories!inner(guild_id)")
    .eq("repositories.guild_id", guildId);

  let processed = 0, ignored = 0, failed = 0;
  if (!logErr && logCounts) {
    for (const row of logCounts) {
      if (row.status === "processed") processed++;
      else if (row.status === "ignored") ignored++;
      else if (row.status === "failed") failed++;
    }
  }

  // Notification counts
  const { count: notifCount } = await supabase
    .from("notification_logs")
    .select("id", { count: "exact", head: true })
    .eq("status", "sent");

  return {
    repos: repos.length,
    admins: admins.length,
    destinations: destinations.length,
    events: { processed, ignored, failed, total: processed + ignored + failed },
    notificationsSent: notifCount || 0,
  };
}

module.exports = {
  init,
  generateWebhookToken,
  SUPPORTED_EVENTS,
  // Guild
  ensureGuild,
  getGuild,
  getAllGuilds,
  getGuildStats,
  getDashboardStats,
  // Repository
  addRepository,
  getRepositoryById,
  getRepositoryByFullName,
  getRepositoryByWebhookToken,
  getAllRepositories,
  getAllRepositoriesAcrossGuilds,
  updateRepository,
  deleteRepository,
  // Admin
  addAdmin,
  removeAdmin,
  isAdmin,
  getAllAdmins,
  // Event config
  getRepositoryEventConfig,
  isEventEnabled,
  setEventEnabled,
  setRepositoryEventConfig,
  // Destinations
  addDestination,
  getDestination,
  getAllDestinations,
  updateDestination,
  deleteDestination,
  // Mappings
  addDestinationMapping,
  removeDestinationMapping,
  getDestinationsForEvent,
  getAllMappingsForRepository,
  // Logging
  logEvent,
  getEventLogs,
  logNotification,
  getNotificationLogs,
};
