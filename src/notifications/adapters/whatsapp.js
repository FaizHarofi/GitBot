// adapters/whatsapp.js — WhatsApp notification adapter
//
// GitBot V5 WhatsApp integration uses Baileys (baileys/useMultiFileAuthState)
// for a single persistent WhatsApp Web session shared across all destinations.
//
// DEPLOYMENT NOTE:
//   The WhatsApp session requires persistent file storage.
//   On Railway/Render, mount a persistent volume at the path configured in
//   WHATSAPP_SESSION_PATH (default: ./wa_session).
//   On Render free tier, the session will be lost on every deploy — use
//   a paid plan or external volume.
//
// FIRST-TIME SETUP:
//   The bot will print a QR code to the console on first start.
//   Scan it with WhatsApp → Linked Devices → Link a Device.
//   After scanning, the session is saved to disk and reused on future starts.
//
// ENV VARS:
//   WHATSAPP_ENABLED=true     — set to 'true' to enable WhatsApp (default: false)
//   WHATSAPP_SESSION_PATH=./wa_session  — path for session storage
//
// IMPORTANT:
//   WhatsApp group identifier (JID) looks like:  120363XXXXXXXXXX@g.us
//   Add destinations via the dashboard: /dashboard/destinations

"use strict";

// ─── Lazy-load Baileys so the app starts even if WhatsApp is disabled ────────

let _waClient = null;
let _waStatus = "disabled";  // disabled | initializing | qr_required | connected | error

const ENABLED = process.env.WHATSAPP_ENABLED === "true";
const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || "./wa_session";

/**
 * Initialize the WhatsApp client.
 * Call this once at startup if WHATSAPP_ENABLED=true.
 */
async function initialize() {
  if (!ENABLED) {
    console.log("[whatsapp] WhatsApp disabled (WHATSAPP_ENABLED != true)");
    return;
  }

  _waStatus = "initializing";
  console.log("[whatsapp] Initializing WhatsApp client…");

  try {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import("@whiskeysockets/baileys");
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: {
        level: "silent",
        trace: () => {}, debug: () => {}, info: () => {},
        warn: (msg) => console.warn("[wa]", msg),
        error: (msg) => console.error("[wa]", msg),
        fatal: (msg) => console.error("[wa]", msg),
        child: () => ({
          level: "silent",
          trace: () => {}, debug: () => {}, info: () => {},
          warn: () => {}, error: () => {}, fatal: () => {},
          child: function() { return this; },
        }),
      },
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        _waStatus = "qr_required";
        console.log("[whatsapp] QR code printed to terminal — scan with WhatsApp mobile app.");
        console.log("[whatsapp] Go to WhatsApp → ... → Linked Devices → Link a Device.");
      }
      if (connection === "open") {
        _waStatus = "connected";
        _waClient = sock;
        console.log("[whatsapp] ✅ WhatsApp connected");
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log(`[whatsapp] Connection closed (code ${code}). Reconnect: ${shouldReconnect}`);
        if (shouldReconnect) {
          _waStatus = "initializing";
          _waClient = null;
          setTimeout(initialize, 10000); // retry after 10s
        } else {
          _waStatus = "error";
          _waClient = null;
          console.error("[whatsapp] Logged out — delete the session directory and restart.");
        }
      }
    });

  } catch (err) {
    _waStatus = "error";
    console.error("[whatsapp] Failed to initialize:", err.message);
    console.error("[whatsapp] Install Baileys: npm install @whiskeysockets/baileys");
  }
}

/**
 * Get current WhatsApp connection status.
 */
function getStatus() {
  if (!ENABLED) return "disabled";
  return _waStatus;
}

/**
 * Format a NormalizedNotification as a WhatsApp text message.
 */
function formatMessage(notification) {
  const lines = [];
  const icon = _eventIcon(notification.eventType);

  lines.push(`${icon} *${notification.repositoryFullName}*`);
  lines.push(`*${notification.title}*`);

  if (notification.description) {
    lines.push("");
    lines.push(notification.description.slice(0, 500));
  }

  if (notification.actor) {
    lines.push("");
    lines.push(`👤 ${notification.actor}`);
  }

  if (notification.url) {
    lines.push(`🔗 ${notification.url}`);
  }

  return lines.join("\n");
}

function _eventIcon(eventType) {
  const icons = {
    push: "📦", pull_request: "🔀", issues: "🐛", issue_comment: "💬",
    pull_request_review: "🔍", release: "🚀", star: "⭐", fork: "🍴",
    create: "🌿", delete: "🗑️", workflow_run: "✅", check_run: "🔎",
    deployment_status: "🚢",
  };
  return icons[eventType] || "📡";
}

/**
 * Send a notification to a WhatsApp group.
 * @param {object} notification  — NormalizedNotification
 * @param {string} groupJid      — WhatsApp group JID (e.g. 120363XXXX@g.us)
 */
async function send(notification, groupJid) {
  if (!ENABLED) {
    throw new Error("WhatsApp is disabled (WHATSAPP_ENABLED != true)");
  }

  if (_waStatus !== "connected" || !_waClient) {
    throw new Error(`WhatsApp not connected (status: ${_waStatus})`);
  }

  if (!groupJid || !groupJid.endsWith("@g.us")) {
    throw new Error(`Invalid WhatsApp group JID: ${groupJid}`);
  }

  const message = formatMessage(notification);
  await _waClient.sendMessage(groupJid, { text: message });
}

/**
 * List joined WhatsApp groups (if connected).
 * Returns array of { id, subject } or empty array.
 */
async function listGroups() {
  if (!ENABLED || _waStatus !== "connected" || !_waClient) {
    return [];
  }
  try {
    const groups = await _waClient.groupFetchAllParticipating();
    return Object.values(groups).map(g => ({ id: g.id, subject: g.subject }));
  } catch (err) {
    console.error("[whatsapp] Failed to list groups:", err.message);
    return [];
  }
}

module.exports = { initialize, getStatus, send, listGroups, formatMessage };
