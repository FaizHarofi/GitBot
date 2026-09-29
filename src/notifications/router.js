// router.js — central notification routing layer
// Receives a normalized notification + destination list, dispatches to
// the correct provider adapter, and logs each delivery outcome.

"use strict";

const db = require("../db/database");
const { logError } = require("../errors");
const discordAdapter = require("./adapters/discord");
const whatsappAdapter = require("./adapters/whatsapp");

/**
 * Route a normalized notification to all configured destinations for this
 * repository + event type combo. Returns an array of delivery results.
 *
 * @param {object} notification  — from normalizer.normalize()
 * @param {object} repo          — repository row from DB
 * @param {object} discordClient — discord.js Client instance
 * @param {number|null} eventLogId — ID of the event_logs row (for notification_logs FK)
 * @returns {Promise<Array<{destination, status, error}>>}
 */
async function route(notification, repo, discordClient, eventLogId) {
  const results = [];

  // ── 1. Discord channel (from repo.channel_id) ──────────────────────────────
  if (repo.channel_id && discordClient?.isReady()) {
    try {
      await discordAdapter.send(notification, repo.channel_id, discordClient);
      results.push({ destination: `discord:${repo.channel_id}`, status: "sent" });
      await db.logNotification(eventLogId, null, "discord", "sent", null);
    } catch (err) {
      logError("router.discord", err, { repo: repo.full_name, channel: repo.channel_id });
      results.push({ destination: `discord:${repo.channel_id}`, status: "failed", error: err.message });
      await db.logNotification(eventLogId, null, "discord", "failed", err.message);
    }
  }

  // ── 2. Additional destinations from repository_event_destinations ──────────
  let extraDestinations = [];
  try {
    extraDestinations = await db.getDestinationsForEvent(repo.id, notification.eventType);
  } catch (err) {
    logError("router.destinations", err, { repo: repo.full_name });
  }

  for (const dest of extraDestinations) {
    try {
      if (dest.type === "discord") {
        await discordAdapter.send(notification, dest.identifier, discordClient);
        results.push({ destination: `discord:${dest.identifier}`, status: "sent" });
        await db.logNotification(eventLogId, dest.id, "discord", "sent", null);
      } else if (dest.type === "whatsapp") {
        await whatsappAdapter.send(notification, dest.identifier);
        results.push({ destination: `whatsapp:${dest.identifier}`, status: "sent" });
        await db.logNotification(eventLogId, dest.id, "whatsapp", "sent", null);
      } else {
        console.warn(`[router] Unknown destination type: ${dest.type}`);
      }
    } catch (err) {
      logError("router.destination", err, { repo: repo.full_name, dest: dest.identifier });
      results.push({ destination: `${dest.type}:${dest.identifier}`, status: "failed", error: err.message });
      await db.logNotification(eventLogId, dest.id, dest.type, "failed", err.message);
    }
  }

  return results;
}

module.exports = { route };
