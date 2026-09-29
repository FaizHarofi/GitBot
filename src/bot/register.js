// register.js — pushes command definitions to Discord's global registry

"use strict";

const { REST, Routes } = require("discord.js");

const client = require("./client");
const { allCommands } = require("./commands");
const { DiscordError, logError } = require("../errors");

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
    logError("register", new DiscordError(err.message, { cause: err }), {
      commands: allCommands.length,
    });
  }
}

module.exports = { registerCommands };
