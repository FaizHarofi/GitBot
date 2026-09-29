// GitBot V5 Dashboard — frontend JS
// Vanilla JS, no build step, no dependencies.

"use strict";

// ─── API helpers ──────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch("/api" + path, opts);
  if (res.status === 401) { window.location.href = "/dashboard/login"; return null; }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

const GET    = (path)       => api("GET",    path);
const POST   = (path, body) => api("POST",   path, body);
const PUT    = (path, body) => api("PUT",    path, body);
const PATCH  = (path, body) => api("PATCH",  path, body);
const DELETE = (path)       => api("DELETE", path);

// ─── Utilities ────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function html(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === "string") e.appendChild(document.createTextNode(child));
    else if (child) e.appendChild(child);
  }
  return e;
}

function relativeTime(dateStr) {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function statusBadge(status) {
  const map = {
    connected: "badge-green", online: "badge-green", sent: "badge-green",
    processed: "badge-green", active: "badge-green",
    disconnected: "badge-red", error: "badge-red", failed: "badge-red",
    qr_required: "badge-yellow", initializing: "badge-yellow", ignored: "badge-yellow",
    disabled: "badge-gray", skipped: "badge-gray",
  };
  const cls = map[status] || "badge-gray";
  const e = document.createElement("span");
  e.className = `badge ${cls}`;
  e.textContent = status;
  return e;
}

function showAlert(container, type, message) {
  const alert = document.createElement("div");
  alert.className = `alert alert-${type}`;
  alert.textContent = message;
  container.prepend(alert);
  setTimeout(() => alert.remove(), 4000);
}

// ─── Page routing (SPA-lite) ──────────────────────────────────────────────────

const pages = {};
let currentPage = null;

function register(name, fn) { pages[name] = fn; }

function navigate(name, params = {}) {
  const main = el("main-content");
  if (!main) return;
  main.innerHTML = '<div class="loading"><div class="spinner"></div> Loading…</div>';

  currentPage = name;
  setActiveNav(name);

  const fn = pages[name];
  if (!fn) {
    main.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><h3>Page not found</h3></div>`;
    return;
  }
  fn(main, params).catch(err => {
    main.innerHTML = `<div class="alert alert-error">Failed to load: ${err.message}</div>`;
  });
}

function setActiveNav(name) {
  document.querySelectorAll("nav a[data-page]").forEach(a => {
    a.classList.toggle("active", a.dataset.page === name);
  });
}

// ─── Pages ────────────────────────────────────────────────────────────────────

// ── Overview ──────────────────────────────────────────────────────────────────
register("overview", async (main) => {
  const [stats, activity] = await Promise.all([
    GET("/stats"),
    GET("/activity?limit=10"),
  ]);
  if (!stats) return;

  main.innerHTML = `
    <div class="page-header">
      <div><h2>Overview</h2><p>GitBot V5 live status</p></div>
    </div>

    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">Repositories</div>
        <div class="stat-value" id="s-repos">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Events Processed</div>
        <div class="stat-value" id="s-processed">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Events Ignored</div>
        <div class="stat-value" id="s-ignored">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Events Failed</div>
        <div class="stat-value" id="s-failed">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Destinations</div>
        <div class="stat-value" id="s-dest">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Uptime</div>
        <div class="stat-value" id="s-uptime">—</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
      <div class="card" id="discord-card"></div>
      <div class="card" id="whatsapp-card"></div>
    </div>

    <div class="card">
      <div class="card-title">Recent Activity</div>
      <div id="activity-list"></div>
    </div>
  `;

  el("s-repos").textContent = stats.repositories;
  el("s-processed").textContent = stats.events.processed;
  el("s-ignored").textContent = stats.events.ignored;
  el("s-failed").textContent = stats.events.failed;
  el("s-dest").textContent = stats.destinations;
  el("s-uptime").textContent = formatUptime(stats.uptime);

  // Discord card
  const dc = el("discord-card");
  dc.innerHTML = `<div class="card-title">Discord</div>`;
  dc.appendChild(statusBadge(stats.discord.status));
  if (stats.discord.tag) dc.insertAdjacentHTML("beforeend", `<p style="margin-top:10px;font-size:13px"><strong>${stats.discord.tag}</strong></p>`);
  if (stats.discord.guilds) dc.insertAdjacentHTML("beforeend", `<p style="font-size:12px;color:var(--text-muted)">${stats.discord.guilds} server(s) · ${stats.discord.ping}ms WS ping</p>`);

  // WhatsApp card
  const wc = el("whatsapp-card");
  wc.innerHTML = `<div class="card-title">WhatsApp</div>`;
  wc.appendChild(statusBadge(stats.whatsapp.status));
  if (stats.whatsapp.status === "disabled") {
    wc.insertAdjacentHTML("beforeend", `<p style="font-size:12px;color:var(--text-muted);margin-top:8px">Set WHATSAPP_ENABLED=true to enable</p>`);
  } else if (stats.whatsapp.status === "qr_required") {
    wc.insertAdjacentHTML("beforeend", `<p style="font-size:12px;color:var(--yellow);margin-top:8px">Scan the QR code in server logs</p>`);
  }

  // Activity
  const al = el("activity-list");
  if (!activity || activity.length === 0) {
    al.innerHTML = `<div class="empty" style="padding:24px"><p>No events yet. Connect a GitHub repository to get started.</p></div>`;
  } else {
    const table = buildActivityTable(activity);
    al.appendChild(table);
  }
});

function formatUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function buildActivityTable(logs) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.innerHTML = `
    <table>
      <thead><tr>
        <th>Status</th><th>Event</th><th>Repository</th><th>Action</th><th>Time</th>
      </tr></thead>
      <tbody id="activity-tbody"></tbody>
    </table>`;
  const tbody = wrap.querySelector("tbody");
  for (const log of logs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td></td>
      <td><code>${log.event_type}</code></td>
      <td>${log.repositories?.full_name || "—"}</td>
      <td>${log.action || "—"}</td>
      <td style="color:var(--text-muted)">${relativeTime(log.created_at)}</td>`;
    tr.cells[0].appendChild(statusBadge(log.status));
    tbody.appendChild(tr);
  }
  return wrap;
}

// ── Repositories ──────────────────────────────────────────────────────────────
register("repositories", async (main) => {
  const repos = await GET("/repositories");
  if (!repos) return;

  main.innerHTML = `
    <div class="page-header">
      <div><h2>Repositories</h2><p>${repos.length} repository monitored</p></div>
    </div>
    <div class="card">
      <div id="repo-list"></div>
    </div>`;

  const list = el("repo-list");

  if (repos.length === 0) {
    list.innerHTML = `<div class="empty">
      <div class="empty-icon">📁</div>
      <h3>No repositories yet</h3>
      <p>Use <code>/repo add owner/repo</code> in Discord to add a repository</p>
    </div>`;
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.innerHTML = `
    <table>
      <thead><tr>
        <th>Repository</th><th>Guild</th><th>Webhook</th><th>Status</th><th>Added</th><th>Actions</th>
      </tr></thead>
      <tbody id="repos-tbody"></tbody>
    </table>`;

  const tbody = wrap.querySelector("tbody");
  for (const repo of repos) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong><a href="https://github.com/${repo.full_name}" target="_blank">${repo.full_name}</a></strong></td>
      <td><code>${repo.guild_id}</code></td>
      <td>${repo.has_webhook_secret ? '<span class="badge badge-green">secured</span>' : '<span class="badge badge-yellow">no secret</span>'}</td>
      <td></td>
      <td style="color:var(--text-muted)">${relativeTime(repo.created_at)}</td>
      <td>
        <button class="btn btn-sm btn-secondary" data-action="events" data-id="${repo.id}">Events</button>
        <button class="btn btn-sm btn-danger" data-action="toggle" data-id="${repo.id}" data-active="${repo.is_active}">${repo.is_active ? "Disable" : "Enable"}</button>
      </td>`;
    tr.cells[3].appendChild(statusBadge(repo.is_active ? "active" : "disabled"));
    tbody.appendChild(tr);
  }
  list.appendChild(wrap);

  // Events
  list.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === "events") navigate("events", { repoId: id });
    if (action === "toggle") {
      const isActive = btn.dataset.active === "true";
      await PATCH(`/repositories/${id}`, { is_active: !isActive });
      navigate("repositories");
    }
  });
});

// ── Event Configuration ────────────────────────────────────────────────────────
register("events", async (main, { repoId } = {}) => {
  if (!repoId) {
    main.innerHTML = `<div class="alert alert-error">No repository selected</div>`;
    return;
  }

  const [repo, config] = await Promise.all([
    GET(`/repositories/${repoId}`),
    GET(`/repositories/${repoId}/events`),
  ]);
  if (!repo || !config) return;

  main.innerHTML = `
    <div class="page-header">
      <div>
        <h2>Event Configuration</h2>
        <p>${repo.full_name}</p>
      </div>
      <button class="btn btn-secondary" id="back-btn">← Repositories</button>
    </div>
    <div class="alert alert-info">
      Disabled events are received from GitHub but not forwarded to any destination.
      They are logged as "ignored".
    </div>
    <div class="card">
      <div class="card-title">Events</div>
      <div class="event-grid" id="event-grid"></div>
      <div style="margin-top:16px">
        <button class="btn btn-primary" id="save-events">Save Changes</button>
      </div>
    </div>`;

  el("back-btn").addEventListener("click", () => navigate("repositories"));

  const grid = el("event-grid");
  const state = { ...config.events };

  for (const [evt, enabled] of Object.entries(state)) {
    const row = document.createElement("div");
    row.className = "event-row";
    row.innerHTML = `
      <span class="event-name">${evt}</span>
      <label class="toggle">
        <input type="checkbox" ${enabled ? "checked" : ""} data-event="${evt}">
        <div class="toggle-track"><div class="toggle-thumb"></div></div>
      </label>`;
    row.querySelector("input").addEventListener("change", (e) => {
      state[e.target.dataset.event] = e.target.checked;
    });
    grid.appendChild(row);
  }

  el("save-events").addEventListener("click", async () => {
    try {
      await PUT(`/repositories/${repoId}/events`, state);
      showAlert(main, "success", "Event configuration saved.");
    } catch (err) {
      showAlert(main, "error", err.message);
    }
  });
});

// ── Activity Log ──────────────────────────────────────────────────────────────
register("activity", async (main) => {
  const logs = await GET("/activity?limit=50");
  if (!logs) return;

  main.innerHTML = `
    <div class="page-header">
      <div><h2>Activity Log</h2><p>Last 50 GitHub events</p></div>
    </div>
    <div class="card">
      <div id="activity-content"></div>
    </div>`;

  const content = el("activity-content");

  if (logs.length === 0) {
    content.innerHTML = `<div class="empty">
      <div class="empty-icon">📋</div>
      <h3>No events yet</h3>
      <p>Events will appear here once GitHub starts sending webhooks.</p>
    </div>`;
    return;
  }

  content.appendChild(buildActivityTable(logs));
});

// ── Destinations ──────────────────────────────────────────────────────────────
register("destinations", async (main) => {
  const guilds = await GET("/guilds");
  if (!guilds || guilds.length === 0) {
    main.innerHTML = `<div class="alert alert-error">No Discord servers found. Add the bot to a server first.</div>`;
    return;
  }

  // Use first guild for now
  const guildId = guilds[0].id;
  const [destinations, waStatus] = await Promise.all([
    GET(`/destinations?guild_id=${guildId}`),
    GET("/whatsapp/status"),
  ]);
  if (!destinations) return;

  main.innerHTML = `
    <div class="page-header">
      <div><h2>Destinations</h2><p>Notification targets beyond the default Discord channel</p></div>
      <button class="btn btn-primary" id="add-dest-btn">+ Add Destination</button>
    </div>

    <div class="card">
      <div class="card-title">WhatsApp Status</div>
      <div id="wa-status-area"></div>
    </div>

    <div class="card">
      <div class="card-title">Configured Destinations</div>
      <div id="dest-list"></div>
    </div>

    <div class="card" id="add-dest-form" style="display:none">
      <div class="card-title">Add Destination</div>
      <div class="form-group">
        <label class="form-label">Type</label>
        <select id="dest-type" class="form-input form-select">
          <option value="discord">Discord (additional channel)</option>
          <option value="whatsapp">WhatsApp Group</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Display Name</label>
        <input id="dest-name" class="form-input" placeholder="e.g. Development Team">
      </div>
      <div class="form-group">
        <label class="form-label" id="dest-id-label">Identifier</label>
        <input id="dest-identifier" class="form-input" placeholder="Discord channel ID or WhatsApp group JID">
        <p style="font-size:11px;color:var(--text-muted);margin-top:4px" id="dest-id-hint">
          Discord: right-click channel → Copy Channel ID. WhatsApp: use the group JID (e.g. 120363XXXX@g.us)
        </p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="save-dest">Save Destination</button>
        <button class="btn btn-secondary" id="cancel-dest">Cancel</button>
      </div>
    </div>`;

  // WhatsApp status
  const waArea = el("wa-status-area");
  const badge = statusBadge(waStatus?.status || "disabled");
  waArea.appendChild(badge);
  if (waStatus?.status === "qr_required") {
    waArea.insertAdjacentHTML("beforeend", `<p style="margin-top:8px;font-size:13px;color:var(--yellow)">Scan the QR code in your server terminal/logs.</p>`);
  } else if (waStatus?.status === "disabled") {
    waArea.insertAdjacentHTML("beforeend", `<p style="margin-top:8px;font-size:13px;color:var(--text-muted)">Set <code>WHATSAPP_ENABLED=true</code> in your .env to enable WhatsApp.</p>`);
  } else if (waStatus?.status === "connected") {
    const groups = await GET("/whatsapp/groups").catch(() => []);
    if (groups && groups.length > 0) {
      waArea.insertAdjacentHTML("beforeend", `<p style="margin-top:8px;font-size:13px;color:var(--text-muted)">${groups.length} group(s) available. Use the JID as destination identifier.</p>`);
      const ul = document.createElement("ul");
      ul.style.cssText = "margin-top:10px;list-style:none;display:flex;flex-direction:column;gap:6px";
      for (const g of groups) {
        ul.insertAdjacentHTML("beforeend", `<li style="font-size:13px"><code>${g.id}</code> — ${g.subject}</li>`);
      }
      waArea.appendChild(ul);
    }
  }

  // Destination list
  renderDestList(el("dest-list"), destinations, guildId);

  // Add form toggle
  el("add-dest-btn").addEventListener("click", () => {
    el("add-dest-form").style.display = "block";
    el("add-dest-btn").style.display = "none";
  });
  el("cancel-dest").addEventListener("click", () => {
    el("add-dest-form").style.display = "none";
    el("add-dest-btn").style.display = "";
  });
  el("save-dest").addEventListener("click", async () => {
    const type = el("dest-type").value;
    const name = el("dest-name").value.trim();
    const identifier = el("dest-identifier").value.trim();
    if (!name || !identifier) return showAlert(main, "error", "All fields are required.");
    try {
      await POST("/destinations", { guild_id: guildId, type, name, identifier });
      navigate("destinations");
    } catch (err) { showAlert(main, "error", err.message); }
  });
});

function renderDestList(container, destinations, _guildId) {
  if (destinations.length === 0) {
    container.innerHTML = `<div class="empty" style="padding:24px">
      <p>No additional destinations configured. The default Discord channel from each repository is always used.</p>
    </div>`;
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Identifier</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody></tbody>
    </table>`;
  const tbody = wrap.querySelector("tbody");
  for (const dest of destinations) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${dest.name}</strong></td>
      <td><span class="badge badge-gray">${dest.type}</span></td>
      <td><code class="mono">${dest.identifier}</code></td>
      <td></td>
      <td>
        <button class="btn btn-sm btn-danger" data-del="${dest.id}">Delete</button>
      </td>`;
    tr.cells[3].appendChild(statusBadge(dest.active ? "active" : "disabled"));
    tr.querySelector("[data-del]").addEventListener("click", async () => {
      if (!confirm(`Delete destination "${dest.name}"?`)) return;
      await DELETE(`/destinations/${dest.id}`);
      navigate("destinations");
    });
    tbody.appendChild(tr);
  }
  container.appendChild(wrap);
}

// ── Settings / Info ───────────────────────────────────────────────────────────
register("settings", async (main) => {
  const stats = await GET("/stats");
  if (!stats) return;

  main.innerHTML = `
    <div class="page-header">
      <div><h2>Settings</h2></div>
      <form method="POST" action="/dashboard/logout">
        <button class="btn btn-secondary">Logout</button>
      </form>
    </div>
    <div class="card">
      <div class="card-title">Instance Info</div>
      <table style="width:auto">
        <tr><td style="padding-right:24px;color:var(--text-muted)">Version</td><td>GitBot V5</td></tr>
        <tr><td style="padding-right:24px;color:var(--text-muted)">Uptime</td><td>${formatUptime(stats.uptime)}</td></tr>
        <tr><td style="padding-right:24px;color:var(--text-muted)">Discord</td><td>${stats.discord.tag || "Not connected"}</td></tr>
        <tr><td style="padding-right:24px;color:var(--text-muted)">WhatsApp</td><td>${stats.whatsapp.status}</td></tr>
        <tr><td style="padding-right:24px;color:var(--text-muted)">Repositories</td><td>${stats.repositories}</td></tr>
      </table>
    </div>
    <div class="card">
      <div class="card-title">Environment Variables</div>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Required variables for this instance:</p>
      <div class="code-block">DISCORD_TOKEN        — Discord bot token
SUPABASE_URL         — Supabase project URL
SUPABASE_KEY         — Supabase service role key
WEBHOOK_BASE_URL     — Public URL of this server
DASHBOARD_SECRET     — Password for this dashboard

# Optional
WHATSAPP_ENABLED     — true to enable WhatsApp (default: false)
WHATSAPP_SESSION_PATH — Path for WhatsApp session (default: ./wa_session)
WEBHOOK_RATE_LIMIT   — Max webhook req/min per IP (default: 30)
HEALTH_RATE_LIMIT    — Max health req/min per IP (default: 60)</div>
    </div>`;
});

// ─── App init ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Nav clicks
  document.querySelectorAll("nav a[data-page]").forEach(a => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(a.dataset.page);
    });
  });

  // Initial page from hash or default
  const hash = location.hash.replace("#", "") || "overview";
  navigate(hash);

  // Update hash on navigate
  const origNavigate = navigate;
  window.navigate = function(name, params) {
    location.hash = name;
    origNavigate(name, params);
  };
  document.querySelectorAll("nav a[data-page]").forEach(a => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      window.navigate(a.dataset.page);
    });
  });
});
