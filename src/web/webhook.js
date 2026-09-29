// webhook.js — GitHub webhook receiver (GitBot V5)
// Routes GitHub webhooks by random token, validates signatures,
// filters disabled events, and dispatches via the notification router.

"use strict";

const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { EmbedBuilder } = require("discord.js");

const db = require("../db/database");
const digest = require("../bot/digest");
const mutes = require("../bot/mutes");
const { stats, recordEvent } = require("../stats");
const { logError } = require("../errors");
const { normalize } = require("../notifications/normalizer");
const { route } = require("../notifications/router");

// ─── Signature Verification ───────────────────────────────────────────────────

function verifySignature(rawBody, signature, secret) {
  if (!secret) return true;
  if (!signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Rate Limiters ───────────────────────────────────────────────────────────

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.WEBHOOK_RATE_LIMIT || "30", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many webhook requests. GitHub will retry automatically." },
  keyGenerator: (req) => {
    const forwarded = req.headers["x-forwarded-for"];
    return forwarded ? forwarded.split(",")[0].trim() : (req.ip || "unknown");
  },
});

const healthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.HEALTH_RATE_LIMIT || "60", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many health check requests." },
});

// ─── Webhook Router ───────────────────────────────────────────────────────────

function createWebhookRouter(client) {
  const router = express.Router();

  router.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

  // Health check (minimal — does not expose internal details to public)
  router.get("/health", healthLimiter, async (_req, res) => {
    try {
      res.json({
        status: "ok",
        version: "5.0.0",
        bot: client.isReady() ? "connected" : "disconnected",
        uptime: Math.floor(process.uptime()),
      });
    } catch (err) {
      logError("health", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Per-repository webhook: /webhook/:token (random hex) or legacy /webhook/:id
  router.post("/webhook/:id", webhookLimiter, async (req, res) => {
    const id = req.params.id;
    try {
      let repo = null;
      if (/^\d+$/.test(id)) {
        repo = await db.getRepositoryById(parseInt(id, 10));
      } else {
        repo = await db.getRepositoryByWebhookToken(id);
      }
      if (!repo) return res.status(404).send("Not found");
      await handleWebhook(req, res, client, repo);
    } catch (err) {
      logError("webhook.route", err, { path: id });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Per-repository webhook by name: /webhook/:owner/:repo
  router.post("/webhook/:owner/:repo", webhookLimiter, async (req, res) => {
    const { owner, repo: repoName } = req.params;
    const fullName = `${owner}/${repoName}`;
    try {
      const allGuilds = await db.getAllGuilds();
      for (const guild of allGuilds) {
        const repoData = await db.getRepositoryByFullName(guild.id, fullName);
        if (repoData) return handleWebhook(req, res, client, repoData);
      }
      return res.status(404).send("Not found");
    } catch (err) {
      logError("webhook.namedroute", err, { path: fullName });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

// ─── Main webhook handler ─────────────────────────────────────────────────────

async function handleWebhook(req, res, client, repo) {
  const sig = req.headers["x-hub-signature-256"];
  const eventType = req.headers["x-github-event"];
  const payload = req.body;

  if (!eventType) {
    return res.status(400).send("Missing X-GitHub-Event header");
  }

  if (!repo) {
    recordEvent("unknown", "ignored");
    return res.status(404).send("Not found");
  }

  if (!repo.is_active) {
    recordEvent(eventType, "ignored");
    return res.status(410).send("Repository inactive");
  }

  // Verify webhook signature
  if (repo.webhook_secret) {
    if (!verifySignature(req.rawBody, sig, repo.webhook_secret)) {
      console.warn(`[webhook] Invalid signature for ${repo.full_name}`);
      recordEvent(eventType, "ignored");
      return res.status(401).send("Invalid signature");
    }
  }

  // Respond immediately — GitHub's delivery timeout is 10s
  res.status(200).json({ status: "ok" });

  console.log(`[webhook] ${eventType} from ${repo.full_name} (action: ${payload.action || "n/a"})`);

  // ── Ping event — special handling ─────────────────────────────────────────
  if (eventType === "ping") {
    await handlePing(client, repo, payload);
    digest.push(eventType, payload, "sent", repo.full_name);
    recordEvent(eventType, "sent");
    return;
  }

  // ── Check per-repo event config ───────────────────────────────────────────
  let eventEnabled = true;
  try {
    eventEnabled = await db.isEventEnabled(repo.id, eventType);
  } catch (err) {
    logError("webhook.eventConfig", err, { event: eventType, repo: repo.full_name });
  }

  if (!eventEnabled) {
    console.log(`[webhook] ${eventType} from ${repo.full_name} — ignored (event disabled)`);
    digest.push(eventType, payload, "ignored", repo.full_name);
    recordEvent(eventType, "ignored");
    await db.logEvent(repo.id, eventType, payload.action, "ignored", "event disabled for this repository", null);
    return;
  }

  // ── Mute check ────────────────────────────────────────────────────────────
  if (mutes.isMuted(eventType)) {
    console.log(`[webhook] ${eventType} muted — skipping`);
    digest.push(eventType, payload, "muted", repo.full_name);
    recordEvent(eventType, "muted");
    await db.logEvent(repo.id, eventType, payload.action, "ignored", "event type muted", null);
    return;
  }

  // ── Normalize + route ─────────────────────────────────────────────────────
  let eventLogId = null;
  try {
    const notification = normalize(eventType, payload);

    // Log the event first (get ID for notification log FK)
    eventLogId = await db.logEvent(
      repo.id, eventType, payload.action, "processed", null,
      { actor: notification.actor }
    );

    const results = await route(notification, repo, client, eventLogId);

    const allFailed = results.length > 0 && results.every(r => r.status === "failed");
    const anySent = results.some(r => r.status === "sent");

    if (anySent) {
      digest.push(eventType, payload, "sent", repo.full_name);
      recordEvent(eventType, "sent");
      console.log(`[webhook] ${eventType} from ${repo.full_name} → ${results.filter(r => r.status === "sent").map(r => r.destination).join(", ")}`);
    } else if (allFailed) {
      digest.push(eventType, payload, "dropped", repo.full_name);
      recordEvent(eventType, "dropped");
      // Update event log status to failed
      await db.logEvent(repo.id, eventType, payload.action, "failed", "all destinations failed", null);
    } else {
      // No destinations configured or embed returned null (intentionally silent event)
      digest.push(eventType, payload, "ignored", repo.full_name);
      recordEvent(eventType, "ignored");
    }

  } catch (err) {
    logError("webhook", err, { event: eventType, repo: repo.full_name });
    digest.push(eventType, payload, "dropped", repo.full_name);
    recordEvent(eventType, "dropped");
    if (eventLogId === null) {
      await db.logEvent(repo.id, eventType, payload.action, "failed", err.message, null);
    }
  }
}

// ─── Ping handler ────────────────────────────────────────────────────────────

async function handlePing(client, repo, payload) {
  if (!client.isReady() || !repo.channel_id) return;
  try {
    const channel = await client.channels.fetch(repo.channel_id);
    if (!channel) return;

    const pingEmbed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle("🏓 GitHub Ping Received")
      .setDescription(
        `GitHub successfully reached the webhook for **${repo.full_name}**.\n\n` +
        `The connection is live — events will now appear in this channel.`
      )
      .addFields(
        { name: "Repository", value: `[${repo.full_name}](https://github.com/${repo.full_name})`, inline: true },
        { name: "Hook ID", value: String(payload.hook_id || "—"), inline: true },
      )
      .setTimestamp();

    await channel.send({ embeds: [pingEmbed] });
  } catch (err) {
    logError("webhook.ping", err, { repo: repo.full_name });
  }
}

module.exports = { createWebhookRouter, verifySignature };
