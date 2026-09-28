// repoCommands.js — Repository management slash commands (multi-tenant)
// Handles /repo add, /repo remove, /repo list, /repo info, /admin commands

"use strict";

const os = require("os");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const db = require("./database");

// ─── In-memory pending setup tracker ─────────────────────────────────────────
/** @type {Map<number, {adminUserId: string, targetUserId: string|null, dmMessageId: string|null}>} */
const _pendingSetup = new Map();

// ─── Local IP helper ─────────────────────────────────────────────────────────

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

function getBaseUrl() {
  const localIP = getLocalIP();
  const port = process.env.PORT || process.env.WEBHOOK_PORT || 3000;
  return (process.env.WEBHOOK_BASE_URL || `http://${localIP}:${port}`).replace(/\/$/, "");
}

// ─── Command Definitions ────────────────────────────────────────────────────────

const repoCommands = [
  new SlashCommandBuilder()
    .setName("repo")
    .setDescription("Manage GitHub repositories")
    .addSubcommand(sub =>
      sub.setName("add")
        .setDescription("Add a GitHub repository to monitor")
        .addStringOption(o =>
          o.setName("repository")
            .setDescription("Repository in format 'owner/repo'")
            .setRequired(true)
        )
        .addStringOption(o =>
          o.setName("channel")
            .setDescription("Discord channel for notifications (default: auto-create)")
            .setRequired(false)
        )
        .addBooleanOption(o =>
          o.setName("polling")
            .setDescription("Use GitHub API polling instead of webhooks")
            .setRequired(false)
        )
        .addUserOption(o =>
          o.setName("user")
            .setDescription("Discord user who owns this repo — they'll receive setup instructions via DM")
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName("remove")
        .setDescription("Remove a repository from monitoring")
        .addStringOption(o =>
          o.setName("repository")
            .setDescription("Repository in format 'owner/repo' or ID")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName("list")
        .setDescription("List all monitored repositories")
        .addBooleanOption(o =>
          o.setName("detailed")
            .setDescription("Show detailed information")
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName("info")
        .setDescription("Show detailed info about a repository")
        .addStringOption(o =>
          o.setName("repository")
            .setDescription("Repository in format 'owner/repo' or ID")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName("enable")
        .setDescription("Enable or disable a repository")
        .addStringOption(o =>
          o.setName("repository")
            .setDescription("Repository in format 'owner/repo' or ID")
            .setRequired(true)
        )
        .addBooleanOption(o =>
          o.setName("enable")
            .setDescription("Enable (true) or disable (false)")
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Bot administration")
    .addSubcommand(sub =>
      sub.setName("add")
        .setDescription("Add an admin user")
        .addUserOption(o =>
          o.setName("user")
            .setDescription("User to make admin")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName("remove")
        .setDescription("Remove an admin user")
        .addUserOption(o =>
          o.setName("user")
            .setDescription("User to remove from admins")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName("list")
        .setDescription("List all admins")
    ),
];

// ─── Helper Functions ─────────────────────────────────────────────────────────

function parseRepoString(repoStr) {
  const match = repoStr.trim().match(/^([^\/]+)\/([^\/]+)$/);
  if (!match) {
    throw new Error("Invalid format. Use 'owner/repo' (e.g., 'facebook/react')");
  }
  return { owner: match[1], name: match[2] };
}

async function getRepo(guildId, identifier) {
  const idOrName = String(identifier);
  if (/^\d+$/.test(idOrName)) {
    return db.getRepositoryById(parseInt(idOrName, 10));
  }
  return db.getRepositoryByFullName(guildId, idOrName);
}

// ─── Command Handlers ───────────────────────────────────────────────────────

async function handleRepoCommand(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (!await isUserAdmin(interaction)) {
    return interaction.reply({
      content: "❌ You need admin permissions to manage repositories.",
      ephemeral: true,
    });
  }

  switch (subcommand) {
    case "add":
      return handleRepoAdd(interaction);
    case "remove":
      return handleRepoRemove(interaction);
    case "list":
      return handleRepoList(interaction);
    case "info":
      return handleRepoInfo(interaction);
    case "enable":
      return handleRepoEnable(interaction);
    default:
      return interaction.reply({ content: "Unknown subcommand", ephemeral: true });
  }
}

async function handleRepoAdd(interaction) {
  const repoStr = interaction.options.getString("repository");
  const channelName = interaction.options.getString("channel");
  const usePolling = interaction.options.getBoolean("polling");
  const targetUser = interaction.options.getUser("user");
  const guildId = interaction.guildId;

  await interaction.deferReply();

  try {
    const { owner, name } = parseRepoString(repoStr);
    const fullName = `${owner}/${name}`;

    const existing = await db.getRepositoryByFullName(guildId, fullName);
    if (existing && existing.is_active) {
      return interaction.editReply({
        content: `❌ Repository **${fullName}** is already registered.`,
      });
    }

    // Resolve or create the notification channel
    let channelId = null;
    let channelDisplayName = null;

    const resolveOrCreate = async (desiredName) => {
      let ch = interaction.guild.channels.cache.find(
        c => c.name === desiredName && c.isTextBased()
      );
      if (!ch) {
        ch = await interaction.guild.channels.create({
          name: desiredName,
          type: 0,
          topic: `GitHub updates for ${fullName}`,
        });
        console.log(`[repo] Created channel #${desiredName} for ${fullName}`);
      }
      return ch;
    };

    try {
      const desiredName = channelName
        ? channelName.replace(/^#/, "").toLowerCase().replace(/\s+/g, "-")
        : `github-${owner.toLowerCase()}-${name.toLowerCase()}`.replace(/[^a-z0-9-]/g, "-").slice(0, 100);

      const ch = await resolveOrCreate(desiredName);
      channelId = ch.id;
      channelDisplayName = ch.name;
    } catch (err) {
      return interaction.editReply({ content: `❌ Failed to create channel: ${err.message}` });
    }

    // Generate secret and register repo
    const crypto = require("crypto");
    const webhookSecret = crypto.randomBytes(32).toString("hex");

    const repo = await db.addRepository(guildId, owner, name, channelId, interaction.user.id, {
      webhookSecret,
      pollEnabled: usePolling || false,
    });

    _pendingSetup.set(repo.id, {
      adminUserId: interaction.user.id,
      targetUserId: targetUser?.id || null,
      dmMessageId: null,
    });

    // Build webhook URL
    const baseUrl = getBaseUrl();
    const webhookUrl = `${baseUrl}/webhook/${repo.id}`;

    // Admin reply
    const adminEmbed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle("✅ Repository Added")
      .setDescription(`Now monitoring **[${fullName}](https://github.com/${fullName})**`)
      .addFields(
        { name: "ID", value: String(repo.id), inline: true },
        { name: "Channel", value: `<#${channelId}>`, inline: true },
        { name: "Method", value: usePolling ? "📡 Polling" : "🔗 Webhook", inline: true },
        { name: "Added by", value: `<@${interaction.user.id}>`, inline: true },
        ...(targetUser ? [{ name: "Repo owner", value: `<@${targetUser.id}>`, inline: true }] : []),
      )
      .addFields(
        { name: "🔗 Payload URL", value: `\`${webhookUrl}\``, inline: false },
        { name: "🔑 Webhook Secret", value: `\`${webhookSecret}\``, inline: false },
      )
      .setFooter({ text: targetUser ? `Setup instructions sent to ${targetUser.username} via DM` : "No user specified — share the details above manually" })
      .setTimestamp();

    await interaction.editReply({ embeds: [adminEmbed] });

    // DM the target user
    if (targetUser) {
      const dmEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("🔗 GitHub Webhook Setup")
        .setDescription(
          `You've been added as the owner of **[${fullName}](https://github.com/${fullName})** on the Discord bot.\n\n` +
          "Follow the steps below to connect your GitHub repository, then click **I've added the webhook** when done."
        )
        .addFields(
          {
            name: "1️⃣ Open GitHub",
            value: `Go to **[${fullName} → Settings → Webhooks → Add webhook](https://github.com/${fullName}/settings/hooks/new)**`,
            inline: false,
          },
          {
            name: "2️⃣ Payload URL",
            value: `\`${webhookUrl}\``,
            inline: false,
          },
          {
            name: "3️⃣ Content type",
            value: "`application/json`",
            inline: true,
          },
          {
            name: "4️⃣ Secret",
            value: `\`${webhookSecret}\``,
            inline: false,
          },
          {
            name: "5️⃣ Events",
            value: "Choose **Let me select individual events** and pick what you need (Issues, PRs, Pushes, Releases…)",
            inline: false,
          },
          {
            name: "6️⃣ Save",
            value: "Click **Add webhook**. GitHub will send a ping — then click the button below.",
            inline: false,
          },
          {
            name: "📢 Notifications channel",
            value: `Events will be posted in <#${channelId}> on the server.`,
            inline: false,
          },
        )
        .setTimestamp();

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`repo:webhook_confirm:${repo.id}`)
          .setLabel("I've added the webhook")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success),
      );

      try {
        const dmChannel = await targetUser.createDM();
        const dmMsg = await dmChannel.send({ embeds: [dmEmbed], components: [confirmRow] });
        const pending = _pendingSetup.get(repo.id);
        if (pending) pending.dmMessageId = dmMsg.id;
        console.log(`[repo] DM sent to ${targetUser.username} for ${fullName}`);
      } catch (err) {
        console.warn(`[repo] Could not DM ${targetUser.username}: ${err.message}`);
        await interaction.followUp({
          content: `⚠️ Couldn't DM <@${targetUser.id}> (they may have DMs disabled). Share the webhook details from the message above manually.`,
          ephemeral: true,
        });
      }
    }

  } catch (err) {
    console.error("[repo] Add error:", err);
    return interaction.editReply({ content: `❌ Error: ${err.message}` });
  }
}

async function handleRepoRemove(interaction) {
  const identifier = interaction.options.getString("repository");

    try {
      const repo = await getRepo(interaction.guildId, identifier);
      if (!repo) {
        return interaction.reply({
          content: "❌ Repository not found.",
          ephemeral: true,
        });
      }

      await db.deleteRepository(repo.id, interaction.guildId);

    const embed = new EmbedBuilder()
      .setColor(0xE74C3C)
      .setTitle("✅ Repository Removed")
      .setDescription(`**${repo.full_name}** has been permanently deleted. You can add it again.`)
      .addFields(
        { name: "ID", value: String(repo.id), inline: true },
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });

  } catch (err) {
    console.error("[repo] Remove error:", err);
    return interaction.reply({
      content: `❌ Error: ${err.message}`,
      ephemeral: true,
    });
  }
}

async function handleRepoList(interaction) {
  const detailed = interaction.options.getBoolean("detailed");
  const repos = await db.getAllRepositories(interaction.guildId);

  if (repos.length === 0) {
    return interaction.reply({
      content: "📭 No repositories are currently being monitored.",
      ephemeral: true,
    });
  }

  if (detailed) {
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📋 Monitored Repositories (${repos.length})`)
      .setDescription("Detailed view of all registered repositories");

    for (const repo of repos) {
      const status = repo.error_message
        ? `⚠️ ${repo.error_message}`
        : (repo.poll_enabled ? "📡 Polling" : "🔗 Webhook");

      embed.addFields({
        name: `${repo.full_name}`,
        value: [
          `ID: \`${repo.id}\``,
          `Channel: <#${repo.channel_id}>`,
          `Status: ${status}`,
          `Added: <t:${Math.floor(new Date(repo.created_at).getTime() / 1000)}:R>`,
        ].join("\n"),
        inline: false,
      });
    }

    return interaction.reply({ embeds: [embed] });
  }

  const list = repos.map(r => `\`${r.id}\` **${r.full_name}** → <#${r.channel_id}>`).join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`📋 Monitored Repositories (${repos.length})`)
    .setDescription(list)
    .setFooter({ text: "Use /repo list detailed for more info" })
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

async function handleRepoInfo(interaction) {
  const identifier = interaction.options.getString("repository");

  try {
    const repo = await getRepo(interaction.guildId, identifier);
    if (!repo) {
      return interaction.reply({
        content: "❌ Repository not found.",
        ephemeral: true,
      });
    }

    const embed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle(`📊 ${repo.full_name}`)
      .addFields(
        { name: "ID", value: String(repo.id), inline: true },
        { name: "Owner", value: repo.owner, inline: true },
        { name: "Name", value: repo.name, inline: true },
        { name: "Channel", value: repo.channel_id ? `<#${repo.channel_id}>` : "_None_", inline: true },
        { name: "Method", value: repo.poll_enabled ? "📡 Polling" : "🔗 Webhook", inline: true },
        { name: "Status", value: repo.is_active ? "✅ Active" : "❌ Inactive", inline: true },
        { name: "Last Polled", value: repo.last_polled_at ? `<t:${Math.floor(repo.last_polled_at / 1000)}:R>` : "_Never_", inline: true },
        { name: "Created", value: `<t:${Math.floor(new Date(repo.created_at).getTime() / 1000)}:R>`, inline: true },
        { name: "Created By", value: repo.created_by ? `<@${repo.created_by}>` : "_Unknown_", inline: true },
      );

    if (repo.error_message) {
      embed.addFields({
        name: "⚠️ Error",
        value: repo.error_message,
      });
    }

    if (repo.poll_enabled && repo.last_commit_sha) {
      embed.addFields({
        name: "Last Commit",
        value: `\`${repo.last_commit_sha.slice(0, 7)}\``,
      });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`repo:toggle:${repo.id}`)
        .setLabel(repo.is_active ? "Disable" : "Enable")
        .setStyle(repo.is_active ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`repo:delete:${repo.id}`)
        .setLabel("Delete")
        .setStyle(ButtonStyle.Danger),
    );

    return interaction.reply({ embeds: [embed], components: [row] });

  } catch (err) {
    console.error("[repo] Info error:", err);
    return interaction.reply({
      content: `❌ Error: ${err.message}`,
      ephemeral: true,
    });
  }
}

async function handleRepoEnable(interaction) {
  const identifier = interaction.options.getString("repository");
  const enable = interaction.options.getBoolean("enable");

  try {
    const repo = await getRepo(interaction.guildId, identifier);
    if (!repo) {
      return interaction.reply({
        content: "❌ Repository not found.",
        ephemeral: true,
      });
    }

    await db.updateRepository(repo.id, { is_active: enable });

    return interaction.reply({
      content: `✅ Repository **${repo.full_name}** has been ${enable ? "enabled" : "disabled"}.`,
    });

  } catch (err) {
    console.error("[repo] Enable error:", err);
    return interaction.reply({
      content: `❌ Error: ${err.message}`,
      ephemeral: true,
    });
  }
}

// ─── Admin Commands ────────────────────────────────────────────────────────

async function handleAdminCommand(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (!await isUserAdmin(interaction)) {
    return interaction.reply({
      content: "❌ You need admin permissions to manage admins.",
      ephemeral: true,
    });
  }

  switch (subcommand) {
    case "add":
      return handleAdminAdd(interaction);
    case "remove":
      return handleAdminRemove(interaction);
    case "list":
      return handleAdminList(interaction);
    default:
      return interaction.reply({ content: "Unknown subcommand", ephemeral: true });
  }
}

async function handleAdminAdd(interaction) {
  const user = interaction.options.getUser("user");

  try {
    await db.addAdmin(interaction.guildId, user.id, user.username, interaction.user.id);

    const embed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle("✅ Admin Added")
      .setDescription(`${user.username} (${user.id}) is now an admin.`)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });

  } catch (err) {
    console.error("[admin] Add error:", err);
    return interaction.reply({
      content: `❌ Error: ${err.message}`,
      ephemeral: true,
    });
  }
}

async function handleAdminRemove(interaction) {
  const user = interaction.options.getUser("user");

  try {
    await db.removeAdmin(interaction.guildId, user.id);

    const embed = new EmbedBuilder()
      .setColor(0xE74C3C)
      .setTitle("✅ Admin Removed")
      .setDescription(`${user.username} is no longer an admin.`)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });

  } catch (err) {
    console.error("[admin] Remove error:", err);
    return interaction.reply({
      content: `❌ Error: ${err.message}`,
      ephemeral: true,
    });
  }
}

async function handleAdminList(interaction) {
  const admins = await db.getAllAdmins(interaction.guildId);

  if (admins.length === 0) {
    return interaction.reply({
      content: "📭 No admins configured.",
      ephemeral: true,
    });
  }

  const list = admins.map(a => `• **${a.username}** (\`${a.discord_user_id}\`) — added <t:${Math.floor(new Date(a.added_at).getTime() / 1000)}:R>`).join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`👮 Admins (${admins.length})`)
    .setDescription(list)
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

// ─── Interaction Handlers (Buttons) ────────────────────────────────────────

async function handleRepoInteraction(interaction) {
  const parts = interaction.customId.split(":");
  const type = parts[0];
  const action = parts[1];
  const id = parts[2];

  if (type !== "repo") return false;

  // Webhook confirmed by user
  if (action === "webhook_confirm") {
    const repoId = parseInt(id, 10);
    const repo = await db.getRepositoryById(repoId);

    if (!repo) {
      await interaction.reply({ content: "❌ Repository not found.", ephemeral: true });
      return true;
    }

    const pending = _pendingSetup.get(repoId);

    try {
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle("✅ Webhook Connected!")
            .setDescription(
              `Your GitHub webhook for **${repo.full_name}** has been confirmed.\n\n` +
              `Events will now appear in <#${repo.channel_id}> on the server.`
            )
            .setTimestamp(),
        ],
        components: [],
      });
    } catch (err) {
      console.warn("[repo] Could not update DM confirmation:", err.message);
    }

    try {
      const repoChannel = await interaction.client.channels.fetch(repo.channel_id);
      if (repoChannel) {
        const channelEmbed = new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle("🔗 Webhook Connected")
          .setDescription(`**${repo.full_name}** is now connected and ready to receive GitHub events.`)
          .addFields(
            { name: "Confirmed by", value: `<@${interaction.user.id}>`, inline: true },
            { name: "Repository", value: `[${repo.full_name}](https://github.com/${repo.full_name})`, inline: true },
          )
          .setTimestamp();

        await repoChannel.send({ embeds: [channelEmbed] });
      }
    } catch (err) {
      console.error("[repo] Could not post to repo channel:", err.message);
    }

    if (pending?.adminUserId) {
      try {
        const adminUser = await interaction.client.users.fetch(pending.adminUserId);
        const adminDM = await adminUser.createDM();
        const adminEmbed = new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle("✅ Webhook Confirmed")
          .setDescription(
            `<@${interaction.user.id}> (**${interaction.user.username}**) has added the GitHub webhook for **${repo.full_name}**.`
          )
          .addFields(
            { name: "Repository", value: `[${repo.full_name}](https://github.com/${repo.full_name})`, inline: true },
            { name: "Channel", value: `<#${repo.channel_id}>`, inline: true },
          )
          .setTimestamp();

        await adminDM.send({ embeds: [adminEmbed] });
      } catch (err) {
        console.warn("[repo] Could not notify admin:", err.message);
      }
    }

    if (pending?.dmMessageId) {
      try {
        setTimeout(async () => {
          try {
            await interaction.message.delete();
          } catch { /* already gone */ }
        }, 4000);
      } catch (err) {
        console.warn("[repo] Could not delete DM message:", err.message);
      }
    }

    _pendingSetup.delete(repoId);
    console.log(`[repo] Webhook confirmed for ${repo.full_name} by ${interaction.user.username}`);
    return true;
  }

  // Toggle active state
  if (action === "toggle") {
    const repo = await db.getRepositoryById(parseInt(id, 10));
    if (!repo) {
      await interaction.reply({ content: "Repository not found", ephemeral: true });
      return true;
    }

    const newState = !repo.is_active;
    await db.updateRepository(repo.id, { is_active: newState });

    await interaction.update({
      content: `✅ Repository ${repo.full_name} has been ${newState ? "enabled" : "disabled"}.`,
      components: [],
    });
    return true;
  }

  // Hard delete
  if (action === "delete") {
    const repo = await db.getRepositoryById(parseInt(id, 10));
    if (!repo) {
      await interaction.reply({ content: "Repository not found", ephemeral: true });
      return true;
    }

    _pendingSetup.delete(repo.id);
    await db.deleteRepository(repo.id);

    await interaction.update({
      content: `🗑️ Repository **${repo.full_name}** has been permanently deleted.`,
      components: [],
    });
    return true;
  }

  return false;
}

// ─── Admin Check ───────────────────────────────────────────────────────────

let BOT_OWNER_ID = null;

function setBotOwnerId(ownerId) {
  BOT_OWNER_ID = ownerId;
}

async function isUserAdmin(interaction) {
  const userId = interaction.user.id;

  // Bot owner is always admin
  if (BOT_OWNER_ID && userId === BOT_OWNER_ID) {
    return true;
  }

  // Database admin check (per guild)
  try {
    if (await db.isAdmin(interaction.guildId, userId)) {
      return true;
    }
  } catch (err) {
    console.error("[admin] DB check error:", err.message);
  }

  // Check Discord permissions
  if (interaction.member && interaction.member.permissions) {
    if (interaction.member.permissions.has("Administrator")) {
      return true;
    }
  }

  return false;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  repoCommands,
  handleRepoCommand,
  handleAdminCommand,
  handleRepoInteraction,
  isUserAdmin,
  setBotOwnerId,
};
