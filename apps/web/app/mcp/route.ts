import { waitUntil } from "@vercel/functions";
import type { PgD1 } from "@/db/pg-d1";
import { ensureSchema } from "@/db/setup";
import type { DashboardState, WorkStatus } from "@/lib/contracts";
import { createWorkItemsDeduplicated, executeCommand, getReadyWork, loadDashboard, principalFromBearer, recordInteraction, registerSourceSession, updateSourceHeartbeat, type Principal } from "@/lib/store";
import { ANNOTATION_EDGE_TYPES, DAG_EDGE_TYPES } from "@/lib/graph/edges.ts";
import { dispatchNotification, type PushEnvironment } from "@/lib/push";
import { oauthChallenge } from "@/lib/oauth";
import { env as runtimeEnv } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";

type Env = PushEnvironment & { DB: PgD1 };
type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type Json = Record<string, unknown>;

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"];

const tools = [
  { name: "resolve_project", description: "Resolve a canonical Planbraid project from an explicit ID, repository path, remote, or name. Call this before planning when project identity is uncertain.", inputSchema: { type: "object", properties: { project_id: { type: "string" }, query: { type: "string" } } } },
  { name: "create_project", description: "Create a Planbraid project, optionally bound to the repository or directory it tracks. Always call resolve_project first: if it returns a match, use that project instead of creating a second one for the same work.", inputSchema: { type: "object", required: ["name", "idempotency_key"], properties: { name: { type: "string" }, directory: { type: "string", description: "Absolute path of the repository or working directory this project tracks, for example /Users/you/Projects/my-app." }, description: { type: "string" }, git_remote: { type: "string", description: "Canonical remote URL, for example https://github.com/owner/repo." }, idempotency_key: { type: "string" } } } },
  { name: "update_project", description: "Update a project's details. Use this to bind your absolute working directory to a project that was created in the web UI without one: a project with no directory cannot be matched to this repository by future sessions. Omitted fields are left unchanged.", inputSchema: { type: "object", required: ["project_id", "idempotency_key"], properties: { project_id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, directory: { type: "string", description: "Absolute path of the working directory this project tracks." }, git_remote: { type: "string" }, idempotency_key: { type: "string" } } } },
  { name: "get_project_brief", description: "Get compact current project context: active, ready, blocked, review, recent events, sources, and recommended next actions.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" }, focus: { type: "string" } } } },
  { name: "list_work_items", description: "List current project work with structured status/source filters.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" }, status: { type: "string" }, source_id: { type: "string" }, query: { type: "string" }, limit: { type: "number" } } } },
  { name: "get_ready_work", description: "Get work that is actually actionable right now: unblocked by dependencies, not claimed by another active session, ranked by how much finishing it unlocks. Prefer this over list_work_items when deciding what to work on next.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" }, source_id: { type: "string", description: "This session's source ID. Excludes work already claimed by other active sessions; does not exclude this session's own claims." }, limit: { type: "number", description: "Defaults to 5." }, avoid_collisions: { type: "boolean", description: "Defaults to true. Set false to see all unblocked work regardless of other sessions' claims." } } } },
  { name: "get_work_item", description: "Get one work item with source, evidence, dependencies, and recent events.", inputSchema: { type: "object", required: ["work_item_id"], properties: { work_item_id: { type: "string" } } } },
  { name: "create_work_items", description: "Propose one or more work items in one operation. Proposals are matched against work the project already has: a restatement of existing work returns that item's ID instead of creating a duplicate, so always use the returned workItemId rather than assuming a new item was created. Check each result's status field (created, matched, or uncertain) and any warning before starting work.", inputSchema: { type: "object", required: ["project_id", "items", "idempotency_key"], properties: { project_id: { type: "string" }, source_id: { type: "string" }, idempotency_key: { type: "string" }, items: { type: "array", maxItems: 50, items: { type: "object", required: ["title"], properties: { ref: { type: "string", description: "Optional caller-chosen handle echoed back in the result, for correlating proposals with outcomes." }, title: { type: "string" }, description: { type: "string" }, status: { type: "string" }, priority: { type: "string" }, depends_on: { type: "array", items: { type: "string" }, description: "IDs of prerequisite tasks: this item cannot start until each one is done. Each entry is either another item's ref from this same call, or the work_item_id of a task that already exists." } } } } } } },
  { name: "update_work_item", description: "Update descriptive fields using optimistic expected_version concurrency.", inputSchema: { type: "object", required: ["project_id", "work_item_id", "expected_version", "idempotency_key"], properties: { project_id: { type: "string" }, work_item_id: { type: "string" }, expected_version: { type: "number" }, title: { type: "string" }, description: { type: "string" }, priority: { type: "string" }, assignee: { type: ["string", "null"] }, idempotency_key: { type: "string" } } } },
  { name: "start_work", description: "Atomically claim/start ready work and attribute it to this source session.", inputSchema: transitionSchema() },
  { name: "block_work", description: "Mark work blocked with a structured reason, optionally naming the specific prerequisite tasks it is waiting on.", inputSchema: { ...transitionSchema(), properties: { ...transitionSchema().properties, blocker_work_item_ids: { type: "array", items: { type: "string" }, description: "IDs of tasks that must complete before this one can proceed. A 'blocks' dependency edge is recorded from each one to this task." } }, required: ["project_id", "work_item_id", "expected_version", "reason", "idempotency_key"] } },
  { name: "link_work_items", description: "Declare a relationship between two work items: an ordering dependency (one blocks or is required by the other) or a non-ordering annotation (related, duplicate, superseded). Name fields for role, not position: the prerequisite is the task that must happen first.", inputSchema: { type: "object", required: ["project_id", "prerequisite_work_item_id", "dependent_work_item_id", "idempotency_key"], properties: { project_id: { type: "string" }, prerequisite_work_item_id: { type: "string", description: "The task that must be resolved first." }, dependent_work_item_id: { type: "string", description: "The task that is waiting on the prerequisite." }, type: { type: "string", enum: [...DAG_EDGE_TYPES, ...ANNOTATION_EDGE_TYPES], description: "Defaults to 'blocks'. Use 'requires' for a soft dependency, or an annotation type ('relates_to', 'duplicates', 'supersedes') for a non-ordering relationship." }, reason: { type: "string" }, idempotency_key: { type: "string" } } } },
  { name: "report_progress", description: "Append a concise, durable progress update without replacing task description.", inputSchema: { type: "object", required: ["project_id", "work_item_id", "summary", "idempotency_key"], properties: { project_id: { type: "string" }, work_item_id: { type: "string" }, source_id: { type: "string" }, summary: { type: "string" }, idempotency_key: { type: "string" } } } },
  { name: "report_completion", description: "Report implementation completion with evidence. The item enters review unless verified evidence is present.", inputSchema: { type: "object", required: ["project_id", "work_item_id", "expected_version", "summary", "idempotency_key"], properties: { project_id: { type: "string" }, work_item_id: { type: "string" }, expected_version: { type: "number" }, source_id: { type: "string" }, summary: { type: "string" }, verified: { type: "boolean" }, evidence: { type: "array", maxItems: 20, items: { type: "object", properties: { type: { type: "string" }, label: { type: "string" }, uri: { type: "string" }, result: { type: "string" } } } }, idempotency_key: { type: "string" } } } },
  { name: "reopen_work", description: "Reopen completed/review work with a reason and current expected version.", inputSchema: { ...transitionSchema(), required: ["project_id", "work_item_id", "expected_version", "reason", "idempotency_key"] } },
  { name: "register_agent_session", description: "Register or resume any MCP client, agent, or personal-model session and return a stable Planbraid source ID.", inputSchema: { type: "object", required: ["project_id", "provider", "external_session_id"], properties: { project_id: { type: "string" }, provider: { type: "string", description: "Free-form client, agent, or provider name; for example codex, local-llama, or my-personal-agent." }, external_session_id: { type: "string", description: "Stable conversation or session identifier from the connecting client." }, title: { type: "string" }, model: { type: "string", description: "Optional free-form model name or identifier." }, coding_space_id: { type: "string" }, assurance: { type: "string" } } } },
  { name: "begin_interaction", description: "Record the start of one user-prompt/agent-turn interaction.", inputSchema: interactionSchema("started") },
  { name: "sync_interaction", description: "Close and reconcile an agent interaction after task lifecycle tools have been called. Creates one durable notification.", inputSchema: interactionSchema("completed") },
  { name: "heartbeat_agent_session", description: "Refresh active source presence and current task claims.", inputSchema: { type: "object", required: ["source_id"], properties: { source_id: { type: "string" }, state: { type: "string" }, current_task_ids: { type: "array", items: { type: "string" } } } } },
  { name: "end_agent_session", description: "Close source presence without deleting its history.", inputSchema: { type: "object", required: ["source_id"], properties: { source_id: { type: "string" } } } },
  { name: "search_work", description: "Search task IDs, titles, and descriptions across authorized projects.", inputSchema: { type: "object", required: ["query"], properties: { project_id: { type: "string" }, query: { type: "string" }, limit: { type: "number" } } } },
];

function transitionSchema() {
  return { type: "object", required: ["project_id", "work_item_id", "expected_version", "idempotency_key"], properties: { project_id: { type: "string" }, work_item_id: { type: "string" }, expected_version: { type: "number" }, source_id: { type: "string" }, reason: { type: "string" }, idempotency_key: { type: "string" } } };
}

function interactionSchema(event: string) {
  return { type: "object", required: ["project_id", "source_id", "external_interaction_id"], properties: { project_id: { type: "string" }, source_id: { type: "string" }, external_interaction_id: { type: "string" }, sequence: { type: "number" }, outcome: { type: "string" }, summary: { type: "string" }, event: { const: event } } };
}

async function handleMcp(request: Request, env: Env) {
  await ensureSchema(env.DB);
  const resource = `${new URL(request.url).origin}/mcp`;
  const local = ["localhost", "127.0.0.1"].includes(new URL(request.url).hostname);
  const authorization = request.headers.get("authorization");
  const principal = await principalFromBearer(env.DB, authorization, resource) ?? (local && !authorization ? { userId: "local-demo-user", email: "you@planbraid.local", displayName: "Connected agent", scopes: ["work:read", "work:write"], authentication: "local" as const } : null);
  if (request.method === "GET") {
    if (!principal) return Response.json({ error: "authentication_required" }, { status: 401, headers: { "WWW-Authenticate": oauthChallenge(request), "cache-control": "no-store" } });
    return Response.json({ name: "Planbraid MCP", status: "ok", protocolVersions: PROTOCOL_VERSIONS }, { headers: { "cache-control": "no-store" } });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 256_000) return rpcError(null, -32600, "Request body is too large", 413);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return rpcError(null, -32003, "Cross-origin browser requests are not allowed", 403);
  let rpc: RpcRequest;
  try { rpc = await request.json() as RpcRequest; } catch { return rpcError(null, -32700, "Parse error", 400); }
  if (!rpc.method) return rpcError(rpc.id ?? null, -32600, "Invalid request", 400);

  if (!principal) return rpcError(rpc.id, -32001, "Authentication required", 401, { "WWW-Authenticate": oauthChallenge(request) });
  const requiredScope = rpcScope(rpc);
  if (requiredScope && !principal.scopes?.includes(requiredScope)) return rpcError(rpc.id, -32003, `The ${requiredScope} scope is required`, 403, { "WWW-Authenticate": `${oauthChallenge(request, [...new Set([...(principal.scopes ?? []), requiredScope])].join(" "))}, error="insufficient_scope"` });

  if (rpc.method === "server/discover") return rpcResult(rpc.id, { protocolVersions: PROTOCOL_VERSIONS, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "planbraid", version: "0.1.0" } });
  if (rpc.method === "initialize") {
    const requestedVersion = String(rpc.params?.protocolVersion ?? "");
    const protocolVersion = PROTOCOL_VERSIONS.includes(requestedVersion) ? requestedVersion : PROTOCOL_VERSIONS[0];
    return rpcResult(rpc.id, { protocolVersion, capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } }, serverInfo: { name: "planbraid", title: "Planbraid - One Plan Across Every Agent", version: "0.1.0", description: "Plans, progress, blockers, and completions braided across any MCP-compatible client or model" }, instructions: "Start with resolve_project to find the project for the current repository or directory; if nothing matches, create_project binds a new one to that directory. If a project matches but has no directory bound (created in the web UI), call update_project once with your absolute working directory so later sessions resolve it automatically. Read the project brief before planning. Register this client or model with its own free-form identity. Record accepted work, start/block/progress/completion changes, and sync every interaction. Completion requires evidence or remains in review. Use get_ready_work, not list_work_items, when deciding what to work on next." });
  }
  if (rpc.method === "notifications/initialized" || rpc.method === "ping") return rpcResult(rpc.id, {});

  try {
    if (rpc.method === "tools/list") return rpcResult(rpc.id, { tools, ttlMs: 300000, cacheScope: "private" });
    if (rpc.method === "resources/list") return rpcResult(rpc.id, { resources: await resourceList(env.DB, principal), ttlMs: 15000, cacheScope: "private" });
    if (rpc.method === "resources/read") return rpcResult(rpc.id, await readResource(env.DB, principal, String(rpc.params?.uri ?? "")));
    if (rpc.method === "prompts/list") return rpcResult(rpc.id, { prompts: promptList(), ttlMs: 300000, cacheScope: "public" });
    if (rpc.method === "prompts/get") return rpcResult(rpc.id, getPrompt(String(rpc.params?.name ?? ""), rpc.params?.arguments as Json | undefined));
    if (rpc.method === "tools/call") {
      const name = String(rpc.params?.name ?? "");
      const args = (rpc.params?.arguments ?? {}) as Json;
      const result = await callTool(env.DB, principal, name, args);
      if (typeof result.notificationId === "string") {
        waitUntil(dispatchNotification(env.DB, result.notificationId, env));
      }
      return rpcResult(rpc.id, { content: [{ type: "text", text: conciseResult(name, result) }], structuredContent: result, isError: false });
    }
    return rpcError(rpc.id, -32601, "Method not found", 404);
  } catch (error) {
    const typed = error as Error & { code?: string; status?: number; details?: unknown };
    return rpcResult(rpc.id, { content: [{ type: "text", text: `${typed.code ?? "INTERNAL_ERROR"}: ${typed.code ? typed.message : "Unexpected server error"}` }], structuredContent: { error: { code: typed.code ?? "INTERNAL_ERROR", message: typed.code ? typed.message : "Unexpected server error", details: typed.details, retryable: [429, 503].includes(typed.status ?? 500) } }, isError: true });
  }
}

async function callTool(db: PgD1, principal: Principal, name: string, args: Json): Promise<Json> {
  const state = async () => loadDashboard(db, principal);
  if (name === "resolve_project") {
    const data = await state();
    const explicit = args.project_id ? data.projects.find((project) => project.id === args.project_id) : null;
    const query = String(args.query ?? "").toLowerCase();
    const matches = explicit ? [explicit] : data.projects.filter((project) => !query || [project.name, project.directory, project.gitRemote ?? ""].some((value) => value.toLowerCase().includes(query)));
    return matches.length === 1 ? { project: matches[0], confidence: explicit ? "exact" : "matched" } : { matches, ambiguous: matches.length !== 1 };
  }
  if (name === "create_project") {
    return executeCommand(db, principal, { action: "create_project", name: required(args, "name"), directory: optional(args, "directory"), description: optional(args, "description"), gitRemote: optional(args, "git_remote"), idempotencyKey: required(args, "idempotency_key") });
  }
  if (name === "update_project") {
    return executeCommand(db, principal, { action: "update_project", projectId: required(args, "project_id"), name: optional(args, "name"), description: optional(args, "description"), directory: optional(args, "directory"), gitRemote: optional(args, "git_remote"), idempotencyKey: required(args, "idempotency_key") });
  }
  if (name === "get_project_brief") return projectBrief(await state(), required(args, "project_id"));
  if (name === "list_work_items") {
    const data = await state();
    const query = String(args.query ?? "").toLowerCase();
    return { workItems: data.workItems.filter((item) => item.projectId === required(args, "project_id") && (!args.status || item.status === args.status) && (!args.source_id || item.sourceId === args.source_id) && (!query || `${item.itemKey} ${item.title} ${item.description}`.toLowerCase().includes(query))).slice(0, Math.min(Number(args.limit ?? 100), 200)) };
  }
  if (name === "get_ready_work") {
    return getReadyWork(db, principal, { projectId: required(args, "project_id"), sourceId: optional(args, "source_id"), limit: args.limit == null ? undefined : Number(args.limit), avoidCollisions: args.avoid_collisions === false ? false : undefined });
  }
  if (name === "get_work_item") {
    const data = await state();
    const item = data.workItems.find((entry) => entry.id === required(args, "work_item_id"));
    if (!item) throw toolError("NOT_FOUND", "Work item not found", 404);
    return { workItem: item, source: data.sources.find((source) => source.id === item.sourceId) ?? null, events: data.events.filter((event) => event.workItemId === item.id), evidence: data.evidence.filter((entry) => entry.workItemId === item.id), dependencies: data.dependencies.filter((edge) => edge.fromWorkItemId === item.id || edge.toWorkItemId === item.id) };
  }
  if (name === "create_work_items") {
    const items = Array.isArray(args.items) ? args.items as Json[] : [];
    if (!items.length) throw toolError("VALIDATION_FAILED", "At least one item is required", 422);
    return createWorkItemsDeduplicated(db, principal, {
      projectId: required(args, "project_id"),
      sourceId: optional(args, "source_id"),
      idempotencyKey: required(args, "idempotency_key"),
      proposals: items.slice(0, 50).map((item) => ({
        ref: optional(item, "ref"), title: required(item, "title"), description: optional(item, "description"),
        status: optional(item, "status"), priority: optional(item, "priority"),
        dependsOn: Array.isArray(item.depends_on) ? item.depends_on.map(String) : undefined,
      })),
    });
  }
  if (name === "update_work_item") return executeCommand(db, principal, { action: "update_item", projectId: required(args, "project_id"), itemId: required(args, "work_item_id"), expectedVersion: Number(args.expected_version), title: optional(args, "title"), description: optional(args, "description"), priority: optional(args, "priority") as never, assignee: args.assignee == null ? args.assignee as null | undefined : String(args.assignee), idempotencyKey: required(args, "idempotency_key") });
  if (["start_work", "block_work", "reopen_work"].includes(name)) {
    const status: WorkStatus = name === "start_work" ? "in_progress" : name === "block_work" ? "blocked" : "in_progress";
    const projectId = required(args, "project_id");
    const itemId = required(args, "work_item_id");
    const idempotencyKey = required(args, "idempotency_key");
    let reason = optional(args, "reason");
    const blockerIds = name === "block_work" && Array.isArray(args.blocker_work_item_ids) ? args.blocker_work_item_ids.map(String) : [];
    // Deliberate, single-item action naming specific blockers: unlike depends_on in a
    // create_work_items batch, a bad blocker ID here fails loudly rather than degrading
    // to a warning, since silently accepting it would leave the item "blocked" with no
    // traceable blocker at all.
    if (blockerIds.length) {
      const data = await state();
      const blockerKeys: string[] = [];
      for (const [index, blockerId] of blockerIds.entries()) {
        await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: blockerId, toWorkItemId: itemId, type: "blocks", reason, idempotencyKey: `${idempotencyKey}:blocker:${index}` });
        blockerKeys.push(data.workItems.find((item) => item.id === blockerId)?.itemKey ?? blockerId);
      }
      if (!reason) reason = `Blocked by ${blockerKeys.join(", ")}`;
    }
    return executeCommand(db, principal, { action: "transition_item", projectId, itemId, expectedVersion: Number(args.expected_version), status, reason, sourceId: optional(args, "source_id"), idempotencyKey });
  }
  if (name === "link_work_items") {
    const type = optional(args, "type") ?? "blocks";
    return executeCommand(db, principal, {
      action: "add_dependency", projectId: required(args, "project_id"),
      fromWorkItemId: required(args, "prerequisite_work_item_id"), toWorkItemId: required(args, "dependent_work_item_id"),
      type, reason: optional(args, "reason"), idempotencyKey: required(args, "idempotency_key"),
    });
  }
  if (name === "report_progress") return executeCommand(db, principal, { action: "add_note", projectId: required(args, "project_id"), itemId: required(args, "work_item_id"), summary: required(args, "summary"), sourceId: optional(args, "source_id"), idempotencyKey: required(args, "idempotency_key") });
  if (name === "report_completion") {
    const projectId = required(args, "project_id");
    const itemId = required(args, "work_item_id");
    const key = required(args, "idempotency_key");
    await executeCommand(db, principal, { action: "add_note", projectId, itemId, summary: required(args, "summary"), sourceId: optional(args, "source_id"), idempotencyKey: `${key}:summary` });
    for (const [index, entry] of (Array.isArray(args.evidence) ? args.evidence as Json[] : []).entries()) {
      await executeCommand(db, principal, { action: "add_evidence", projectId, itemId, type: optional(entry, "type") ?? "agent_claim", label: optional(entry, "label") ?? "Completion evidence", uri: optional(entry, "uri"), result: optional(entry, "result"), sourceId: optional(args, "source_id"), idempotencyKey: `${key}:evidence:${index}` });
    }
    const latest = (await state()).workItems.find((item) => item.id === itemId);
    if (!latest) throw toolError("NOT_FOUND", "Work item not found", 404);
    return executeCommand(db, principal, { action: "transition_item", projectId, itemId, expectedVersion: latest.version, status: args.verified === true && Array.isArray(args.evidence) && args.evidence.length ? "done" : "in_review", reason: "Completion reported", sourceId: optional(args, "source_id"), idempotencyKey: `${key}:transition` });
  }
  if (name === "register_agent_session") return registerSourceSession(db, principal, { projectId: required(args, "project_id"), provider: required(args, "provider"), externalId: required(args, "external_session_id"), title: optional(args, "title"), model: optional(args, "model"), codingSpaceId: optional(args, "coding_space_id"), assurance: optional(args, "assurance") });
  if (name === "begin_interaction" || name === "sync_interaction") return recordInteraction(db, principal, { projectId: required(args, "project_id"), sourceId: required(args, "source_id"), externalId: required(args, "external_interaction_id"), sequence: args.sequence == null ? undefined : Number(args.sequence), outcome: optional(args, "outcome"), summary: optional(args, "summary"), event: name === "begin_interaction" ? "started" : "completed" });
  if (name === "heartbeat_agent_session") return updateSourceHeartbeat(db, principal, { sourceId: required(args, "source_id"), state: optional(args, "state"), currentTaskIds: Array.isArray(args.current_task_ids) ? args.current_task_ids.map(String) : [] });
  if (name === "end_agent_session") return updateSourceHeartbeat(db, principal, { sourceId: required(args, "source_id"), end: true });
  if (name === "search_work") {
    const data = await state();
    const query = required(args, "query").toLowerCase();
    return { results: data.workItems.filter((item) => (!args.project_id || item.projectId === args.project_id) && `${item.itemKey} ${item.title} ${item.description}`.toLowerCase().includes(query)).slice(0, Math.min(Number(args.limit ?? 50), 100)) };
  }
  throw toolError("NOT_FOUND", `Unknown tool: ${name}`, 404);
}

function projectBrief(state: DashboardState, projectId: string) {
  const project = state.projects.find((entry) => entry.id === projectId);
  if (!project) throw toolError("NOT_FOUND", "Project not found", 404);
  const items = state.workItems.filter((item) => item.projectId === projectId);
  return { project, revision: project.revision, active: items.filter((item) => item.status === "in_progress"), ready: items.filter((item) => item.status === "ready"), blocked: items.filter((item) => item.status === "blocked"), review: items.filter((item) => item.status === "in_review"), recentEvents: state.events.filter((event) => event.projectId === projectId).slice(0, 20), sources: state.sources.filter((source) => source.projectId === projectId), recommendedNextActions: items.filter((item) => item.status === "blocked").length ? ["Resolve blockers before creating duplicate work", "Review completion claims and evidence"] : ["Claim the highest-priority ready item", "Record new accepted plans"] };
}

async function resourceList(db: PgD1, principal: Principal) {
  const state = await loadDashboard(db, principal);
  return state.projects.flatMap((project) => [
    { uri: `planbraid://projects/${project.id}/brief`, name: `${project.name} brief`, description: "Current active, ready, blocked, review work and sources", mimeType: "application/json" },
    { uri: `planbraid://projects/${project.id}/active`, name: `${project.name} active work`, description: "Current non-terminal work items", mimeType: "application/json" },
  ]);
}

async function readResource(db: PgD1, principal: Principal, uri: string) {
  const match = /^planbraid:\/\/projects\/([^/]+)\/(brief|active)$/.exec(uri);
  if (!match) throw toolError("NOT_FOUND", "Unknown resource", 404);
  const state = await loadDashboard(db, principal);
  const value = match[2] === "brief" ? projectBrief(state, match[1]) : { workItems: state.workItems.filter((item) => item.projectId === match[1] && !["done", "cancelled"].includes(item.status)) };
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }], ttlMs: 15000, cacheScope: "private" };
}

function promptList() {
  return [
    { name: "plan_project_work", title: "Plan project work", description: "Read current work, avoid duplicates, and record an accepted plan", arguments: [{ name: "project_id", required: true }] },
    { name: "handoff_work", title: "Handoff work", description: "Create an evidence-backed cross-agent handoff", arguments: [{ name: "work_item_id", required: true }] },
    { name: "project_status", title: "Project status", description: "Summarize authoritative current status", arguments: [{ name: "project_id", required: true }] },
  ];
}

function getPrompt(name: string, args?: Json) {
  const projectId = optional(args ?? {}, "project_id") ?? "<project_id>";
  const itemId = optional(args ?? {}, "work_item_id") ?? "<work_item_id>";
  const prompts: Record<string, string> = {
    plan_project_work: `Use get_project_brief for ${projectId}. Check existing work before proposing a bounded plan. Record accepted tasks with create_work_items and explicit dependencies.`,
    handoff_work: `Read ${itemId}, its events, evidence, dependencies, and source. Report progress, blockers, exact next action, and then sync the current interaction.`,
    project_status: `Read project ${projectId}. Summarize active, blocked, review, verified completion, and decisions from authoritative Planbraid data.`,
  };
  if (!prompts[name]) throw toolError("NOT_FOUND", "Unknown prompt", 404);
  return { description: name, messages: [{ role: "user", content: { type: "text", text: prompts[name] } }] };
}

function conciseResult(name: string, result: Json) {
  const serialized = JSON.stringify(result);
  return `${name} succeeded. ${serialized.length > 1800 ? `${serialized.slice(0, 1800)}…` : serialized}`;
}
function rpcScope(rpc: RpcRequest) {
  if (["resources/list", "resources/read", "prompts/list", "prompts/get"].includes(rpc.method ?? "")) return "work:read";
  if (rpc.method !== "tools/call") return null;
  const name = String(rpc.params?.name ?? "");
  return ["resolve_project", "get_project_brief", "list_work_items", "get_work_item", "search_work", "get_ready_work"].includes(name) ? "work:read" : "work:write";
}
function required(object: Json, key: string) { const value = object[key]; if (value == null || String(value).trim() === "") throw toolError("VALIDATION_FAILED", `${key} is required`, 422); return String(value); }
function optional(object: Json, key: string) { return object[key] == null ? undefined : String(object[key]); }
function toolError(code: string, message: string, status = 422) { return Object.assign(new Error(message), { code, status }); }
function rpcResult(id: RpcRequest["id"], result: unknown) { return Response.json({ jsonrpc: "2.0", id: id ?? null, result }, { headers: { "MCP-Protocol-Version": PROTOCOL_VERSIONS[0] } }); }
function rpcError(id: RpcRequest["id"], code: number, message: string, status: number, headers?: Record<string, string>) { return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status, headers: { "MCP-Protocol-Version": PROTOCOL_VERSIONS[0], "cache-control": "no-store", ...headers } }); }

export async function GET(request: Request) {
  return handleMcp(request, runtimeEnv);
}

export async function POST(request: Request) {
  return handleMcp(request, runtimeEnv);
}
