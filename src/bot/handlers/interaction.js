// handlers/interaction.js — routes interactions to the right handler
// This is the single choke point for interaction errors: anything thrown by a
// command/button/menu is logged through errors.logError and surfaced to the user.

"use strict";

const { handleHelpInteraction } = require("../help");
const { handleSlash } = require("./slash");
const { handleContextMenu } = require("./contextMenus");
const { handleButton } = require("./buttons");
const { logError } = require("../../errors");

async function handleInteraction(interaction) {
  try {
    if (await handleHelpInteraction(interaction)) return;

    if (interaction.isChatInputCommand()) {
      return await handleSlash(interaction);
    }

    if (interaction.isMessageContextMenuCommand()) {
      return await handleContextMenu(interaction);
    }

    if (interaction.isButton()) {
      return await handleButton(interaction);
    }
  } catch (err) {
    const label = interaction.commandName || interaction.customId || interaction.type;
    logError("interaction", err, { command: label, user: interaction.user?.id, guild: interaction.guildId });

    const reply = {
      content: "❌ Something went wrong while handling that interaction. The error has been logged.",
      ephemeral: true,
    };
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
      else await interaction.reply(reply);
    } catch { /* interaction already expired — nothing left to do */ }
  }
}

module.exports = { handleInteraction };
