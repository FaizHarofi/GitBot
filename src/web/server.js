// server.js — Express app assembly and startup

"use strict";

const express = require("express");

const { PORT } = require("../config");
const { createWebhookRouter } = require("./webhook");
const { logError } = require("../errors");

function createServer(client) {
  const app = express();
  app.set("trust proxy", 1);

  app.get("/", (_req, res) => {
    res.json({
      name: "GitBot V4",
      version: "4.0.0",
      status: "running",
      endpoints: { health: "/health", webhook: "/webhook/:token (POST only)" },
    });
  });

  app.use(createWebhookRouter(client));
  return app;
}

function startServer(client) {
  const app = createServer(client);
  return app.listen(PORT, () => {
    console.log(`🌐 Webhook server on port ${PORT}`);
  });
}

module.exports = { createServer, startServer };
