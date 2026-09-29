// handlers/ready.js — one-time startup work after the bot logs in

"use strict";

const { ActivityType } = require("discord.js");

const client = require("../client");
const { setBotOwnerId } = require("../repoCommands");
const { registerCommands } = require("../register");
const { rotatePresence } = require("../presence");
const { getBaseUrl } = require("../../config");
const { logError } = require("../../errors");

async function handleReady() {
  try {
    const app = await client.application.fetch();
    const ownerId = app.owner?.id || app.owner?.ownerId || null;
    if (ownerId) setBotOwnerId(ownerId);
  } catch (err) {
    logError("ready", err, { step: "fetch-owner" });
  }

  const baseUrl = getBaseUrl();

  console.log(`✅ GitBot V5 logged in as ${client.user.tag}`);
  console.log(`   Guilds: ${client.guilds.cache.size}`);
  console.log(`\n🔗 Webhook base URL: ${baseUrl}`);
  console.log(`   Health check:      ${baseUrl}/health`);
  console.log(`   Dashboard:         ${baseUrl}/dashboard\n`);

  client.user.setPresence({
    status: "online",
    activities: [{ name: "GitHub webhooks · V5", type: ActivityType.Watching }],
  });

  setInterval(rotatePresence, 30_000);
  await registerCommands();
}

module.exports = { handleReady };
