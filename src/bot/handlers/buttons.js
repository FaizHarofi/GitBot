// handlers/buttons.js — button interaction bodies

"use strict";

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const client = require("../client");
const mutes = require("../mutes");
const digest = require("../digest");
const { resetStats } = require("../../stats");
const {
  buildStatusEmbed,
  buildEventsEmbed,
  buildDigestPayload,
} = require("../embeds");
const {
  rowDismiss,
  rowRefreshDismiss,
  rowRefreshedDismiss,
} = require("../components");
const { getChannel } = require("../channels");
const { getBaseUrl } = require("../../config");
const { handleRepoInteraction } = require("../repoCommands");

async function handleButton(interaction) {
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

    const baseUrl = getBaseUrl();

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

module.exports = { handleButton };
