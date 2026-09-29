// commands.js — slash command and context menu definitions (data only)

"use strict";

const {
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
} = require("discord.js");

const { repoCommands } = require("./repoCommands");
const { tokenCommands } = require("./tokenCommands");
const { helpCommand } = require("./help");

// ─── Shared choices ───────────────────────────────────────────────────────────

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

// ─── Slash commands ───────────────────────────────────────────────────────────

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

// ─── Context menus ────────────────────────────────────────────────────────────

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

// ─── Everything registered with Discord ───────────────────────────────────────

const allCommands = [
  ...slashCommands,
  ...repoCommands.map(c => c.toJSON()),
  ...tokenCommands.map(c => c.toJSON()),
  helpCommand,
  ...contextMenus,
];

module.exports = { EVENT_CHOICES, slashCommands, contextMenus, allCommands };
