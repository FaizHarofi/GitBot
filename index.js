// index.js — GitBot V4 entry point (multi-tenant)
// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap only: load config, wire handlers, start the webhook server.
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
const { handlePolledEvent } = require("./src/web/webhook");
const { startServer } = require("./src/web/server");
const { GitHubPoller } = require("./src/github/poller");

// ─── Initialize Database ───────────────────────────────────────────────────────

db.init();
console.log("[db] Database initialized");

// ─── GitHub Poller (fallback for repos without webhooks) ──────────────────────

const githubPoller = new GitHubPoller({
  interval: 60000,
  onEvent: (eventType, payload, repo) => {
    handlePolledEvent(eventType, payload, repo, client);
  },
});

// ─── Wire Discord events ──────────────────────────────────────────────────────

client.on("interactionCreate", handleInteraction);
client.once("ready", () => handleReady(githubPoller));
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
