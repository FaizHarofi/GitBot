// stats.js — shared webhook event counters
// Single source of truth used by the webhook server, poller, /status and /events.

"use strict";

const stats = {
  eventsReceived: 0,
  eventsSent: 0,
  eventsDropped: 0,
  eventsIgnored: 0,
  eventsMuted: 0,
  startTime: Date.now(),
  lastEvent: null,
  lastEventTime: null,
  eventCounts: {},
};

function recordEvent(eventType, outcome) {
  stats.eventsReceived++;
  stats.lastEvent = eventType;
  stats.lastEventTime = new Date();
  stats.eventCounts[eventType] = (stats.eventCounts[eventType] || 0) + 1;
  if (outcome === "sent") stats.eventsSent++;
  else if (outcome === "dropped") stats.eventsDropped++;
  else if (outcome === "muted") stats.eventsMuted++;
  else stats.eventsIgnored++;
}

function resetStats() {
  stats.eventsReceived = 0;
  stats.eventsSent = 0;
  stats.eventsDropped = 0;
  stats.eventsIgnored = 0;
  stats.eventsMuted = 0;
  stats.startTime = Date.now();
  stats.lastEvent = null;
  stats.lastEventTime = null;
  stats.eventCounts = {};
}

module.exports = { stats, recordEvent, resetStats };
