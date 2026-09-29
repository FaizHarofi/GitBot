// tokenCommands.js — /token add, /token list, /token remove
// Stores GitHub PATs used by the poller for repos running in polling mode.

"use strict";

const https = require("https");

const {
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");

const db = require("../db/database");
const { isUserAdmin } = require("./repoCommands");
const { logError } = require("../errors");

// ─── Command definition ───────────────────────────────────────────────────────

const tokenCommands = [
  new SlashCommandBuilder()
    .setName("token")
    .setDescription("Manage GitHub personal access tokens (used for polling mode)")
    .addSubcommand(sub =>
      sub.setName("add")
        .setDescription("Add a GitHub PAT — validated against the GitHub API first")
        .addStringOption(o =>
          o.setName("pat")
            .setDescription("Your GitHub Personal Access Token")
            .setRequired(true)
        )
        .addStringOption(o =>
          o.setName("description")
            .setDescription("Label for this token (e.g. 'bot account')")
            .setRequired(false)
        )
        .addBooleanOption(o =>
          o.setName("default")
            .setDescription("Use as the default token for this server (first token is always default)")
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName("list")
        .setDescription("List saved tokens (token values are never shown)")
    )
    .addSubcommand(sub =>
      sub.setName("remove")
        .setDescription("Delete a saved token")
        .addIntegerOption(o =>
          o.setName("id")
            .setDescription("Token ID from /token list")
            .setRequired(true)
        )
    ),
];

// ─── GitHub PAT validation ────────────────────────────────────────────────────

/**
 * Verify a PAT against GitHub's /user endpoint.
 * @returns {Promise<string>} the token owner's login
 */
function validateToken(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.github.com",
      path: "/user",
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "GitBot-Discord/4.0",
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data).login); } catch { resolve(null); }
        } else if (res.statusCode === 401) {
          reject(new Error("Token tidak valid — GitHub menolaknya (401). Periksa kembali PAT-nya."));
        } else if (res.statusCode === 403) {
          reject(new Error("GitHub menolak permintaan (403) — kemungkinan rate limit."));
        } else {
          reject(new Error(`GitHub API error ${res.statusCode}`));
        }
      });
    });
    req.on("error", err => reject(new Error(`Tidak bisa menghubungi GitHub: ${err.message}`)));
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Timeout saat memvalidasi token ke GitHub"));
    });
    req.end();
  });
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleTokenCommand(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (!await isUserAdmin(interaction)) {
    return interaction.reply({
      content: "❌ You need admin permissions to manage tokens.",
      ephemeral: true,
    });
  }

  switch (subcommand) {
    case "add":
      return handleTokenAdd(interaction);
    case "list":
      return handleTokenList(interaction);
    case "remove":
      return handleTokenRemove(interaction);
    default:
      return interaction.reply({ content: "Unknown subcommand", ephemeral: true });
  }
}

async function handleTokenAdd(interaction) {
  const pat = interaction.options.getString("pat").trim();
  const description = interaction.options.getString("description") || "GitHub PAT";
  const wantDefault = interaction.options.getBoolean("default");
  const guildId = interaction.guildId;

  await interaction.deferReply({ ephemeral: true });

  try {
    const login = await validateToken(pat);

    const existing = await db.getAllTokens(guildId);
    const isFirst = existing.length === 0;
    const isDefault = wantDefault === null ? isFirst : (wantDefault || isFirst);

    const token = await db.addToken(
      guildId,
      pat,
      interaction.user.id,
      login ? `${description} (@${login})` : description,
      isDefault
    );

    const embed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle("✅ GitHub Token Saved")
      .setDescription(`Validated as **@${login || "unknown"}** on GitHub.`)
      .addFields(
        { name: "ID", value: String(token.id), inline: true },
        { name: "Default", value: isDefault ? "✅ Yes" : "No", inline: true },
        { name: "Added by", value: `<@${interaction.user.id}>`, inline: true },
        { name: "Description", value: description, inline: false },
      )
      .setFooter({ text: "Token values are stored securely and never displayed." })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    console.log(`[token] Added token #${token.id} for guild ${guildId} (${login})`);
  } catch (err) {
    logError("token.add", err, { guild: guildId, user: interaction.user.id });
    await interaction.editReply({ content: `❌ ${err.message}` });
  }
}

async function handleTokenList(interaction) {
  try {
    const tokens = await db.getAllTokens(interaction.guildId);

    if (tokens.length === 0) {
      return interaction.reply({
        content: "📭 No tokens saved yet. Add one with `/token add` (required for polling mode).",
        ephemeral: true,
      });
    }

    const lines = tokens.map(t => {
      const rate = t.rate_limit_remaining != null
        ? ` · ${t.rate_limit_remaining} req left`
        : "";
      const reset = t.rate_limit_reset
        ? ` · resets <t:${Math.floor(t.rate_limit_reset / 1000)}:R>`
        : "";
      const created = `<t:${Math.floor(new Date(t.created_at).getTime() / 1000)}:R>`;
      return `**#${t.id}** ${t.is_default ? "⭐ " : ""}${t.description || "_no description_"}${rate}${reset} · added ${created}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle(`🔑 GitHub Tokens (${tokens.length})`)
      .setDescription(lines.join("\n"))
      .setFooter({ text: "⭐ = default token for polling · values never shown" });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (err) {
    logError("token.list", err, { guild: interaction.guildId });
    await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
  }
}

async function handleTokenRemove(interaction) {
  const id = interaction.options.getInteger("id");
  const guildId = interaction.guildId;

  await interaction.deferReply({ ephemeral: true });

  try {
    const removed = await db.removeToken(id, guildId);
    if (!removed) {
      return interaction.editReply({ content: `❌ Token **#${id}** not found on this server.` });
    }
    await interaction.editReply({ content: `🗑️ Token **#${id}** deleted.` });
    console.log(`[token] Removed token #${id} from guild ${guildId}`);
  } catch (err) {
    logError("token.remove", err, { guild: guildId, tokenId: id });
    await interaction.editReply({ content: `❌ ${err.message}` });
  }
}

module.exports = { tokenCommands, handleTokenCommand, validateToken };
