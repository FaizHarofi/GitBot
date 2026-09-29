// index.js — GitBot V5 entry point
// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap only: load config, wire handlers, start the webhook + dashboard server.
// Feature code lives under src/.
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

require("./src/config"); // validates env, exits on fatal misconfiguration

const { logError } = require("./src/errors");
const db = require("./src/db/database");
const client = require("./src/bot/client");
const { handleInteraction } = require("./src/bot/handlers/interaction");
const { handleReady } = require("./src/bot/handlers/ready");
const { handleGuildCreate, handleGuildDelete } = require("./src/bot/handlers/guild");
const { startServer } = require("./src/web/server");

// ─── Initialize Database ───────────────────────────────────────────────────────

db.init();
console.log("[db] Database initialized");

// ─── Wire Discord events ──────────────────────────────────────────────────────

client.on("interactionCreate", handleInteraction);
client.once("ready", () => handleReady());
client.on("guildCreate", handleGuildCreate);
client.on("guildDelete", handleGuildDelete);

// ─── Start ────────────────────────────────────────────────────────────────────

startServer(client);

client.login(process.env.DISCORD_TOKEN).catch(err => {
  logError("login", err);
  console.error("❌ Discord login failed:", err.message);
  process.exit(1);
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function shutdown(signal) {
  console.log(`\n👋 ${signal} — shutting down…`);
  client.destroy();
  process.exit(0);
}
