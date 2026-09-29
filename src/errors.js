// errors.js — centralized error types and handling
// Every module reports failures through here so logs stay consistent and
// error semantics (status codes, retryability) live in one place.

"use strict";

// ─── Error types ──────────────────────────────────────────────────────────────

class AppError extends Error {
  constructor(message, { code = "APP_ERROR", status = 500, cause = null, meta = {} } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.meta = meta;
    if (cause) this.cause = cause;
  }
}

class DatabaseError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: "DB_ERROR", status: 500, ...opts });
  }
}

class ConfigError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: "CONFIG_ERROR", status: 500, ...opts });
  }
}

class DiscordError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: "DISCORD_ERROR", status: 502, ...opts });
  }
}

class WebhookError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: "WEBHOOK_ERROR", status: 400, ...opts });
  }
}

class InvalidSignatureError extends WebhookError {
  constructor(message = "Invalid signature", opts = {}) {
    super(message, { code: "INVALID_SIGNATURE", status: 401, ...opts });
  }
}

class RepositoryNotFoundError extends WebhookError {
  constructor(message = "Repository not found", opts = {}) {
    super(message, { code: "REPO_NOT_FOUND", status: 404, ...opts });
  }
}

class InactiveRepositoryError extends WebhookError {
  constructor(message = "Repository inactive", opts = {}) {
    super(message, { code: "REPO_INACTIVE", status: 410, ...opts });
  }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

/**
 * Structured single-line error log. Replaces ad-hoc console.error calls so
 * every failure carries the same shape: scope, code, message, metadata.
 */
function logError(scope, err, meta = {}) {
  const code = err?.code || err?.name || "Error";
  const status = err?.status ? ` status=${err.status}` : "";
  const extras = Object.entries({ ...err?.meta, ...meta })
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  const cause = err?.cause ? ` cause="${err.cause.message}"` : "";
  console.error(`[error] scope=${scope} code=${code}${status} msg="${err?.message || err}"${cause}${extras ? ` ${extras}` : ""}`);
}

/**
 * Wrap an async handler so unexpected failures are logged centrally and
 * re-thrown (callers decide whether to surface them to the user).
 */
function wrap(scope, fn, meta = {}) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      logError(scope, err, meta);
      throw err;
    }
  };
}

module.exports = {
  AppError,
  DatabaseError,
  ConfigError,
  DiscordError,
  WebhookError,
  InvalidSignatureError,
  RepositoryNotFoundError,
  InactiveRepositoryError,
  logError,
  wrap,
};
