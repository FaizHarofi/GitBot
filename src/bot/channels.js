// channels.js — resolve guild channels by name (cache first, then fetch)

"use strict";

const client = require("./client");
const { logError } = require("../errors");

async function getChannel(guildId, name) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.warn(`[bot] Guild ${guildId} not found in cache`);
    return null;
  }

  let ch = guild.channels.cache.find(c => c.name === name && c.isTextBased());
  if (!ch) {
    try {
      const all = await guild.channels.fetch();
      ch = all.find(c => c?.name === name && c.isTextBased()) || null;
    } catch (e) {
      logError("channels", e, { guildId, channel: name });
    }
  }
  if (!ch) console.warn(`[bot] Channel "#${name}" not found in guild ${guildId}.`);
  return ch || null;
}

module.exports = { getChannel };
