// poller.js — GitHub API polling system for repositories without webhooks
// Handles rate limiting, error handling, and event detection (multi-tenant)

"use strict";

const https = require("https");
const http = require("http");

// ─── Rate Limiting ────────────────────────────────────────────────────────────

const rateLimits = new Map();

function isRateLimited(tokenId) {
  const limit = rateLimits.get(tokenId);
  if (!limit) return false;
  return Date.now() < limit.resetTime;
}

function getRemainingRequests(tokenId) {
  const limit = rateLimits.get(tokenId);
  return limit ? limit.remaining : 5000;
}

function updateRateLimit(tokenId, headers) {
  const remaining = parseInt(headers["x-ratelimit-remaining"] || "5000", 10);
  const reset = parseInt(headers["x-ratelimit-reset"] || "0", 10) * 1000;

  rateLimits.set(String(tokenId), { remaining, resetTime: reset });

  if (remaining < 100) {
    console.warn(`[poller] Rate limit low for token ${tokenId}: ${remaining} remaining, resets at ${new Date(reset).toISOString()}`);
  }

  return { remaining, resetTime: reset };
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

function githubRequest(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    const baseUrl = process.env.GITHUB_API_URL || "api.github.com";
    const parsedUrl = new URL(`https://${baseUrl}/repos${path}`);
    const isHttps = parsedUrl.protocol === "https:";
    const protocol = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "GitBot-Discord/4.0",
      },
    };

    if (body) {
      options.headers["Content-Type"] = "application/json";
    }

    const req = protocol.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        const tokenId = String(token);
        updateRateLimit(tokenId, res.headers);

        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch {
            resolve(data);
          }
        } else if (res.statusCode === 404) {
          reject({ status: 404, message: "Repository not found or is private" });
        } else if (res.statusCode === 403) {
          reject({ status: 403, message: "Forbidden - possibly rate limited" });
        } else if (res.statusCode === 401) {
          reject({ status: 401, message: "Unauthorized - check your token" });
        } else {
          reject({ status: res.statusCode, message: data || "Unknown error" });
        }
      });
    });

    req.on("error", reject);

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Polling Functions ────────────────────────────────────────────────────────

async function getLatestCommit(owner, name, token) {
  try {
    const data = await githubRequest("GET", `/${owner}/${name}/commits?per_page=1`, token);
    if (data && data.length > 0) {
      return data[0].sha;
    }
    return null;
  } catch (err) {
    throw err;
  }
}

async function getCommitsSince(owner, name, token, sinceSha) {
  try {
    const data = await githubRequest("GET", `/${owner}/${name}/commits?per_page=30`, token);
    if (!data || data.length === 0) return [];

    const commits = [];
    let found = false;

    for (const commit of data) {
      if (commit.sha === sinceSha) {
        found = true;
        break;
      }
      commits.push(commit);
    }

    if (!found && data.length > 0) {
      return data.slice(0, 5);
    }

    return commits;
  } catch (err) {
    throw err;
  }
}

async function getRecentReleases(owner, name, token, beforeTag = null) {
  try {
    const data = await githubRequest("GET", `/${owner}/${name}/releases?per_page=5`, token);
    if (!data || data.length === 0) return [];
    if (!beforeTag) return data;
    return data.filter(r => r.tag_name !== beforeTag);
  } catch (err) {
    throw err;
  }
}

async function getRecentPullRequests(owner, name, token) {
  try {
    const data = await githubRequest("GET", `/${owner}/${name}/pulls?state=all&per_page=10`, token);
    return data || [];
  } catch (err) {
    throw err;
  }
}

async function getRepoInfo(owner, name, token) {
  try {
    return await githubRequest("GET", `/${owner}/${name}`, token);
  } catch (err) {
    throw err;
  }
}

// ─── Poller Class ────────────────────────────────────────────────────────────

class GitHubPoller {
  constructor(options = {}) {
    this.interval = options.interval || 60000;
    this.onEvent = options.onEvent || (() => {});
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._poll();
    this.timer = setInterval(() => this._poll(), this.interval);
    console.log(`[poller] Started polling every ${this.interval / 1000}s`);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[poller] Stopped polling");
  }

  setInterval(ms) {
    this.interval = ms;
    if (this.running) {
      this.stop();
      this.start();
    }
  }

  /**
   * Poll all enabled repositories across all guilds
   */
  async _poll() {
    const db = require("../db/database");

    try {
      const repos = await db.getAllPollableRepositories();

      if (repos.length === 0) {
        return;
      }

      for (const repo of repos) {
        await this._pollRepo(repo);
      }
    } catch (err) {
      console.error("[poller] Polling error:", err.message);
    }
  }

  /**
   * Poll a single repository
   */
  async _pollRepo(repo) {
    const db = require("../db/database");

    // Get token for this repo
    let token = null;
    if (repo.github_token_id) {
      const tokenObj = await db.getTokenById(repo.github_token_id);
      token = tokenObj?.token;
    }

    // Fall back to guild default token
    if (!token && repo.guild_id) {
      const defaultToken = await db.getDefaultToken(repo.guild_id);
      token = defaultToken?.token;
    }

    if (!token) {
      console.warn(`[poller] No token for ${repo.full_name}`);
      return;
    }

    // Check rate limit
    const tokenId = repo.github_token_id || (repo.guild_id ? (await db.getDefaultToken(repo.guild_id))?.id : null);
    if (tokenId && isRateLimited(tokenId)) {
      console.log(`[poller] Rate limited, skipping ${repo.full_name}`);
      return;
    }

    try {
      const latestSha = await getLatestCommit(repo.owner, repo.name, token);

      if (!latestSha) {
        return;
      }

      // First time seeing this repo
      if (!repo.last_commit_sha) {
        const patch = {
          last_commit_sha: latestSha,
          last_polled_at: Date.now(),
          error_message: null,
        };

        // Learn the real default branch (main/master/etc)
        try {
          const info = await getRepoInfo(repo.owner, repo.name, token);
          if (info?.default_branch) patch.default_branch = info.default_branch;
        } catch { /* non-fatal */ }

        await db.updateRepository(repo.id, patch);
        console.log(`[poller] Initialized polling for ${repo.full_name} at ${latestSha.slice(0, 7)}`);
        return;
      }

      // Check if there are new commits
      if (latestSha !== repo.last_commit_sha) {
        const newCommits = await getCommitsSince(repo.owner, repo.name, token, repo.last_commit_sha);

        if (newCommits.length > 0) {
          console.log(`[poller] ${newCommits.length} new commit(s) for ${repo.full_name}`);

          for (const commit of newCommits.slice(0, 5)) {
            const defaultBranch = repo.default_branch || "main";
            const payload = {
              repository: {
                full_name: repo.full_name,
                html_url: `https://github.com/${repo.full_name}`,
                owner: { login: repo.owner },
                name: repo.name,
              },
              sender: {
                login: commit.author?.login || commit.commit.author.name,
                html_url: commit.author?.html_url || null,
              },
              commits: [commit],
              ref: `refs/heads/${defaultBranch}`,
              compare: `https://github.com/${repo.full_name}/compare/${repo.last_commit_sha}...${latestSha}`,
            };

            this.onEvent("push", payload, repo);
          }

          await db.updateRepository(repo.id, {
            last_commit_sha: latestSha,
            last_polled_at: Date.now(),
            error_message: null,
          });
        }
      } else {
        await db.updateRepository(repo.id, {
          last_polled_at: Date.now(),
        });
      }

    } catch (err) {
      console.error(`[poller] Error polling ${repo.full_name}:`, err.message);

      await db.updateRepository(repo.id, {
        error_message: err.message,
      });
    }
  }

  async pollNow(repoFullName) {
    const db = require("../db/database");

    // Try to find across all guilds
    const allRepos = await db.getAllPollableRepositories();
    const repo = allRepos.find(r => r.full_name === repoFullName);

    if (!repo) {
      throw new Error(`Repository ${repoFullName} not found or not enabled for polling`);
    }

    await this._pollRepo(repo);
  }
}

module.exports = {
  GitHubPoller,
  githubRequest,
  isRateLimited,
  getRemainingRequests,
  updateRateLimit,
  getLatestCommit,
  getCommitsSince,
  getRecentReleases,
  getRecentPullRequests,
  getRepoInfo,
};
