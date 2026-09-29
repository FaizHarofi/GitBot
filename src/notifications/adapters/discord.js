// adapters/discord.js — formats a NormalizedNotification as a Discord embed
// and sends it to a channel. Reuses the existing embeds.js formatters for
// full fidelity; falls back to a generic embed for unknown event types.

"use strict";

const { EmbedBuilder } = require("discord.js");
const { buildEmbed } = require("../../bot/embeds");
const { logError } = require("../../errors");

/**
 * Send a notification to a Discord channel.
 * @param {object} notification  — NormalizedNotification
 * @param {string} channelId     — Discord channel snowflake
 * @param {object} client        — discord.js Client
 */
async function send(notification, channelId, client) {
  if (!client.isReady()) {
    throw new Error("Discord client is not ready");
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel) {
    throw new Error(`Channel ${channelId} not found`);
  }

  // Try the rich formatter first (existing embeds.js)
  let embed = buildEmbed(notification.eventType, notification.rawPayload);

  // Fallback: generic embed from the normalized data
  if (!embed) {
    embed = buildGenericEmbed(notification);
  }

  if (!embed) {
    // Event has no visual representation (e.g. check_run success — intentionally silent)
    return;
  }

  embed.setFooter({
    text: `Repository: ${notification.repositoryFullName}`,
    iconURL: notification.actorAvatar || undefined,
  });

  await channel.send({ embeds: [embed] });
}

function buildGenericEmbed(n) {
  if (!n.title) return null;
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(n.title.slice(0, 256))
    .setDescription(n.description ? n.description.slice(0, 4096) : null)
    .setURL(n.url || null)
    .setTimestamp(n.timestamp);
}

module.exports = { send };
