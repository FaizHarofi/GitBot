// components.js — reusable Discord button/row factories and small helpers

"use strict";

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

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

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = {
  btnDismiss,
  rowDismiss,
  rowRefreshDismiss,
  rowRefreshedDismiss,
  chunks,
};
