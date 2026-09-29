// config.js — environment loading, validation, and shared runtime constants

"use strict";

require("dotenv").config();

const os = require("os");

// ─── Startup validation ───────────────────────────────────────────────────────

const REQUIRED_ENV = ["DISCORD_TOKEN", "SUPABASE_URL", "SUPABASE_KEY"];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error(`❌ Missing environment variables: ${missingEnv.join(", ")}`);
  console.error("   Copy .env.example to .env and fill in your values.");
  process.exit(1);
}

if (!process.env.DASHBOARD_SECRET) {
  console.warn("⚠️  DASHBOARD_SECRET is not set — the dashboard will be inaccessible until it is.");
}

const PORT = parseInt(process.env.PORT || process.env.WEBHOOK_PORT || "3000", 10);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function getBaseUrl() {
  return (process.env.WEBHOOK_BASE_URL || `http://${getLocalIP()}:${PORT}`).replace(/\/$/, "");
}

module.exports = { REQUIRED_ENV, PORT, getLocalIP, getBaseUrl };
