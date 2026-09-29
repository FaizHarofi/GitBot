// presence.js — rotating bot status/activity

"use strict";

const { ActivityType } = require("discord.js");

const client = require("./client");
const { stats } = require("../stats");

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

module.exports = { rotatePresence };
