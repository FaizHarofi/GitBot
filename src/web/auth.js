// auth.js — simple session-based dashboard authentication
// Uses a single shared secret (DASHBOARD_SECRET) since this is a self-hosted
// single-operator tool. For multi-user auth, extend this to use proper OAuth.

"use strict";

const crypto = require("crypto");

const SESSION_COOKIE = "gitbot_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// In-memory session store (acceptable for single-instance self-hosted deployments)
const _sessions = new Map();

function generateSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Create a new authenticated session.
 * Returns the session ID to set as a cookie.
 */
function createSession() {
  const id = generateSessionId();
  _sessions.set(id, { createdAt: Date.now() });
  // Cleanup old sessions periodically
  _pruneExpired();
  return id;
}

/**
 * Destroy a session (logout).
 */
function destroySession(id) {
  _sessions.delete(id);
}

/**
 * Check if a session ID is valid and not expired.
 */
function isValidSession(id) {
  if (!id) return false;
  const session = _sessions.get(id);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
    _sessions.delete(id);
    return false;
  }
  return true;
}

function _pruneExpired() {
  const now = Date.now();
  for (const [id, session] of _sessions) {
    if (now - session.createdAt > SESSION_MAX_AGE) _sessions.delete(id);
  }
}

// ─── Middleware ────────────────────────────────────────────────────────────

/**
 * Express middleware: require authenticated session.
 * Redirects to /dashboard/login for browser requests.
 * Returns 401 JSON for API requests.
 */
function requireAuth(req, res, next) {
  const sessionId = req.cookies?.[SESSION_COOKIE];
  if (isValidSession(sessionId)) {
    return next();
  }

  // Detect API vs browser request
  if (req.path.startsWith("/api/") || req.headers.accept?.includes("application/json")) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  return res.redirect("/dashboard/login?next=" + encodeURIComponent(req.originalUrl));
}

/**
 * Express middleware: parse session cookie (non-blocking).
 */
function sessionMiddleware(req, _res, next) {
  req.isAuthenticated = false;
  const sessionId = req.cookies?.[SESSION_COOKIE];
  if (isValidSession(sessionId)) {
    req.isAuthenticated = true;
    req.sessionId = sessionId;
  }
  next();
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  createSession,
  destroySession,
  isValidSession,
  requireAuth,
  sessionMiddleware,
};
