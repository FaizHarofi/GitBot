// api.js — authenticated REST API for the dashboard
// All routes require a valid session (enforced by requireAuth middleware).

"use strict";

const express = require("express");
const crypto = require("crypto");

const db = require("../db/database");
const { requireAuth } = require("./auth");
const { getBaseUrl } = require("../config");
const { logError } = require("../errors");
const whatsapp = require("../notifications/adapters/whatsapp");

const router = express.Router();
router.use(requireAuth);

// ─── Helper ───────────────────────────────────────────────────────────────────

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

// ─── Stats ────────────────────────────────────────────────────────────────────

router.get("/stats", async (req, res) => {
  try {
    const guilds = await db.getAllGuilds();
    let totalRepos = 0, totalDestinations = 0;
    let totalProcessed = 0, totalIgnored = 0, totalFailed = 0;

    for (const guild of guilds) {
      const s = await db.getDashboardStats(guild.id);
      totalRepos += s.repos;
      totalDestinations += s.destinations;
      totalProcessed += s.events.processed;
      totalIgnored += s.events.ignored;
      totalFailed += s.events.failed;
    }

    const discord = req.app.locals.discordClient;

    res.json({
      repositories: totalRepos,
      destinations: totalDestinations,
      guilds: guilds.length,
      events: {
        total: totalProcessed + totalIgnored + totalFailed,
        processed: totalProcessed,
        ignored: totalIgnored,
        failed: totalFailed,
      },
      discord: {
        status: discord?.isReady() ? "connected" : "disconnected",
        tag: discord?.user?.tag || null,
        guilds: discord?.guilds?.cache?.size || 0,
        ping: discord?.ws?.ping || null,
      },
      whatsapp: {
        status: whatsapp.getStatus(),
      },
      uptime: Math.floor(process.uptime()),
    });
  } catch (err) {
    logError("api.stats", err);
    sendError(res, 500, "Internal server error");
  }
});

// ─── Guilds ───────────────────────────────────────────────────────────────────

router.get("/guilds", async (_req, res) => {
  try {
    const guilds = await db.getAllGuilds();
    res.json(guilds);
  } catch (err) {
    logError("api.guilds", err);
    sendError(res, 500, "Internal server error");
  }
});

// ─── Repositories ─────────────────────────────────────────────────────────────

router.get("/repositories", async (req, res) => {
  try {
    const { guild_id } = req.query;
    let repos;
    if (guild_id) {
      repos = await db.getAllRepositories(guild_id);
    } else {
      repos = await db.getAllRepositoriesAcrossGuilds();
    }
    // Strip webhook_secret from response
    res.json(repos.map(r => sanitizeRepo(r)));
  } catch (err) {
    logError("api.repositories", err);
    sendError(res, 500, "Internal server error");
  }
});

router.get("/repositories/:id", async (req, res) => {
  try {
    const repo = await db.getRepositoryById(parseInt(req.params.id, 10));
    if (!repo) return sendError(res, 404, "Repository not found");
    res.json(sanitizeRepo(repo));
  } catch (err) {
    logError("api.repositories.get", err);
    sendError(res, 500, "Internal server error");
  }
});

router.patch("/repositories/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const repo = await db.getRepositoryById(id);
    if (!repo) return sendError(res, 404, "Repository not found");

    const { is_active, channel_id } = req.body;
    const updates = {};
    if (typeof is_active === "boolean") updates.is_active = is_active;
    if (channel_id) updates.channel_id = channel_id;

    await db.updateRepository(id, updates);
    res.json({ ok: true });
  } catch (err) {
    logError("api.repositories.patch", err);
    sendError(res, 500, "Internal server error");
  }
});

router.delete("/repositories/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const repo = await db.getRepositoryById(id);
    if (!repo) return sendError(res, 404, "Repository not found");
    await db.deleteRepository(id);
    res.json({ ok: true });
  } catch (err) {
    logError("api.repositories.delete", err);
    sendError(res, 500, "Internal server error");
  }
});

// Webhook URL helper
router.get("/repositories/:id/webhook-url", async (req, res) => {
  try {
    const repo = await db.getRepositoryById(parseInt(req.params.id, 10));
    if (!repo) return sendError(res, 404, "Repository not found");
    const baseUrl = getBaseUrl();
    res.json({
      url: `${baseUrl}/webhook/${repo.webhook_token}`,
      hasSecret: !!repo.webhook_secret,
    });
  } catch (err) {
    logError("api.repositories.webhook-url", err);
    sendError(res, 500, "Internal server error");
  }
});

// ─── Event Configuration ──────────────────────────────────────────────────────

router.get("/repositories/:id/events", async (req, res) => {
  try {
    const repo = await db.getRepositoryById(parseInt(req.params.id, 10));
    if (!repo) return sendError(res, 404, "Repository not found");
    const config = await db.getRepositoryEventConfig(repo.id);
    res.json({ repositoryId: repo.id, events: config });
  } catch (err) {
    logError("api.events.get", err);
    sendError(res, 500, "Internal server error");
  }
});

router.put("/repositories/:id/events", async (req, res) => {
  try {
    const repo = await db.getRepositoryById(parseInt(req.params.id, 10));
    if (!repo) return sendError(res, 404, "Repository not found");

    const config = req.body;
    if (typeof config !== "object" || Array.isArray(config)) {
      return sendError(res, 400, "Body must be an object of { eventType: boolean }");
    }
    // Validate event types
    const invalid = Object.keys(config).filter(k => !db.SUPPORTED_EVENTS.includes(k));
    if (invalid.length > 0) {
      return sendError(res, 400, `Unknown event types: ${invalid.join(", ")}`);
    }

    await db.setRepositoryEventConfig(repo.id, config);
    res.json({ ok: true });
  } catch (err) {
    logError("api.events.put", err);
    sendError(res, 500, "Internal server error");
  }
});

router.patch("/repositories/:id/events/:eventType", async (req, res) => {
  try {
    const repo = await db.getRepositoryById(parseInt(req.params.id, 10));
    if (!repo) return sendError(res, 404, "Repository not found");

    const { eventType } = req.params;
    if (!db.SUPPORTED_EVENTS.includes(eventType)) {
      return sendError(res, 400, `Unknown event type: ${eventType}`);
    }

    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return sendError(res, 400, "enabled must be a boolean");
    }

    await db.setEventEnabled(repo.id, eventType, enabled);
    res.json({ ok: true, eventType, enabled });
  } catch (err) {
    logError("api.events.patch", err);
    sendError(res, 500, "Internal server error");
  }
});

// ─── Destinations ─────────────────────────────────────────────────────────────

router.get("/destinations", async (req, res) => {
  try {
    const { guild_id } = req.query;
    if (!guild_id) return sendError(res, 400, "guild_id is required");
    const destinations = await db.getAllDestinations(guild_id);
    res.json(destinations);
  } catch (err) {
    logError("api.destinations.list", err);
    sendError(res, 500, "Internal server error");
  }
});

router.post("/destinations", async (req, res) => {
  try {
    const { guild_id, type, name, identifier } = req.body;
    if (!guild_id || !type || !name || !identifier) {
      return sendError(res, 400, "guild_id, type, name, and identifier are required");
    }
    if (!["discord", "whatsapp"].includes(type)) {
      return sendError(res, 400, "type must be 'discord' or 'whatsapp'");
    }
    const dest = await db.addDestination(guild_id, type, name, identifier);
    res.status(201).json(dest);
  } catch (err) {
    logError("api.destinations.create", err);
    sendError(res, 500, "Internal server error");
  }
});

router.patch("/destinations/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const dest = await db.getDestination(id);
    if (!dest) return sendError(res, 404, "Destination not found");
    await db.updateDestination(id, req.body);
    res.json({ ok: true });
  } catch (err) {
    logError("api.destinations.patch", err);
    sendError(res, 500, "Internal server error");
  }
});

router.delete("/destinations/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const dest = await db.getDestination(id);
    if (!dest) return sendError(res, 404, "Destination not found");
    await db.deleteDestination(id);
    res.json({ ok: true });
  } catch (err) {
    logError("api.destinations.delete", err);
    sendError(res, 500, "Internal server error");
  }
});

// ─── Repository-Event-Destination Mappings ────────────────────────────────────

router.get("/repositories/:id/mappings", async (req, res) => {
  try {
    const repo = await db.getRepositoryById(parseInt(req.params.id, 10));
    if (!repo) return sendError(res, 404, "Repository not found");
    const mappings = await db.getAllMappingsForRepository(repo.id);
    res.json(mappings);
  } catch (err) {
    logError("api.mappings.list", err);
    sendError(res, 500, "Internal server error");
  }
});

router.post("/repositories/:id/mappings", async (req, res) => {
  try {
    const repo = await db.getRepositoryById(parseInt(req.params.id, 10));
    if (!repo) return sendError(res, 404, "Repository not found");

    const { event_type, destination_id } = req.body;
    if (!destination_id) return sendError(res, 400, "destination_id is required");
    if (event_type && !db.SUPPORTED_EVENTS.includes(event_type)) {
      return sendError(res, 400, `Unknown event type: ${event_type}`);
    }

    const dest = await db.getDestination(parseInt(destination_id, 10));
    if (!dest) return sendError(res, 404, "Destination not found");

    const mapping = await db.addDestinationMapping(repo.id, event_type || null, dest.id);
    res.status(201).json(mapping);
  } catch (err) {
    logError("api.mappings.create", err);
    sendError(res, 500, "Internal server error");
  }
});

router.delete("/mappings/:id", async (req, res) => {
  try {
    await db.removeDestinationMapping(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) {
    logError("api.mappings.delete", err);
    sendError(res, 500, "Internal server error");
  }
});

// ─── Activity / Event Logs ────────────────────────────────────────────────────

router.get("/activity", async (req, res) => {
  try {
    const { repository_id, status, limit } = req.query;
    const logs = await db.getEventLogs({
      repositoryId: repository_id ? parseInt(repository_id, 10) : undefined,
      status,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
    });
    res.json(logs);
  } catch (err) {
    logError("api.activity", err);
    sendError(res, 500, "Internal server error");
  }
});

router.get("/notifications", async (req, res) => {
  try {
    const { event_log_id, destination_id, limit } = req.query;
    const logs = await db.getNotificationLogs({
      eventLogId: event_log_id ? parseInt(event_log_id, 10) : undefined,
      destinationId: destination_id ? parseInt(destination_id, 10) : undefined,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
    });
    res.json(logs);
  } catch (err) {
    logError("api.notifications", err);
    sendError(res, 500, "Internal server error");
  }
});

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

router.get("/whatsapp/status", async (_req, res) => {
  res.json({ status: whatsapp.getStatus() });
});

router.get("/whatsapp/groups", async (_req, res) => {
  try {
    const groups = await whatsapp.listGroups();
    res.json(groups);
  } catch (err) {
    logError("api.whatsapp.groups", err);
    sendError(res, 500, "Internal server error");
  }
});

// ─── Discord ──────────────────────────────────────────────────────────────────

router.get("/discord/status", async (req, res) => {
  const discord = req.app.locals.discordClient;
  res.json({
    status: discord?.isReady() ? "connected" : "disconnected",
    tag: discord?.user?.tag || null,
    ping: discord?.ws?.ping || null,
    guilds: discord?.guilds?.cache?.size || 0,
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeRepo(r) {
  const { webhook_secret, ...safe } = r;
  return {
    ...safe,
    has_webhook_secret: !!webhook_secret,
  };
}

module.exports = router;
