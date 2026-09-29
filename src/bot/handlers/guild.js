// handlers/guild.js — guild join/leave events

"use strict";

const { EmbedBuilder } = require("discord.js");

const db = require("../../db/database");
const { getBaseUrl } = require("../../config");
const { logError } = require("../../errors");

async function handleGuildCreate(guild) {
  try {
    await db.ensureGuild(guild.id, guild.name, guild.ownerId);
    console.log(`[bot] Joined guild: ${guild.name} (${guild.id})`);

    // Send welcome message to system channel
    const systemChannel = guild.systemChannel;
    if (systemChannel) {
      const baseUrl = getBaseUrl();

      const welcomeEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("👋 GitBot V4 — GitHub Notifications")
        .setDescription(
          "Thanks for adding GitBot! I'll send GitHub events (pushes, PRs, issues, releases) to your Discord channels.\n\n" +
          "**Quick start:**\n" +
          "1. Use `/repo add owner/repo` to add a GitHub repository\n" +
          "2. I'll create a channel and give you a webhook URL\n" +
          "3. Add that URL to your GitHub repo's Webhooks settings\n\n" +
          "**Commands:**\n" +
          "• `/repo add/remove/list/info/enable` — Manage repositories\n" +
          "• `/admin add/remove/list` — Manage bot admins\n" +
          "• `/mute` — Silence specific event types\n" +
          "• `/status` — View bot statistics"
        )
        .addFields(
          { name: "🔗 Webhook URL", value: `\`${baseUrl}/webhook\``, inline: false },
          { name: "📖 Help", value: "Use `/help` for detailed guides", inline: false },
        )
        .setTimestamp();

      await systemChannel.send({ embeds: [welcomeEmbed] });
    }
  } catch (err) {
    logError("guildCreate", err, { guild: guild.id });
  }
}

function handleGuildDelete(guild) {
  console.log(`[bot] Left guild: ${guild.name} (${guild.id})`);
}

module.exports = { handleGuildCreate, handleGuildDelete };
