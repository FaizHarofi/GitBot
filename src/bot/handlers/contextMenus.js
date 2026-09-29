// handlers/contextMenus.js — message context menu commands

"use strict";

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const client = require("../client");
const db = require("../../db/database");
const { getChannel } = require("../channels");

async function handleContextMenu(interaction) {
  const cmd = interaction.commandName;
  const message = interaction.targetMessage;

  // ── "📌 Pin to GitHub log" ─────────────────────────────────────────────────
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

  // ── "🔁 Resend this embed" ─────────────────────────────────────────────────
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

module.exports = { handleContextMenu };
