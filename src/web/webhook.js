// webhook.js — Express webhook server (multi-tenant)
// Routes GitHub webhooks to the correct repository by random token (or legacy ID).

"use strict";

const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { EmbedBuilder } = require("discord.js");

const db = require("../db/database");
const { buildEmbed } = require("../bot/embeds");
const digest = require("../bot/digest");
const mutes = require("../bot/mutes");
const { stats, recordEvent } = require("../stats");
const { logError } = require("../errors");

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
  message: {
    error: "Too many webhook requests. GitHub will retry automatically.",
    retryAfter: "Check X-RateLimit-Reset header",
  },
  keyGenerator: (req) => {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      return forwarded.split(",")[0].trim();
    }
    return req.ip || "unknown";
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

  // Health check
  router.get("/health", healthLimiter, async (_req, res) => {
    try {
      const allGuilds = await db.getAllGuilds();
      let totalRepos = 0;
      let totalPollable = 0;

      for (const guild of allGuilds) {
        const repos = await db.getAllRepositories(guild.id);
        const pollable = await db.getPollableRepositories(guild.id);
        totalRepos += repos.length;
        totalPollable += pollable.length;
      }

      res.json({
        status: "ok",
        version: "4.0.0",
        mode: "multi-tenant",
        rateLimit: {
          webhookMax: parseInt(process.env.WEBHOOK_RATE_LIMIT || "30", 10),
          healthMax: parseInt(process.env.HEALTH_RATE_LIMIT || "60", 10),
        },
        bot: client.isReady() ? "connected" : "disconnected",
        uptime: process.uptime(),
        guilds: allGuilds.length,
        repos: totalRepos,
        polling: totalPollable,
        mutes: mutes.list().map(m => ({
          event: m.eventType,
          expiresAt: m.expiresAt,
          reason: m.reason,
        })),
        stats: {
          eventsReceived: stats.eventsReceived,
          eventsSent: stats.eventsSent,
          eventsDropped: stats.eventsDropped,
          eventsIgnored: stats.eventsIgnored,
          eventsMuted: stats.eventsMuted,
        },
      });
    } catch (err) {
      logError("health", err);
      res.status(500).json({ error: err.message });
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

      if (!repo) {
        return res.status(404).send("Repository not found");
      }
      handleWebhook(req, res, client, repo);
    } catch (err) {
      logError("webhook.route", err, { path: id });
      res.status(500).json({ error: "Internal error" });
    }
  });

  // Per-repository webhook by name: /webhook/:owner/:repo
  router.post("/webhook/:owner/:repo", webhookLimiter, async (req, res) => {
    const { owner, repo: repoName } = req.params;
    const fullName = `${owner}/${repoName}`;

    // Search across all guilds
    const allGuilds = await db.getAllGuilds();
    for (const guild of allGuilds) {
      const repoData = await db.getRepositoryByFullName(guild.id, fullName);
      if (repoData) {
        return handleWebhook(req, res, client, repoData);
      }
    }

    return res.status(404).send("Repository not found");
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
    console.log(`[webhook] No repo matched, ignoring`);
    digest.push(eventType, payload, "ignored");
    recordEvent(eventType, "ignored");
    return res.status(404).send("Repository not found");
  }

  if (!repo.is_active) {
    console.log(`[webhook] Repo ${repo.full_name} is inactive, skipping`);
    digest.push(eventType, payload, "ignored");
    recordEvent(eventType, "ignored");
    return res.status(410).send("Repository inactive");
  }

  // Verify webhook secret if configured
  if (repo.webhook_secret) {
    if (!verifySignature(req.rawBody, sig, repo.webhook_secret)) {
      console.warn(`[webhook] Invalid signature for ${repo.full_name} - rejecting`);
      digest.push(eventType, payload, "ignored");
      recordEvent(eventType, "ignored");
      return res.status(401).send("Invalid signature");
    }
  } else {
    console.log(`[webhook] No secret for ${repo.full_name} — accepting`);
  }

  // Respond immediately — GitHub's delivery timeout is 10s
  res.status(200).send("OK");

  console.log(`[webhook] ${eventType} from ${repo.full_name} (guild: ${repo.guild_id}, action: ${payload.action || "n/a"})`);

  if (!client.isReady()) {
    return;
  }

  // Handle ping
  if (eventType === "ping") {
    console.log(`[webhook] Ping received for ${repo.full_name} — webhook is live`);
    try {
      const channel = await client.channels.fetch(repo.channel_id);
      if (channel) {
        const pingEmbed = new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle("🏓 GitHub Ping Received")
          .setDescription(
            `GitHub successfully reached the webhook for **${repo.full_name}**.\n\n` +
            `The connection is live — events will now appear in this channel.`
          )
          .addFields(
            { name: "Repository", value: `[${repo.full_name}](${payload.repository?.html_url || `https://github.com/${repo.full_name}`})`, inline: true },
            { name: "Hook ID", value: String(payload.hook_id || "—"), inline: true },
          )
          .setFooter({ text: "Waiting for you to click ✅ I've added the webhook in your DM" })
          .setTimestamp();

        await channel.send({ embeds: [pingEmbed] });
      }
    } catch (err) {
      console.error(`[webhook] Could not post ping embed for ${repo.full_name}: ${err.message}`);
    }
    digest.push(eventType, payload, "sent", repo.full_name);
    recordEvent(eventType, "sent");
    return;
  }

  try {
    if (mutes.isMuted(eventType)) {
      console.log(`[webhook] "${eventType}" muted — skipping post`);
      digest.push(eventType, payload, "muted", repo.full_name);
      recordEvent(eventType, "muted");
      return;
    }

    const embed = buildEmbed(eventType, payload);
    if (!embed) {
      console.log(`[webhook] No embed for "${eventType}" action="${payload.action}" — skipping`);
      digest.push(eventType, payload, "ignored", repo.full_name);
      recordEvent(eventType, "ignored");
      return;
    }

    embed.setFooter({
      text: `Repository: ${repo.full_name}`,
      iconURL: payload.repository?.owner?.avatar_url || undefined,
    });

    const channelId = repo.channel_id;
    if (!channelId) {
      console.log(`[webhook] No channel configured for ${repo.full_name}`);
      digest.push(eventType, payload, "dropped", repo.full_name);
      recordEvent(eventType, "dropped");
      return;
    }

    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      console.error(`[webhook] Channel ${channelId} not found for ${repo.full_name}`);
      digest.push(eventType, payload, "dropped", repo.full_name);
      recordEvent(eventType, "dropped");
      return;
    }

    await channel.send({ embeds: [embed] });
    digest.push(eventType, payload, "sent", repo.full_name);
    recordEvent(eventType, "sent");
    console.log(`[webhook] "${eventType}" from ${repo.full_name} → #${channel.name}`);

  } catch (err) {
    logError("webhook", err, { event: eventType, repo: repo.full_name, guild: repo.guild_id });
    digest.push(eventType, payload, "dropped", repo.full_name);
    recordEvent(eventType, "dropped");
  }
}

// ─── Event Handler for Polling ───────────────────────────────────────────────

async function handlePolledEvent(eventType, payload, repo, client) {
  if (!repo.is_active) return;
  if (!repo.channel_id) return;

  if (mutes.isMuted(eventType)) {
    console.log(`[poller] "${eventType}" muted, skipping`);
    digest.push(eventType, payload, "muted", repo.full_name);
    recordEvent(eventType, "muted");
    return;
  }

  const embed = buildEmbed(eventType, payload);
  if (!embed) {
    digest.push(eventType, payload, "ignored", repo.full_name);
    recordEvent(eventType, "ignored");
    return;
  }

  embed.setFooter({
    text: `Repository: ${repo.full_name} (polled)`,
  });

  try {
    const channel = await client.channels.fetch(repo.channel_id);
    if (!channel) {
      console.error(`[poller] Channel ${repo.channel_id} not found`);
      digest.push(eventType, payload, "dropped", repo.full_name);
      recordEvent(eventType, "dropped");
      return;
    }

    await channel.send({ embeds: [embed] });
    console.log(`[poller] "${eventType}" from ${repo.full_name} → #${channel.name}`);
    digest.push(eventType, payload, "sent", repo.full_name);
    recordEvent(eventType, "sent");
  } catch (err) {
    logError("poller", err, { event: eventType, repo: repo.full_name });
    digest.push(eventType, payload, "dropped", repo.full_name);
    recordEvent(eventType, "dropped");
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  createWebhookRouter,
  handlePolledEvent,
  verifySignature,
};
