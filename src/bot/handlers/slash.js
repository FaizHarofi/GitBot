// handlers/slash.js — slash command bodies (ping, status, events, test, mute…)

"use strict";

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const client = require("../client");
const db = require("../../db/database");
const mutes = require("../mutes");
const digest = require("../digest");
const {
  buildStatusEmbed,
  buildEventsEmbed,
  buildDigestPayload,
} = require("../embeds");
const { rowDismiss, rowRefreshDismiss, chunks } = require("../components");
const { getChannel } = require("../channels");
const { getBaseUrl } = require("../../config");
const { handleRepoCommand, handleAdminCommand } = require("../repoCommands");
const { handleTokenCommand } = require("../tokenCommands");

async function handleSlash(interaction) {
  const cmd = interaction.commandName;

  // ── /ping ──────────────────────────────────────────────────────────────────
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

  // ── /status ────────────────────────────────────────────────────────────────
  if (cmd === "status") {
    await interaction.reply({
      embeds: [buildStatusEmbed()],
      components: [rowRefreshDismiss("status:refresh", "status:dismiss")],
    });
    return;
  }

  // ── /events ────────────────────────────────────────────────────────────────
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

  // ── /test ──────────────────────────────────────────────────────────────────
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

    const baseUrl = getBaseUrl();

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

  // ── /mute ──────────────────────────────────────────────────────────────────
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

  // ── /watchlist ─────────────────────────────────────────────────────────────
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

  // ── /digest ────────────────────────────────────────────────────────────────
  if (cmd === "digest") {
    const count = interaction.options.getInteger("count") ?? 10;
    const entries = digest.recent(count);
    await interaction.reply(buildDigestPayload(entries, count));
    return;
  }

  // ── /clear-stats ───────────────────────────────────────────────────────────
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

  // ── /repo commands ─────────────────────────────────────────────────────────
  if (cmd === "repo") {
    return handleRepoCommand(interaction);
  }

  // ── /admin commands ────────────────────────────────────────────────────────
  if (cmd === "admin") {
    return handleAdminCommand(interaction);
  }

  // ── /token commands ────────────────────────────────────────────────────────
  if (cmd === "token") {
    return handleTokenCommand(interaction);
  }
}

module.exports = { handleSlash };
