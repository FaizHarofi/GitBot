// index.js — GitBot V4 (Multi-Tenant)
// ─────────────────────────────────────────────────────────────────────────────
// V4 changes:
//   - Supabase PostgreSQL for multi-tenant data storage
//   - Global slash commands (works in all guilds)
//   - Per-guild workspace isolation
//   - Auto-detect local IP for webhook URL display
//   - Removed legacy config.json support
// ─────────────────────────────────────────────────────────────────────────────

"use strict";
require("dotenv").config();

const os = require("os");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType,
} = require("discord.js");

const express = require("express");

// Database and modules
const db = require("./database");
const { helpCommand, handleHelpInteraction } = require("./help");
const digest = require("./digest");
const mutes = require("./mutes");
const poller = require("./poller");
const {
  repoCommands,
  handleRepoCommand,
  handleAdminCommand,
  handleRepoInteraction,
  setBotOwnerId,
} = require("./repoCommands");
const {
  createWebhookRouter,
  handlePolledEvent,
  stats: webhookStats,
} = require("./multiWebhook");

// ─── Startup validation ───────────────────────────────────────────────────────

const REQUIRED_ENV = ["DISCORD_TOKEN", "SUPABASE_URL", "SUPABASE_KEY"];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error(`❌ Missing environment variables: ${missingEnv.join(", ")}`);
  console.error("   Copy .env.example to .env and fill in your values.");
  process.exit(1);
}

// ─── Local IP detection ──────────────────────────────────────────────────────

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

// ─── Stats ────────────────────────────────────────────────────────────────────
// Shared with multiWebhook.js so /status and /events reflect real webhook traffic.

const stats = webhookStats;

function resetStats() {
  stats.eventsReceived = 0;
  stats.eventsSent = 0;
  stats.eventsDropped = 0;
  stats.eventsIgnored = 0;
  stats.eventsMuted = 0;
  stats.startTime = Date.now();
  stats.lastEvent = null;
  stats.lastEventTime = null;
  stats.eventCounts = {};
}

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─── Shared embed builders ────────────────────────────────────────────────────

function buildStatusEmbed() {
  const sec = Math.floor((Date.now() - stats.startTime) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  const activeMutes = mutes.list();
  const muteStr = activeMutes.length
    ? activeMutes.map(mu => {
        const left = Math.ceil((mu.expiresAt.getTime() - Date.now()) / 60_000);
        return `\`${mu.eventType}\` (${left}m left)`;
      }).join(", ")
    : "_none_";

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("🤖 GitBot V4 — Status")
    .setThumbnail(client.user.displayAvatarURL())
    .addFields(
      { name: "🟢 Bot", value: `**${client.user.tag}**`, inline: false },
      { name: "⏱️ Uptime", value: `${h}h ${m}m ${s}s`, inline: true },
      { name: "📡 WS Ping", value: `${client.ws.ping}ms`, inline: true },
      { name: "📦 Port", value: String(process.env.WEBHOOK_PORT || 3000), inline: true },
      { name: "📬 Received", value: String(stats.eventsReceived), inline: true },
      { name: "✉️ Sent", value: String(stats.eventsSent), inline: true },
      { name: "🔇 Muted", value: String(stats.eventsMuted), inline: true },
      { name: "🚫 Dropped", value: String(stats.eventsDropped), inline: true },
      { name: "⏭️ Ignored", value: String(stats.eventsIgnored), inline: true },
      { name: "🔕 Active mutes", value: muteStr, inline: false },
    )
    .setFooter({
      text: stats.lastEvent
        ? `Last: ${stats.lastEvent} at ${stats.lastEventTime?.toLocaleTimeString()}`
        : "No events yet",
    })
    .setTimestamp();
}

function buildEventsEmbed() {
  if (stats.eventsReceived === 0) return null;

  const rows = Object.entries(stats.eventCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([evt, count]) => {
      const pct = Math.round((count / stats.eventsReceived) * 10);
      const bar = "█".repeat(pct) + "░".repeat(10 - pct);
      const muted = mutes.isMuted(evt) ? " 🔇" : "";
      return `\`${evt.padEnd(22)}\` **${count}** \`${bar}\`${muted}`;
    })
    .join("\n");

  return new EmbedBuilder()
    .setColor(0xF39C12)
    .setTitle(`📊 Event Breakdown — ${stats.eventsReceived} total`)
    .setDescription(rows)
    .setFooter({
      text: `${stats.eventsSent} sent · ${stats.eventsMuted} muted · ${stats.eventsDropped} dropped · ${stats.eventsIgnored} ignored`,
    })
    .setTimestamp();
}

// ─── Component factories ──────────────────────────────────────────────────────

function btnDismiss(id = "dismiss") {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel("Dismiss")
    .setEmoji("🗑️")
    .setStyle(ButtonStyle.Secondary);
}

function rowDismiss(id = "dismiss") {
  return new ActionRowBuilder().addComponents(btnDismiss(id));
}

function rowRefreshDismiss(refreshId, dismissId = "dismiss") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(refreshId)
      .setLabel("Refresh")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
    btnDismiss(dismissId),
  );
}

function rowRefreshedDismiss(dismissId = "dismiss") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("__noop__")
      .setLabel("Refreshed")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(true),
    btnDismiss(dismissId),
  );
}

// ─── Command definitions ──────────────────────────────────────────────────────

const EVENT_CHOICES = [
  { name: "push", value: "push" },
  { name: "pull_request", value: "pull_request" },
  { name: "issues", value: "issues" },
  { name: "issue_comment", value: "issue_comment" },
  { name: "pull_request_review", value: "pull_request_review" },
  { name: "release", value: "release" },
  { name: "workflow_run", value: "workflow_run" },
  { name: "star", value: "star" },
  { name: "fork", value: "fork" },
  { name: "create", value: "create" },
  { name: "delete", value: "delete" },
  { name: "check_run", value: "check_run" },
  { name: "deployment_status", value: "deployment_status" },
];

const slashCommands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check if the bot is alive and measure latency"),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show bot status, uptime, and event statistics"),

  new SlashCommandBuilder()
    .setName("events")
    .setDescription("Show a breakdown of all events received since bot started"),

  new SlashCommandBuilder()
    .setName("test")
    .setDescription("Send a test embed to verify a channel is set up correctly")
    .addStringOption(o =>
      o.setName("channel").setDescription("Channel name to test (default: first configured)").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Silence an event type for a set duration — it's received but not posted")
    .addStringOption(o =>
      o.setName("event").setDescription("Event type to mute").setRequired(true).addChoices(...EVENT_CHOICES)
    )
    .addStringOption(o =>
      o.setName("reason").setDescription("Optional reason (shown in /watchlist)").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("watchlist")
    .setDescription("Show all active mutes with one-click Unmute buttons"),

  new SlashCommandBuilder()
    .setName("digest")
    .setDescription("Show a live digest of recent GitHub activity")
    .addIntegerOption(o =>
      o.setName("count")
        .setDescription("How many events to show (5–25, default 10)")
        .setMinValue(5)
        .setMaxValue(25)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("clear-stats")
    .setDescription("Reset all event counters — requires confirmation"),

].map(cmd => cmd.toJSON());

const contextMenus = [
  new ContextMenuCommandBuilder()
    .setName("📌 Pin to GitHub log")
    .setType(ApplicationCommandType.Message)
    .toJSON(),

  new ContextMenuCommandBuilder()
    .setName("🔁 Resend this embed")
    .setType(ApplicationCommandType.Message)
    .toJSON(),
];

const allCommands = [...slashCommands, ...repoCommands.map(c => c.toJSON()), helpCommand, ...contextMenus];

// ─── Initialize Database ───────────────────────────────────────────────────────

db.init();
console.log("[db] Database initialized");

// ─── GitHub Poller ────────────────────────────────────────────────────────────

const githubPoller = new poller.GitHubPoller({
  interval: 60000,
  onEvent: (eventType, payload, repo) => {
    handlePolledEvent(eventType, payload, repo, client);
  },
});

// ─── Register ─────────────────────────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log("⏳ Registering commands globally...");
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: allCommands }
    );
    console.log(`✅ Registered ${allCommands.length} commands globally.`);
  } catch (err) {
    console.error("❌ Failed to register:", err.message);
  }
}

// ─── Presence rotation ────────────────────────────────────────────────────────

const presenceMessages = [
  () => ({ name: "GitHub webhooks · V4", type: ActivityType.Watching }),
  () => ({ name: `${stats.eventsReceived} events`, type: ActivityType.Playing }),
  () => {
    const mins = Math.floor((Date.now() - stats.startTime) / 60_000);
    return { name: `up ${mins}m`, type: ActivityType.Playing };
  },
  () => {
    const last = stats.lastEvent;
    return last
      ? { name: `last: ${last}`, type: ActivityType.Watching }
      : { name: "awaiting events…", type: ActivityType.Watching };
  },
];

let presenceIdx = 0;
function rotatePresence() {
  const msg = presenceMessages[presenceIdx++ % presenceMessages.length]();
  client.user.setPresence({ status: "online", activities: [msg] });
}

// ─── Channel resolver ─────────────────────────────────────────────────────────

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
      console.error(`[bot] fetch channels: ${e.message}`);
    }
  }
  if (!ch) console.warn(`[bot] Channel "#${name}" not found in guild ${guildId}.`);
  return ch || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERACTION HANDLER
// ─────────────────────────────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (await handleHelpInteraction(interaction)) return;

  // ══ Slash commands ══════════════════════════════════════════════════════════
  if (interaction.isChatInputCommand()) {
    const cmd = interaction.commandName;

    // ── /ping ────────────────────────────────────────────────────────────────
    if (cmd === "ping") {
      const sent = await interaction.reply({ content: "🏓 Pinging…", fetchReply: true });
      const latency = sent.createdTimestamp - interaction.createdTimestamp;
      const ws = client.ws.ping;

      const bar = (ms) => {
        const blocks = Math.min(10, Math.max(1, Math.round(ms / 20)));
        const color = ms < 80 ? "🟩" : ms < 200 ? "🟨" : "🟥";
        return color.repeat(blocks) + "⬛".repeat(10 - blocks);
      };

      const embed = new EmbedBuilder()
        .setColor(latency < 80 ? 0x2ECC71 : latency < 200 ? 0xF39C12 : 0xE74C3C)
        .setTitle("🏓 Pong!")
        .addFields(
          { name: "Round-trip", value: `${bar(latency)}\n**${latency}ms**`, inline: true },
          { name: "WebSocket", value: `${bar(ws)}\n**${ws}ms**`, inline: true },
        )
        .setTimestamp();

      await interaction.editReply({
        content: "",
        embeds: [embed],
        components: [rowDismiss("ping:dismiss")],
      });
      return;
    }

    // ── /status ──────────────────────────────────────────────────────────────
    if (cmd === "status") {
      await interaction.reply({
        embeds: [buildStatusEmbed()],
        components: [rowRefreshDismiss("status:refresh", "status:dismiss")],
      });
      return;
    }

    // ── /events ──────────────────────────────────────────────────────────────
    if (cmd === "events") {
      const embed = buildEventsEmbed();
      if (!embed) {
        return interaction.reply({ content: "📭 No events received yet since bot started.", ephemeral: true });
      }
      await interaction.reply({
        embeds: [embed],
        components: [rowRefreshDismiss("events:refresh", "events:dismiss")],
      });
      return;
    }

    // ── /test ────────────────────────────────────────────────────────────────
    if (cmd === "test") {
      let chName = (interaction.options.getString("channel") || "").replace(/^#/, "");
      if (!chName) {
        const repos = await db.getAllRepositories(interaction.guildId);
        const first = repos.find(r => r.channel_id);
        if (first) {
          const ch = client.channels.cache.get(first.channel_id);
          chName = ch?.name || "github-general";
        } else {
          chName = "github-general";
        }
      }

      const ch = await getChannel(interaction.guildId, chName);
      if (!ch) {
        return interaction.reply({
          content: `❌ Channel **#${chName}** not found. Make sure it exists and I have access.`,
          ephemeral: true,
        });
      }

      const localIP = getLocalIP();
      const port = process.env.WEBHOOK_PORT || 3000;
      const baseUrl = process.env.WEBHOOK_BASE_URL || `http://${localIP}:${port}`;

      const testEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({ name: "GitBot V4", iconURL: client.user.displayAvatarURL() })
        .setTitle("🧪 Test Notification")
        .setDescription(
          "If you can see this, GitBot can post to this channel.\n\n" +
          "Use the buttons below to confirm or resend the test."
        )
        .addFields(
          { name: "Webhook URL", value: `\`${baseUrl}/webhook\``, inline: false },
          { name: "Health Check", value: `\`${baseUrl}/health\``, inline: false },
          { name: "Channel", value: `<#${ch.id}>`, inline: true },
          { name: "Tested by", value: `<@${interaction.user.id}>`, inline: true },
        )
        .setTimestamp();

      const testRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`test:ok:${ch.id}`)
          .setLabel("Looks good!")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`test:resend:${ch.id}:${chName}`)
          .setLabel("Resend")
          .setEmoji("🔁")
          .setStyle(ButtonStyle.Secondary),
      );

      const sent = await ch.send({ embeds: [testEmbed], components: [testRow] });

      await interaction.reply({
        content: `✅ Test embed sent to **#${chName}** — [jump to it](${sent.url})\nClick **Looks good!** on the embed to dismiss it.`,
        ephemeral: true,
      });
      return;
    }

    // ── /mute ────────────────────────────────────────────────────────────────
    if (cmd === "mute") {
      const eventArg = interaction.options.getString("event");
      const reason = interaction.options.getString("reason") || "";

      const existing = mutes.getMute(eventArg);
      if (existing) {
        const left = Math.ceil((existing.expiresAt.getTime() - Date.now()) / 60_000);
        const expires = `<t:${Math.floor(existing.expiresAt.getTime() / 1000)}:R>`;
        const unmuteRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`mute:unmute:${eventArg}`)
            .setLabel(`Unmute \`${eventArg}\` now`)
            .setEmoji("🔔")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId("mute:cancel")
            .setLabel("Dismiss")
            .setEmoji("🗑️")
            .setStyle(ButtonStyle.Secondary),
        );
        return interaction.reply({
          content: `🔇 **\`${eventArg}\`** is already muted for **${left}m** more (expires ${expires}).\nUnmute it now or let it expire.`,
          components: [unmuteRow],
          ephemeral: true,
        });
      }

      const muteEmbed = new EmbedBuilder()
        .setColor(0xF39C12)
        .setTitle(`🔇 Mute \`${eventArg}\``)
        .setDescription(
          `How long should **\`${eventArg}\`** be silenced?\n\n` +
          "Events will still be received and counted — just not posted to Discord." +
          (reason ? `\n\n**Reason:** ${reason}` : "")
        )
        .setFooter({ text: "Pick a duration below" });

      const safeReason = encodeURIComponent(reason.slice(0, 50));

      const durationRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mute:apply:${eventArg}:900000:${safeReason}`)
          .setLabel("15 min")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`mute:apply:${eventArg}:3600000:${safeReason}`)
          .setLabel("1 hour")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`mute:apply:${eventArg}:21600000:${safeReason}`)
          .setLabel("6 hours")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`mute:apply:${eventArg}:86400000:${safeReason}`)
          .setLabel("24 hours")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("mute:cancel")
          .setLabel("Cancel")
          .setEmoji("❌")
          .setStyle(ButtonStyle.Secondary),
      );

      await interaction.reply({ embeds: [muteEmbed], components: [durationRow], ephemeral: true });
      return;
    }

    // ── /watchlist ────────────────────────────────────────────────────────────
    if (cmd === "watchlist") {
      const activeMutes = mutes.list();

      if (activeMutes.length === 0) {
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle("✅ No Active Mutes")
            .setDescription("All event types are currently active.")
            .setTimestamp()],
          components: [rowDismiss("watchlist:dismiss")],
          ephemeral: true,
        });
      }

      const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle(`🔇 Active Mutes (${activeMutes.length})`)
        .setDescription("Click an **Unmute** button to lift a mute early.")
        .addFields(
          activeMutes.map(mu => {
            const left = Math.ceil((mu.expiresAt.getTime() - Date.now()) / 60_000);
            const expires = `<t:${Math.floor(mu.expiresAt.getTime() / 1000)}:R>`;
            return {
              name: `\`${mu.eventType}\``,
              value: `Expires ${expires} (${left}m left)\nBy <@${mu.mutedBy}>${mu.reason ? `\n> ${mu.reason}` : ""}`,
              inline: true,
            };
          })
        )
        .setTimestamp();

      const btnRows = [];
      for (const ch of chunks(activeMutes, 5).slice(0, 4)) {
        btnRows.push(new ActionRowBuilder().addComponents(
          ch.map(mu =>
            new ButtonBuilder()
              .setCustomId(`mute:unmute:${mu.eventType}`)
              .setLabel(`Unmute ${mu.eventType}`)
              .setEmoji("🔔")
              .setStyle(ButtonStyle.Danger)
          )
        ));
      }
      btnRows.push(rowDismiss("watchlist:dismiss"));

      await interaction.reply({ embeds: [embed], components: btnRows, ephemeral: true });
      return;
    }

    // ── /digest ───────────────────────────────────────────────────────────────
    if (cmd === "digest") {
      const count = interaction.options.getInteger("count") ?? 10;
      const entries = digest.recent(count);
      await interaction.reply(buildDigestPayload(entries, count));
      return;
    }

    // ── /clear-stats ──────────────────────────────────────────────────────────
    if (cmd === "clear-stats") {
      const embed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle("⚠️ Reset All Statistics?")
        .setDescription(
          "This will zero out **all** counters and reset the uptime clock.\n\n" +
          "The digest ring buffer is **not** cleared.\n\n" +
          "_This action cannot be undone._"
        )
        .setFooter({ text: "This confirmation expires in 30 seconds" });

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("clearstats:confirm")
          .setLabel("Yes, reset everything")
          .setEmoji("🗑️")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("clearstats:cancel")
          .setLabel("Never mind")
          .setEmoji("❌")
          .setStyle(ButtonStyle.Secondary),
      );

      await interaction.reply({ embeds: [embed], components: [confirmRow], ephemeral: true });

      setTimeout(async () => {
        try {
          await interaction.editReply({
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("__n3__").setLabel("Yes, reset everything").setEmoji("🗑️").setStyle(ButtonStyle.Danger).setDisabled(true),
              new ButtonBuilder().setCustomId("__n4__").setLabel("Never mind").setEmoji("❌").setStyle(ButtonStyle.Secondary).setDisabled(true),
            )],
          });
        } catch { /* gone */ }
      }, 30_000);
      return;
    }

    // ── /repo commands ──────────────────────────────────────────────────────
    if (cmd === "repo") {
      return handleRepoCommand(interaction);
    }

    // ── /admin commands ──────────────────────────────────────────────────────
    if (cmd === "admin") {
      return handleAdminCommand(interaction);
    }
  }

  // ══ Context menus ════════════════════════════════════════════════════════════
  else if (interaction.isMessageContextMenuCommand()) {
    const cmd = interaction.commandName;
    const message = interaction.targetMessage;

    // ── "📌 Pin to GitHub log" ──────────────────────────────────────────────
    if (cmd === "📌 Pin to GitHub log") {
      const logChName = "github-log";
      const logChannel = await getChannel(interaction.guildId, logChName);

      if (!logChannel) {
        return interaction.reply({
          content: `❌ Log channel **#${logChName}** not found.`,
          ephemeral: true,
        });
      }

      const pinEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({
          name: `📌 Pinned by ${interaction.user.username}`,
          iconURL: interaction.user.displayAvatarURL(),
        })
        .setDescription(message.content || "_No text content_")
        .addFields(
          { name: "Source", value: `<#${message.channelId}>`, inline: true },
          { name: "Author", value: message.author ? `<@${message.author.id}>` : "_unknown_", inline: true },
          { name: "Jump", value: `[View original](${message.url})`, inline: true },
        )
        .setTimestamp(message.createdAt);

      const toSend = message.embeds.length > 0
        ? [pinEmbed, EmbedBuilder.from(message.embeds[0])]
        : [pinEmbed];

      const ackRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`pin:ack:${interaction.user.id}`)
          .setLabel("Acknowledged")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Secondary),
      );

      await logChannel.send({ embeds: toSend, components: [ackRow] });
      await interaction.reply({ content: `📌 Pinned to **#${logChName}**!`, ephemeral: true });
      return;
    }

    // ── "🔁 Resend this embed" ───────────────────────────────────────────────
    if (cmd === "🔁 Resend this embed") {
      if (message.author?.id !== client.user.id) {
        return interaction.reply({
          content: "❌ Only GitBot's own messages can be resent.",
          ephemeral: true,
        });
      }
      if (message.embeds.length === 0) {
        return interaction.reply({ content: "❌ That message has no embeds.", ephemeral: true });
      }

      const repos = await db.getAllRepositories(interaction.guildId);
      const chNames = [...new Set(
        repos
          .map(r => client.channels.cache.get(r.channel_id)?.name)
          .filter(Boolean)
      )];

      if (chNames.length === 0) {
        return interaction.reply({ content: "❌ No monitored channels found. Add a repo with `/repo add` first.", ephemeral: true });
      }

      const pickerEmbed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle("🔁 Resend Embed — Pick a channel")
        .setDescription("Choose which channel to resend this embed to:")
        .setFooter({ text: "Shows channels for currently monitored repositories" });

      const pickerRow = new ActionRowBuilder().addComponents(
        ...chNames.slice(0, 4).map(ch =>
          new ButtonBuilder()
            .setCustomId(`resend:${message.id}:${ch}`)
            .setLabel(`#${ch}`)
            .setStyle(ButtonStyle.Primary)
        ),
        new ButtonBuilder()
          .setCustomId("resend:cancel")
          .setLabel("Cancel")
          .setEmoji("❌")
          .setStyle(ButtonStyle.Secondary),
      );

      await interaction.reply({ embeds: [pickerEmbed], components: [pickerRow], ephemeral: true });
      return;
    }
  }

  // ══ Button handlers ══════════════════════════════════════════════════════════
  else if (interaction.isButton()) {
    const id = interaction.customId;

    if (id.startsWith("repo:")) {
      if (await handleRepoInteraction(interaction)) return;
    }

    if (
      id === "dismiss" ||
      id.endsWith(":dismiss") ||
      id === "ping:dismiss" ||
      id === "mute:cancel" ||
      id === "resend:cancel" ||
      id === "clearstats:cancel"
    ) {
      try { await interaction.message.delete(); } catch { /* already gone */ }
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (id === "status:refresh") {
      await interaction.update({
        embeds: [buildStatusEmbed()],
        components: [rowRefreshedDismiss("status:dismiss")],
      });
      setTimeout(async () => {
        try {
          await interaction.editReply({
            components: [rowRefreshDismiss("status:refresh", "status:dismiss")],
          });
        } catch { /* gone */ }
      }, 1500);
      return;
    }

    if (id === "events:refresh") {
      const embed = buildEventsEmbed();
      if (!embed) {
        await interaction.update({ content: "📭 No events yet.", embeds: [], components: [] });
        return;
      }
      await interaction.update({
        embeds: [embed],
        components: [rowRefreshedDismiss("events:dismiss")],
      });
      setTimeout(async () => {
        try {
          await interaction.editReply({
            components: [rowRefreshDismiss("events:refresh", "events:dismiss")],
          });
        } catch { /* gone */ }
      }, 1500);
      return;
    }

    if (id.startsWith("test:ok:")) {
      try { await interaction.message.delete(); } catch { /* gone */ }
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (id.startsWith("test:resend:")) {
      const [, , channelId, chName] = id.split(":");
      const ch = client.channels.cache.get(channelId);
      if (!ch) {
        return interaction.reply({ content: "❌ Channel no longer found.", ephemeral: true });
      }

      const localIP = getLocalIP();
      const port = process.env.WEBHOOK_PORT || 3000;
      const baseUrl = process.env.WEBHOOK_BASE_URL || `http://${localIP}:${port}`;

      const resendEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({ name: "GitBot V4", iconURL: client.user.displayAvatarURL() })
        .setTitle("🧪 Test Notification (Resent)")
        .setDescription("Test embed resent on request.")
        .addFields(
          { name: "Webhook URL", value: `\`${baseUrl}/webhook\``, inline: false },
          { name: "Resent by", value: `<@${interaction.user.id}>`, inline: true },
        )
        .setTimestamp();

      const testRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`test:ok:${channelId}`)
          .setLabel("Looks good!")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`test:resend:${channelId}:${chName}`)
          .setLabel("Resend")
          .setEmoji("🔁")
          .setStyle(ButtonStyle.Secondary),
      );

      await ch.send({ embeds: [resendEmbed], components: [testRow] });
      await interaction.reply({ content: "🔁 Resent!", ephemeral: true });
      return;
    }

    if (id.startsWith("mute:apply:")) {
      const parts = id.split(":");
      const eventType = parts[2];
      const durationMs = parseInt(parts[3], 10);
      const reason = parts[4] ? decodeURIComponent(parts[4]) : "";

      mutes.mute(eventType, durationMs, interaction.user.id, reason);

      const mins = Math.round(durationMs / 60_000);
      const label = mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
      const expires = `<t:${Math.floor((Date.now() + durationMs) / 1000)}:R>`;

      const muteSuccessEmbed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle(`🔇 \`${eventType}\` muted for ${label}`)
        .setDescription(
          `Events of type **\`${eventType}\`** are silenced for **${label}**.\n` +
          `Mute expires ${expires}.` +
          (reason ? `\n\n**Reason:** ${reason}` : "")
        )
        .setFooter({ text: "Use /watchlist to see and manage all active mutes" })
        .setTimestamp();

      const unmuteRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mute:unmute:${eventType}`)
          .setLabel("Unmute now")
          .setEmoji("🔔")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("mute:cancel")
          .setLabel("Done")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Secondary),
      );

      await interaction.update({ embeds: [muteSuccessEmbed], components: [unmuteRow] });
      return;
    }

    if (id.startsWith("mute:unmute:")) {
      const eventType = id.slice("mute:unmute:".length);
      const removed = mutes.unmute(eventType);

      const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle(`🔔 \`${eventType}\` unmuted`)
        .setDescription(
          removed
            ? `**\`${eventType}\`** events will now be forwarded again.`
            : `**\`${eventType}\`** wasn't muted.`
        )
        .setTimestamp();

      await interaction.update({ embeds: [embed], components: [rowDismiss("mute:dismiss2")] });
      return;
    }

    if (id.startsWith("digest:more:")) {
      const current = parseInt(id.split(":")[2], 10);
      const newCount = Math.min(current + 10, 50);
      const entries = digest.recent(newCount);
      await interaction.update(buildDigestPayload(entries, newCount));
      return;
    }

    if (id === "digest:dismiss") {
      try { await interaction.message.delete(); } catch { /* gone */ }
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (id === "clearstats:confirm") {
      resetStats();
      const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle("✅ Statistics Reset")
        .setDescription(
          "All event counters and the uptime clock have been reset to zero.\n\n" +
          "The digest ring buffer was preserved."
        )
        .setTimestamp();

      await interaction.update({ embeds: [embed], components: [rowDismiss("clearstats:dismiss")] });
      return;
    }

    if (id.startsWith("pin:ack:")) {
      await interaction.update({
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("__acked__")
            .setLabel("Acknowledged")
            .setEmoji("✅")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        )],
      });
      return;
    }

    if (id.startsWith("resend:") && id !== "resend:cancel") {
      const [, msgId, chName] = id.split(":");

      const targetCh = await getChannel(interaction.guildId, chName);
      if (!targetCh) {
        return interaction.reply({ content: `❌ Channel **#${chName}** not found.`, ephemeral: true });
      }

      let originalMsg = null;
      try {
        const guild = client.guilds.cache.get(interaction.guildId);
        for (const ch of guild.channels.cache.values()) {
          if (!ch.isTextBased()) continue;
          try { originalMsg = await ch.messages.fetch(msgId); break; } catch { /* wrong channel */ }
        }
      } catch { /* ignore */ }

      if (!originalMsg || originalMsg.embeds.length === 0) {
        return interaction.reply({ content: "❌ Could not retrieve the original embed.", ephemeral: true });
      }

      const resendNote = new EmbedBuilder()
        .setColor(0x95A5A6)
        .setDescription(`🔁 Resent by <@${interaction.user.id}> from <#${originalMsg.channelId}>`)
        .setTimestamp();

      await targetCh.send({
        embeds: [...originalMsg.embeds.map(e => EmbedBuilder.from(e)), resendNote],
      });

      await interaction.update({
        content: `✅ Resent to **#${chName}**`,
        embeds: [],
        components: [],
      });
      return;
    }
  }
});

// ─── Digest payload builder ───────────────────────────────────────────────────

function buildDigestPayload(entries, currentCount) {
  const total = digest.size();

  if (entries.length === 0) {
    return {
      content: "📭 No events in the digest yet. Events appear here once GitHub starts sending webhooks.",
      embeds: [],
      components: [rowDismiss("digest:dismiss")],
    };
  }

  const lines = [...entries].reverse().map(e => {
    const ts = `<t:${Math.floor(e.timestamp.getTime() / 1000)}:R>`;
    const link = e.url ? ` — [↗](${e.url})` : "";
    const icon = e.outcome === "sent" ? "✅" : e.outcome === "muted" ? "🔇" : "⏭️";
    return `${icon} ${ts} ${e.summary}${link}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`📋 Recent Activity — last ${entries.length} event${entries.length !== 1 ? "s" : ""}`)
    .setDescription(lines.join("\n"))
    .setFooter({
      text: `${total} events in buffer  ·  ✅ sent  ·  🔇 muted  ·  ⏭️ ignored/dropped`,
    })
    .setTimestamp();

  const canLoadMore = currentCount < Math.min(total, 50);
  const row = new ActionRowBuilder().addComponents(
    ...(canLoadMore
      ? [new ButtonBuilder()
          .setCustomId(`digest:more:${currentCount}`)
          .setLabel("Load more")
          .setEmoji("⬆️")
          .setStyle(ButtonStyle.Secondary)]
      : []),
    new ButtonBuilder()
      .setCustomId("digest:dismiss")
      .setLabel("Dismiss")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

// ─── Bot ready ────────────────────────────────────────────────────────────────

client.once("ready", async () => {
  try {
    const app = await client.application.fetch();
    const ownerId = app.owner?.id || app.owner?.ownerId || null;
    if (ownerId) setBotOwnerId(ownerId);
  } catch (err) {
    console.warn("[bot] Could not fetch application owner:", err.message);
  }

  githubPoller.start();

  const localIP = getLocalIP();
  const port = process.env.WEBHOOK_PORT || 3000;
  const baseUrl = process.env.WEBHOOK_BASE_URL || `http://${localIP}:${port}`;

  console.log(`✅ GitBot V4 logged in as ${client.user.tag}`);
  console.log(`   Guilds: ${client.guilds.cache.size}`);
  console.log(`\n🔗 Webhook base URL: ${baseUrl}`);
  console.log(`   Health check:      ${baseUrl}/health\n`);

  client.user.setPresence({
    status: "online",
    activities: [{ name: "GitHub webhooks · V4", type: ActivityType.Watching }],
  });

  setInterval(rotatePresence, 30_000);
  await registerCommands();
});

// ─── Guild join handler ──────────────────────────────────────────────────────

client.on("guildCreate", async (guild) => {
  try {
    await db.ensureGuild(guild.id, guild.name, guild.ownerId);
    console.log(`[bot] Joined guild: ${guild.name} (${guild.id})`);

    // Send welcome message to system channel
    const systemChannel = guild.systemChannel;
    if (systemChannel) {
      const localIP = getLocalIP();
      const port = process.env.WEBHOOK_PORT || 3000;
      const baseUrl = process.env.WEBHOOK_BASE_URL || `http://${localIP}:${port}`;

      const welcomeEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("👋 GitBot V4 — GitHub Notifications")
        .setDescription(
          "Thanks for adding GitBot! I'll send GitHub events (pushes, PRs, issues, releases) to your Discord channels.\n\n" +
          "**Quick start:**\n" +
          "1. Use `/repo add owner/repo` to add a GitHub repository\n" +
          "2. I'll create a channel and give you a webhook URL\n" +
          "3. Add that URL to your GitHub repo's Webhooks settings\n\n" +
          "**Commands:**\n" +
          "• `/repo add/remove/list/info/enable` — Manage repositories\n" +
          "• `/admin add/remove/list` — Manage bot admins\n" +
          "• `/mute` — Silence specific event types\n" +
          "• `/status` — View bot statistics"
        )
        .addFields(
          { name: "🔗 Webhook URL", value: `\`${baseUrl}/webhook\``, inline: false },
          { name: "📖 Help", value: "Use `/help` for detailed guides", inline: false },
        )
        .setTimestamp();

      await systemChannel.send({ embeds: [welcomeEmbed] });
    }
  } catch (err) {
    console.error(`[bot] Error handling guildCreate: ${err.message}`);
  }
});

client.on("guildDelete", (guild) => {
  console.log(`[bot] Left guild: ${guild.name} (${guild.id})`);
});

// ─── Utility ──────────────────────────────────────────────────────────────────

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Webhook server (Multi-repo) ─────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1);
const webhookRouter = createWebhookRouter(client);
app.use(webhookRouter);

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.WEBHOOK_PORT || "3000", 10);

app.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log(`🌐 Webhook server on port ${PORT}`);
  console.log(`📡 Local IP: ${localIP}`);
  client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error("❌ Discord login failed:", err.message);
    process.exit(1);
  });
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function shutdown(signal) {
  console.log(`\n👋 ${signal} — shutting down…`);
  client.destroy();
  process.exit(0);
}
