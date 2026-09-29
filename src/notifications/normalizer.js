// normalizer.js — converts raw GitHub webhook payloads into a normalized
// internal notification structure consumed by the notification router.

"use strict";

/**
 * @typedef {Object} NormalizedNotification
 * @property {string}      repositoryFullName
 * @property {string}      repositoryUrl
 * @property {string}      eventType
 * @property {string|null} action
 * @property {string}      title
 * @property {string}      description
 * @property {string|null} actor
 * @property {string|null} actorUrl
 * @property {string|null} actorAvatar
 * @property {string|null} branch
 * @property {string|null} url
 * @property {Date}        timestamp
 * @property {object}      metadata     — event-specific extra data
 * @property {object}      rawPayload   — original payload for platform formatters
 */

function clip(str, max = 200) {
  if (!str) return "";
  const s = String(str).replace(/\r?\n/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Normalize a raw GitHub webhook payload.
 * @param {string} eventType
 * @param {object} payload
 * @returns {NormalizedNotification}
 */
function normalize(eventType, payload) {
  const repo = payload.repository || {};
  const sender = payload.sender || {};

  const base = {
    repositoryFullName: repo.full_name || "unknown/unknown",
    repositoryUrl: repo.html_url || null,
    eventType,
    action: payload.action || null,
    actor: sender.login || null,
    actorUrl: sender.html_url || null,
    actorAvatar: sender.avatar_url || null,
    timestamp: new Date(),
    rawPayload: payload,
    metadata: {},
  };

  switch (eventType) {
    case "push": {
      const branch = (payload.ref || "").replace("refs/heads/", "").replace("refs/tags/", "");
      const isTag = (payload.ref || "").startsWith("refs/tags/");
      const commits = payload.commits || [];
      return {
        ...base,
        title: payload.forced
          ? `Force push to \`${branch}\``
          : isTag
            ? `Tag pushed: \`${branch}\``
            : `Push to \`${branch}\` — ${commits.length} commit(s)`,
        description: commits
          .slice(0, 5)
          .map(c => `${c.id.slice(0, 7)} ${clip(c.message.split("\n")[0], 60)} — ${c.author.name}`)
          .join("\n") || "No commits",
        branch,
        url: payload.compare || repo.html_url,
        metadata: { commits: commits.length, forced: !!payload.forced, isTag, ref: payload.ref },
      };
    }

    case "pull_request": {
      const pr = payload.pull_request || {};
      return {
        ...base,
        title: `PR #${pr.number} ${payload.action}: ${clip(pr.title, 80)}`,
        description: clip(pr.body, 300),
        branch: pr.head?.ref || null,
        url: pr.html_url || null,
        metadata: {
          prNumber: pr.number,
          merged: !!pr.merged,
          base: pr.base?.ref,
          additions: pr.additions,
          deletions: pr.deletions,
        },
      };
    }

    case "issues": {
      const issue = payload.issue || {};
      return {
        ...base,
        title: `Issue #${issue.number} ${payload.action}: ${clip(issue.title, 80)}`,
        description: clip(issue.body, 300),
        url: issue.html_url || null,
        metadata: {
          issueNumber: issue.number,
          labels: (issue.labels || []).map(l => l.name),
        },
      };
    }

    case "issue_comment": {
      const issue = payload.issue || {};
      const comment = payload.comment || {};
      return {
        ...base,
        title: `Comment on #${issue.number}: ${clip(issue.title, 60)}`,
        description: clip(comment.body, 300),
        url: comment.html_url || null,
        metadata: { issueNumber: issue.number },
      };
    }

    case "pull_request_review": {
      const pr = payload.pull_request || {};
      const review = payload.review || {};
      return {
        ...base,
        title: `Review on PR #${pr.number} (${review.state})`,
        description: clip(review.body, 300),
        url: review.html_url || null,
        metadata: { prNumber: pr.number, state: review.state },
      };
    }

    case "release": {
      const release = payload.release || {};
      return {
        ...base,
        title: `Release ${payload.action}: ${release.tag_name}`,
        description: clip(release.body, 400),
        url: release.html_url || null,
        metadata: { tagName: release.tag_name, prerelease: release.prerelease },
      };
    }

    case "star": {
      return {
        ...base,
        title: `${sender.login} ${payload.action === "created" ? "starred" : "unstarred"} ${repo.full_name}`,
        description: `Total stars: ${repo.stargazers_count}`,
        url: repo.html_url || null,
        metadata: { stars: repo.stargazers_count },
      };
    }

    case "fork": {
      const forkee = payload.forkee || {};
      return {
        ...base,
        title: `${sender.login} forked ${repo.full_name}`,
        description: `Fork: ${forkee.full_name}`,
        url: forkee.html_url || null,
        metadata: { forkFullName: forkee.full_name },
      };
    }

    case "create":
      return {
        ...base,
        title: `Created ${payload.ref_type}: \`${payload.ref}\``,
        description: "",
        url: repo.html_url || null,
        metadata: { refType: payload.ref_type, ref: payload.ref },
      };

    case "delete":
      return {
        ...base,
        title: `Deleted ${payload.ref_type}: \`${payload.ref}\``,
        description: "",
        url: repo.html_url || null,
        metadata: { refType: payload.ref_type, ref: payload.ref },
      };

    case "workflow_run": {
      const run = payload.workflow_run || {};
      return {
        ...base,
        title: `Workflow "${run.name}" ${run.conclusion || payload.action}`,
        description: `Branch: ${run.head_branch} — Trigger: ${run.event}`,
        branch: run.head_branch || null,
        url: run.html_url || null,
        metadata: { workflowName: run.name, conclusion: run.conclusion, trigger: run.event },
      };
    }

    case "check_run": {
      const run = payload.check_run || {};
      return {
        ...base,
        title: `Check "${run.name}" → ${run.conclusion || payload.action}`,
        description: clip(run.output?.summary, 200),
        url: run.html_url || null,
        metadata: { checkName: run.name, conclusion: run.conclusion },
      };
    }

    case "deployment_status": {
      const status = payload.deployment_status || {};
      const deployment = payload.deployment || {};
      return {
        ...base,
        title: `Deployment to \`${deployment.environment}\` → ${status.state}`,
        description: clip(status.description, 200),
        url: status.target_url || repo.html_url || null,
        metadata: { environment: deployment.environment, state: status.state },
      };
    }

    default:
      return {
        ...base,
        title: `${eventType}${payload.action ? ` (${payload.action})` : ""}`,
        description: "",
        url: repo.html_url || null,
      };
  }
}

module.exports = { normalize };
