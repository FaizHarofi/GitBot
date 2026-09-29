// server.js — Express app assembly and startup (GitBot V5)
// Mounts: webhook router, authenticated API, dashboard SPA

"use strict";

const express = require("express");
const path = require("path");

const { PORT } = require("../config");
const { createWebhookRouter } = require("./webhook");
const { logError } = require("../errors");
const apiRouter = require("./api");
const dashboardRouter = require("./dashboard");
const whatsapp = require("../notifications/adapters/whatsapp");

function createServer(client) {
  const app = express();

  // Make discord client available to API routes via req.app.locals
  app.locals.discordClient = client;

  app.set("trust proxy", 1);

  // ── Security headers ───────────────────────────────────────────────────────
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  // ── Public root ────────────────────────────────────────────────────────────
  app.get("/", (_req, res) => {
    res.json({ name: "GitBot V5", status: "running" });
  });

  // ── Webhook receiver (public) ──────────────────────────────────────────────
  app.use(createWebhookRouter(client));

  // ── Authenticated REST API ─────────────────────────────────────────────────
  app.use(express.json());
  app.use("/api", apiRouter);

  // ── Dashboard SPA ──────────────────────────────────────────────────────────
  app.use("/dashboard", dashboardRouter);

  // Redirect root to dashboard
  app.get("/", (_req, res) => res.redirect("/dashboard"));

  // ── Global error handler ───────────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    logError("server", err, { method: req.method, path: req.path });
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}

function startServer(client) {
  const app = createServer(client);

  // Initialize WhatsApp if enabled
  whatsapp.initialize().catch(err => {
    logError("whatsapp.init", err);
  });

  return app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`   Webhook: POST /webhook/:token`);
    console.log(`   Dashboard: /dashboard`);
    console.log(`   API: /api/*`);
  });
}

module.exports = { createServer, startServer };
