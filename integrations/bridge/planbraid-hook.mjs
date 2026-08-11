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
