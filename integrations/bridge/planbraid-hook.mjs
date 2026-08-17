#!/usr/bin/env node
/**
 * Planbraid provider hook bridge.
 *
 * Required environment:
 *   PLANBRAID_MCP_URL=https://host.example/mcp
 *   PLANBRAID_PROJECT_ID=prj_...
 * Optional:
 *   PLANBRAID_TOKEN=pbd_... (not required for localhost)
 *   PLANBRAID_SITE_BYPASS_TOKEN=... (private Sites deployments only)
 *   PLANBRAID_PROVIDER=codex|claude|gemini|copilot
 *   PLANBRAID_STATE_DIR=/safe/local/cache
 *   PLANBRAID_VERIFY_COMMAND=npm test (run at turn end; only its exit code is reported)
 *   PLANBRAID_REPO_DIR=/path/to/repo (defaults to the hook process's own cwd)
 *   PLANBRAID_DISABLE_REPO_STATE=1 (opt out of M15's repo-state reporting entirely)
 *   PLANBRAID_DISABLE_SYMBOLS=1 (opt out of E7's symbol extraction; repo-state reporting
 *     still runs. Automatic no-op anyway unless `npm install` has been run in this
 *     directory — see symbols.mjs and package.json)
 *
 * RELAYBOARD_* names are read as a fallback for one release if the PLANBRAID_*
 * variant is unset, for anyone who configured this before the rename.
 *
 * The bridge reads one provider hook JSON object from stdin (or argv[2]),
 * maps lifecycle events to Planbraid MCP calls, and keeps a minimal local
 * session->source mapping. It never reads transcript files.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractSymbols } from "./symbols.mjs";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

function env(name) {
  return process.env[`PLANBRAID_${name}`] ?? process.env[`RELAYBOARD_${name}`];
}

const endpoint = env("MCP_URL") || "http://localhost:3000/mcp";
const projectId = env("PROJECT_ID");
const provider = (env("PROVIDER") || inferProvider()).toLowerCase();
const stateDir = env("STATE_DIR") || join(homedir() || tmpdir(), ".planbraid", "bridge");

function inferProvider() {
  if (process.env.CLAUDE_PROJECT_DIR || process.env.CLAUDE_PLUGIN_ROOT) return "claude";
  if (process.env.CODEX_HOME) return "codex";
  return "agent";
}

async function input() {
  if (process.argv[2]) { try { return JSON.parse(process.argv[2]); } catch { /* stdin fallback */ } }
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function rpc(name, args) {
  const token = env("TOKEN");
  const siteBypassToken = env("SITE_BYPASS_TOKEN");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(siteBypassToken ? { "OAI-Sites-Authorization": `Bearer ${siteBypassToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`Planbraid responded ${response.status}`);
  const body = await response.json();
  if (body.error || body.result?.isError) throw new Error(body.error?.message || body.result?.content?.[0]?.text || "Planbraid MCP error");
  return body.result?.structuredContent || {};
}

function sessionKey(payload) { return `${provider}:${payload.session_id || payload.thread_id || payload["thread-id"] || "default"}`; }
function statePath(key) { return join(stateDir, `${Buffer.from(key).toString("base64url")}.json`); }
async function loadState(key) { try { return JSON.parse(await readFile(statePath(key), "utf8")); } catch { return {}; } }
async function saveState(key, state) {
  await mkdir(dirname(statePath(key)), { recursive: true, mode: 0o700 });
  const temp = `${statePath(key)}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await rename(temp, statePath(key));
}

function bounded(value, max = 1800) { return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : ""; }

const MAX_CHANGED_PATHS = 200;
const REPO_STATE_DISABLED = ["1", "true", "yes"].includes((env("DISABLE_REPO_STATE") || "").toLowerCase());
const repoDir = env("REPO_DIR") || process.cwd();

/**
 * Parses `git diff --name-status` output into changed and deleted paths. Each line is
 * either `<status>\t<path>` (add/modify/delete) or `R<score>\t<old>\t<new>` (a rename,
 * three fields) — a deleted path is 'D', and a rename's old path counts as deleted too:
 * nothing lives there under that name any more, which is exactly what M17's divergence
 * detection needs to know (a work item's evidence naming that old path is now stale).
 */
function parseNameStatus(output) {
  const changedPaths = [];
  const deletedPaths = [];
  for (const line of output.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const fields = line.split("\t");
    const status = fields[0];
    if (status.startsWith("R") && fields.length >= 3) {
      changedPaths.push(fields[2]);
      deletedPaths.push(fields[1]);
    } else if (fields.length >= 2) {
      changedPaths.push(fields[1]);
      if (status.startsWith("D")) deletedPaths.push(fields[1]);
    }
  }
  return { changedPaths, deletedPaths };
}

/**
 * Repository state observed at turn end: sha, branch, and which paths changed (and which
 * were deleted or renamed away) since the merge base. Paths and commit metadata only —
 * `git diff --name-status` never reads file contents, so nothing this function touches
 * can leak source into a hook payload. Falls back to the working tree's own uncommitted
 * changes when there is no merge base to diff against (a shallow clone, no configured
 * remote, a detached HEAD).
 */
async function gitRepoState(cwd) {
  try {
    const [{ stdout: sha }, { stdout: branchName }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd, timeout: 3000 }),
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 3000 }),
    ]);
    let diffOutput;
    try {
      const { stdout: mergeBase } = await execFileAsync("git", ["merge-base", "HEAD", "origin/HEAD"], { cwd, timeout: 3000 });
      const { stdout: diff } = await execFileAsync("git", ["diff", "--name-status", `${mergeBase.trim()}...HEAD`], { cwd, timeout: 5000 });
      diffOutput = diff;
    } catch {
      const { stdout: diff } = await execFileAsync("git", ["diff", "--name-status", "HEAD"], { cwd, timeout: 5000 });
      diffOutput = diff;
    }
    const { changedPaths, deletedPaths } = parseNameStatus(diffOutput);
    return {
      headSha: sha.trim(),
      branch: branchName.trim(),
      changedPaths: changedPaths.slice(0, MAX_CHANGED_PATHS),
      deletedPaths: deletedPaths.slice(0, MAX_CHANGED_PATHS),
    };
  } catch {
    // Not a git repository, git unavailable, or nothing checked out yet — capture simply
    // has nothing to report this turn, which is not an error.
    return null;
  }
}

/** Runs the user's own configured verification command, if any, and reports only its
 * exit status — never stdout or stderr, which could contain source or secrets. */
async function runVerification(cwd) {
  const command = env("VERIFY_COMMAND");
  if (!command) return null;
  try {
    await execAsync(command, { cwd, timeout: 180000 });
    return { command, exitCode: 0 };
  } catch (error) {
    return { command, exitCode: typeof error.code === "number" ? error.code : 1 };
  }
}

async function main() {
  if (!projectId) return;
  const payload = await input();
  const key = sessionKey(payload);
  const current = await loadState(key);
  const event = payload.hook_event_name || payload.type || "";
  let sourceId = current.sourceId;
  if (!sourceId || event === "SessionStart" || event === "sessionStart") {
    const registered = await rpc("register_agent_session", {
      project_id: projectId,
      provider,
      external_session_id: payload.session_id || payload.thread_id || payload["thread-id"] || key,
      title: bounded(payload.title || payload.last_assistant_message || `${provider} coding session`, 180),
      model: bounded(payload.model, 100),
      assurance: "enforced",
    });
    sourceId = registered.sourceId;
    await saveState(key, { ...current, sourceId, lastTurnId: current.lastTurnId });
  }
  const turnId = payload.turn_id || payload["turn-id"] || current.lastTurnId || crypto.randomUUID();
  if (["UserPromptSubmit", "userPromptSubmitted"].includes(event)) {
    await rpc("begin_interaction", { project_id: projectId, source_id: sourceId, external_interaction_id: turnId, event: "started" });
    await saveState(key, { ...current, sourceId, lastTurnId: turnId });
  } else if (["Stop", "agentStop", "agent-turn-complete"].includes(event)) {
    await rpc("sync_interaction", {
      project_id: projectId,
      source_id: sourceId,
      external_interaction_id: turnId,
      outcome: payload.error ? "failed" : payload.stop_reason === "needs_input" ? "needs_input" : "success",
      summary: bounded(payload.last_assistant_message || payload["last-assistant-message"] || payload.message || "Interaction completed; no summary was provided"),
      event: "completed",
    });
    // M15: what actually changed in the working tree this turn, reported once per commit
    // regardless of how many turns land on it — report_repo_state is idempotent per sha.
    if (!REPO_STATE_DISABLED) {
      const repoState = await gitRepoState(repoDir);
      if (repoState) {
        const verification = await runVerification(repoDir);
        // E7: best-effort, TS/JS only (RECONCILIATION_ARCHITECTURE.md §7). `extractSymbols`
        // never throws — a missing optional dependency, an unreadable file, or a parse
        // error all resolve to fewer symbols, never a blocked turn. Only *changed* paths
        // are parsed, not the whole repository, keeping this proportional to the turn's
        // own git-diff work rather than a separate full-repo scan.
        const symbolsDisabled = ["1", "true", "yes"].includes((env("DISABLE_SYMBOLS") || "").toLowerCase());
        const symbols = symbolsDisabled ? [] : await extractSymbols(repoDir, repoState.changedPaths).catch(() => []);
        await rpc("report_repo_state", {
          project_id: projectId,
          source_id: sourceId,
          head_sha: repoState.headSha,
          branch: repoState.branch,
          changed_paths: repoState.changedPaths,
          deleted_paths: repoState.deletedPaths,
          ...(verification ? { verification_command: verification.command, verification_exit_code: verification.exitCode } : {}),
          ...(symbols.length ? { symbols } : {}),
        }).catch(() => { /* degraded capture, not a turn-blocking failure */ });
      }
    }
    await saveState(key, { ...current, sourceId, lastTurnId: null });
  } else if (["SessionEnd", "sessionEnd"].includes(event)) {
    await rpc("end_agent_session", { source_id: sourceId });
  } else if (["PostToolUse", "postToolUse"].includes(event)) {
    await rpc("heartbeat_agent_session", { source_id: sourceId, state: "active", current_task_ids: current.currentTaskIds || [] });
  }
}

main().catch((error) => {
  // Hooks must not block normal agent work. A concise stderr message surfaces
  // degraded capture without leaking hook payload content.
  process.stderr.write(`Planbraid capture degraded: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 0;
});
