// dashboard.js — Express router for the web dashboard
// Serves the login page, handles auth, and serves the SPA shell.

"use strict";

const express = require("express");
const path = require("path");
const cookie = require("cookie");

const {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  createSession,
  destroySession,
  requireAuth,
  sessionMiddleware,
} = require("./auth");

const router = express.Router();
const PUBLIC_DIR = path.join(__dirname, "public", "dashboard");

// Parse cookies (lightweight — no external cookie-parser dependency needed for dashboard)
router.use((req, res, next) => {
  req.cookies = req.cookies || cookie.parse(req.headers.cookie || "");
  next();
});
router.use(sessionMiddleware);

// ─── Login ────────────────────────────────────────────────────────────────────

router.get("/login", (req, res) => {
  if (req.isAuthenticated) return res.redirect("/dashboard");
  const next = req.query.next || "/dashboard";
  res.send(loginPage(next, null));
});

router.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  const { password, next = "/dashboard" } = req.body;
  const secret = process.env.DASHBOARD_SECRET;

  if (!secret) {
    return res.send(loginPage(next, "DASHBOARD_SECRET is not set in environment variables."));
  }

  if (!password || password !== secret) {
    return res.send(loginPage(next, "Incorrect password."));
  }

  const sessionId = createSession();
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE / 1000}; Path=/`);
  res.redirect(next);
});

router.post("/logout", (req, res) => {
  const sessionId = req.cookies?.[SESSION_COOKIE];
  if (sessionId) destroySession(sessionId);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/`);
  res.redirect("/dashboard/login");
});

// ─── Dashboard SPA ────────────────────────────────────────────────────────────

// Static assets (CSS, JS)
router.use("/", requireAuth, express.static(PUBLIC_DIR, { index: false }));

// SPA shell (all other GET routes → serve the shell HTML)
router.get("*", requireAuth, (_req, res) => {
  res.send(dashboardShell());
});

// ─── HTML generators ──────────────────────────────────────────────────────────

function loginPage(next, error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GitBot — Login</title>
  <link rel="stylesheet" href="/dashboard/style.css">
</head>
<body>
  <div class="login-wrap">
    <div class="login-box">
      <h1>GitBot V5</h1>
      <p>Enter your dashboard password to continue.</p>
      ${error ? `<div class="alert alert-error">${escapeHtml(error)}</div>` : ""}
      <form method="POST" action="/dashboard/login">
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        <div class="form-group">
          <label class="form-label">Password</label>
          <input class="form-input" type="password" name="password" autofocus autocomplete="current-password" required>
        </div>
        <button class="btn btn-primary" style="width:100%">Sign in</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function dashboardShell() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GitBot V5 — Dashboard</title>
  <link rel="stylesheet" href="/dashboard/style.css">
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-logo">
        <h1>GitBot V5</h1>
        <span>GitHub Notification Platform</span>
      </div>
      <nav>
        <div class="nav-section">Monitor</div>
        <a href="#overview" data-page="overview">
          <span class="nav-icon">📊</span> Overview
        </a>
        <a href="#activity" data-page="activity">
          <span class="nav-icon">📋</span> Activity Log
        </a>
        <div class="nav-section">Manage</div>
        <a href="#repositories" data-page="repositories">
          <span class="nav-icon">📁</span> Repositories
        </a>
        <a href="#events" data-page="events" style="display:none">
          <span class="nav-icon">⚡</span> Event Config
        </a>
        <a href="#destinations" data-page="destinations">
          <span class="nav-icon">📡</span> Destinations
        </a>
        <div class="nav-section">System</div>
        <a href="#settings" data-page="settings">
          <span class="nav-icon">⚙️</span> Settings
        </a>
      </nav>
    </aside>
    <main class="main" id="main-content">
      <div class="loading"><div class="spinner"></div> Loading…</div>
    </main>
  </div>
  <script src="/dashboard/app.js"></script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = router;
