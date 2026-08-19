import { Server } from "@modelcontextprotocol/server";
import { waitUntil } from "@vercel/functions";
import type { PgD1 } from "@/db/pg-d1";
import type { Resolution, WorkStatus } from "@/lib/contracts";
import { assertProjectAccess, createWorkItemsDeduplicated, executeCommand, findMatchingProject, getReadyWork, organizationFor, startWork, updateSourceHeartbeat, recordInteraction, registerSourceSession, type Principal } from "@/lib/store";
import { itemKeysFor, listProjects, listWorkItems, loadProjectView, loadWorkItemDetail, searchWorkItems, type ProjectView } from "@/lib/read/project-view.ts";
import { reportSimplificationFinding } from "@/lib/simplify/runs.ts";
import type { FindingKind } from "@/lib/simplify/analyze.ts";
import { getPlanningContext } from "@/lib/planning/context.ts";
import { explainWorkItem } from "@/lib/planning/explain.ts";
import { getHandoffPackage } from "@/lib/planning/handoff.ts";
import { listOpenDecisions, raiseConflictDecisions, recordDecision, resolveDecision } from "@/lib/planning/decisions.ts";
import { submitJudgment } from "@/lib/planning/judgments.ts";
import { ingestRepoObservation } from "@/lib/evidence/ingest.ts";
import { reportCompletion } from "@/lib/planning/completion.ts";
import { getPlanningHealth } from "@/lib/planning/health.ts";
import { getSavedView, assertSavedViewName } from "@/lib/planning/views.ts";
import { dispatchNotification, type PushEnvironment } from "@/lib/push";
import { tools, type ToolDef } from "./tools";

type Env = PushEnvironment & { DB: PgD1 };
type Json = Record<string, unknown>;

const INSTRUCTIONS = "Start with resolve_project to find the project for the current repository or directory; if nothing matches, create_project binds a new one to that directory. If a project matches but has no directory bound (created in the web UI), call update_project once with your absolute working directory so later sessions resolve it automatically. Then register_agent_session before doing anything else: if the project already has open work, its response tells you so directly (existingWork). Read that before you plan. Before proposing or planning new work, call get_planning_context with your objective in a sentence: it surfaces what the project already knows that's relevant to it, so you don't re-propose something already done, already rejected, or already being worked on by someone else. Register this client or model with its own free-form identity; which of the user's accounts you are running as is resolved from the connection itself, so do not guess at one. Record accepted work, start/block/progress/completion changes, and sync every interaction. Work you propose is recorded as a proposal, not as an accepted plan: when the user actually agrees to it, call accept_work_items naming who decided. Completion requires evidence or remains in review. Use get_ready_work, not list_work_items, when deciding what to work on next.";

/**
 * Builds a fresh low-level Server per request (the SDK's own per-request-factory model).
 * Deliberately the low-level Server, not McpServer/registerTool: every tool here is
 * already a hand-written JSON Schema object, and callTool's dispatch and result shape
 * (structuredContent, isError, the concise text summary) are an existing wire contract
 * the hook bridge (integrations/bridge/planbraid-hook.mjs) parses. registerTool would
 * derive schemas from Zod and reshape results; this instead hands the SDK only the
 * transport/protocol layer (initialize, notifications, era negotiation) that has
 * actually been the source of every past Codex-discovered bug, and leaves tool dispatch
 * untouched.
 */
export function buildMcpServer(db: PgD1, env: Env, principal: Principal) {
  const server = new Server(
    { name: "planbraid", title: "Planbraid - One Plan Across Every Agent", version: "0.1.0", description: "Plans, progress, blockers, and completions braided across any MCP-compatible client or model" },
    { capabilities: { tools: {}, resources: { subscribe: false }, prompts: {} }, instructions: INSTRUCTIONS },
  );

  // See ToolDef's doc comment in ./tools: the SDK's own type for a raw tools/list
  // result wants string-literal `type` fields and mutable arrays throughout, which
  // isn't worth encoding across ~30 differently-shaped hand-written JSON Schemas.
  server.setRequestHandler("tools/list", async () => ({ tools }) as unknown as { tools: Array<ToolDef & { inputSchema: { type: "object" } & Record<string, unknown> }> });

  // tools/call is the one method whose error contract is a tested, documented wire
  // shape (integrations/bridge/planbraid-hook.mjs and callers generally expect a
  // 200-status {isError: true} tool result, not a protocol-level error, so an agent
  // can read and react to a domain error like NOT_FOUND or VALIDATION_FAILED instead
  // of the client-level retry/abort a protocol error triggers). resources/* and
  // prompts/* below have no such contract to preserve, so their errors are left to
  // throw and become real JSON-RPC protocol errors, which is what a ListResourcesResult
  // or ReadResourceResult failing actually is per spec.
  server.setRequestHandler("tools/call", async (request: { params: { name: string; arguments?: unknown } }) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Json;
    try {
      // Covers every tool here except get_work_item, which takes only a work_item_id;
      // that one checks after loading the item, inside callTool itself.
      if (typeof args.project_id === "string") await assertProjectAccess(db, args.project_id, principal);
      const result = await callTool(db, principal, name, args);
      if (typeof result.notificationId === "string") {
        waitUntil(dispatchNotification(db, result.notificationId, env));
      }
      return { content: [{ type: "text" as const, text: conciseResult(name, result) }], structuredContent: result, isError: false };
    } catch (error) {
      const typed = error as Error & { code?: string; status?: number; details?: unknown };
      return { content: [{ type: "text" as const, text: `${typed.code ?? "INTERNAL_ERROR"}: ${typed.code ? typed.message : "Unexpected server error"}` }], structuredContent: { error: { code: typed.code ?? "INTERNAL_ERROR", message: typed.code ? typed.message : "Unexpected server error", details: typed.details, retryable: [429, 503].includes(typed.status ?? 500) } }, isError: true };
    }
  });

  server.setRequestHandler("resources/list", async () => ({ resources: await resourceList(db, principal) }));

  server.setRequestHandler("resources/read", async (request: { params: { uri: string } }) => readResource(db, principal, String(request.params.uri ?? "")));

  server.setRequestHandler("prompts/list", async () => ({ prompts: promptList() }));

  server.setRequestHandler("prompts/get", async (request: { params: { name: string; arguments?: unknown } }) => getPrompt(String(request.params.name ?? ""), request.params.arguments as Json | undefined));

  return server;
}

async function callTool(db: PgD1, principal: Principal, name: string, args: Json): Promise<Json> {
  if (name === "resolve_project") {
    const organizationId = await organizationFor(db, principal);
    // A block only stops a credential from acting on a project through the other tools;
    // without also filtering it out of discovery, a blocked agent could still learn the
    // project exists (its name, directory) by matching on directory/git_remote/query
    // instead of passing project_id directly, which is the one path the generic
    // pre-dispatch check in route.ts's handleMcp actually covers.
    const blockedIds = principal.credentialId
      ? new Set((await db.prepare("SELECT project_id FROM project_access_blocks WHERE credential_id = ? AND organization_id = ?").bind(principal.credentialId, organizationId).all<{ project_id: string }>()).results.map((row) => row.project_id))
      : null;
    const projects = (await listProjects(db, organizationId)).filter((project) => !blockedIds?.has(project.id));
    const explicit = args.project_id ? projects.find((project) => project.id === args.project_id) : null;
    if (explicit) return { project: explicit, confidence: "exact" };

    // Identity first: a remote or working directory pins one project exactly, and a
    // bare query string can miss it (".git" suffixes, name casing) and mislead an agent
    // into creating a duplicate.
    const strongMatch = await findMatchingProject(db, organizationId, { directory: optional(args, "directory"), gitRemote: optional(args, "git_remote") });
    const strong = strongMatch && !blockedIds?.has(strongMatch.id) ? strongMatch : null;
    if (strong) {
      const project = projects.find((entry) => entry.id === strong.id);
      if (project) return { project, confidence: "exact", matchedOn: strong.matchedOn };
    }

    const query = String(args.query ?? "").toLowerCase();
    const matches = projects.filter((project) => !query || [project.name, project.directory, project.gitRemote ?? ""].some((value) => value.toLowerCase().includes(query)));
    return matches.length === 1 ? { project: matches[0], confidence: "matched" } : { matches, ambiguous: matches.length !== 1 };
  }
  if (name === "create_project") {
    return executeCommand(db, principal, { action: "create_project", name: required(args, "name"), directory: optional(args, "directory"), description: optional(args, "description"), gitRemote: optional(args, "git_remote"), idempotencyKey: required(args, "idempotency_key") });
  }
  if (name === "update_project") {
    return executeCommand(db, principal, { action: "update_project", projectId: required(args, "project_id"), name: optional(args, "name"), description: optional(args, "description"), directory: optional(args, "directory"), gitRemote: optional(args, "git_remote"), idempotencyKey: required(args, "idempotency_key") });
  }
  if (name === "get_project_brief") {
    const organizationId = await organizationFor(db, principal);
    const projectId = required(args, "project_id");
    const [view, decisionsOpen] = await Promise.all([
      loadProjectView(db, organizationId, projectId, { items: true, events: true, sources: true }),
      listOpenDecisions(db, organizationId, projectId),
    ]);
    return { ...projectBrief(view), decisionsOpen };
  }
  if (name === "list_work_items") {
    const organizationId = await organizationFor(db, principal);
    return { workItems: await listWorkItems(db, organizationId, { projectId: required(args, "project_id"), status: optional(args, "status"), sourceId: optional(args, "source_id"), query: optional(args, "query"), limit: args.limit == null ? undefined : Number(args.limit) }) };
  }
  if (name === "get_ready_work") {
    return getReadyWork(db, principal, { projectId: required(args, "project_id"), sourceId: optional(args, "source_id"), limit: args.limit == null ? undefined : Number(args.limit), avoidCollisions: args.avoid_collisions === false ? false : undefined });
  }
  if (name === "get_work_item") {
    const organizationId = await organizationFor(db, principal);
    const detail = await loadWorkItemDetail(db, organizationId, required(args, "work_item_id"));
    // The only tool that identifies its target by work_item_id rather than project_id, so
    // it can't go through the generic pre-dispatch check; done here instead, after the
    // project is known.
    await assertProjectAccess(db, detail.workItem.projectId, principal);
    return detail;
  }
  if (name === "create_work_items") {
    const items = Array.isArray(args.items) ? args.items as Json[] : [];
    if (!items.length) throw toolError("VALIDATION_FAILED", "At least one item is required", 422);
    const projectId = required(args, "project_id");
    const idempotencyKey = required(args, "idempotency_key");
    const sourceId = optional(args, "source_id");
    const outcome = await createWorkItemsDeduplicated(db, principal, {
      projectId, sourceId, importRequestId: optional(args, "import_request_id"), idempotencyKey,
      proposals: items.slice(0, 50).map((item) => ({
        ref: optional(item, "ref"), title: required(item, "title"), description: detailedDescription(item, "description"),
        status: optional(item, "status"), priority: optional(item, "priority"),
        dependsOn: Array.isArray(item.depends_on) ? item.depends_on.map(String) : undefined,
      })),
    });

    // E4, "conflicts raise decisions": lib/store.ts already recorded the direct
    // conflicts_with edge between the two items as part of createWorkItemsDeduplicated;
    // this adds the decision itself. See raiseConflictDecisions's own comment for why
    // that call has to happen here rather than inside lib/store.ts.
    await raiseConflictDecisions(db, principal, { projectId, sourceId, idempotencyKey, results: outcome.results as Array<Record<string, unknown>> });
    return outcome;
  }
  if (name === "accept_work_items") {
    const ids = Array.isArray(args.work_item_ids) ? args.work_item_ids.map(String) : [];
    if (!ids.length) throw toolError("VALIDATION_FAILED", "At least one work_item_id is required", 422);
    return executeCommand(db, principal, { action: "set_maturity", projectId: required(args, "project_id"), itemIds: ids, maturity: "accepted", statedBy: required(args, "stated_by"), reason: optional(args, "reason"), sourceId: optional(args, "source_id"), idempotencyKey: required(args, "idempotency_key") });
  }
  if (name === "update_work_item") return executeCommand(db, principal, { action: "update_item", projectId: required(args, "project_id"), itemId: required(args, "work_item_id"), expectedVersion: Number(args.expected_version), sourceId: optional(args, "source_id"), title: optional(args, "title"), description: optionalDetailedDescription(args, "description"), priority: optional(args, "priority") as never, assignee: args.assignee == null ? args.assignee as null | undefined : String(args.assignee), idempotencyKey: required(args, "idempotency_key") });
  if (name === "start_work") {
    return startWork(db, principal, {
      projectId: required(args, "project_id"), itemId: required(args, "work_item_id"), expectedVersion: Number(args.expected_version),
      reason: optional(args, "reason"), sourceId: optional(args, "source_id"), force: args.force === true, idempotencyKey: required(args, "idempotency_key"),
    });
  }
  if (["block_work", "reopen_work"].includes(name)) {
    const status: WorkStatus = name === "block_work" ? "blocked" : "in_progress";
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
      const keys = await itemKeysFor(db, await organizationFor(db, principal), blockerIds);
      const blockerKeys: string[] = [];
      for (const [index, blockerId] of blockerIds.entries()) {
        await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: blockerId, toWorkItemId: itemId, type: "blocks", reason, sourceId: optional(args, "source_id"), idempotencyKey: `${idempotencyKey}:blocker:${index}` });
        blockerKeys.push(keys.get(blockerId) ?? blockerId);
      }
      if (!reason) reason = `Blocked by ${blockerKeys.join(", ")}`;
    }
    return executeCommand(db, principal, { action: "transition_item", projectId, itemId, expectedVersion: Number(args.expected_version), status, reason, sourceId: optional(args, "source_id"), idempotencyKey });
  }
  if (name === "cancel_work") {
    return executeCommand(db, principal, {
      action: "transition_item", projectId: required(args, "project_id"), itemId: required(args, "work_item_id"), expectedVersion: Number(args.expected_version),
      status: "cancelled", reason: optional(args, "reason"), resolution: optional(args, "resolution") as Resolution | undefined,
      sourceId: optional(args, "source_id"), idempotencyKey: required(args, "idempotency_key"),
    });
  }
  if (name === "link_work_items") {
    const type = optional(args, "type") ?? "blocks";
    return executeCommand(db, principal, {
      action: "add_dependency", projectId: required(args, "project_id"),
      fromWorkItemId: required(args, "prerequisite_work_item_id"), toWorkItemId: required(args, "dependent_work_item_id"),
      type, reason: optional(args, "reason"), sourceId: optional(args, "source_id"), idempotencyKey: required(args, "idempotency_key"),
    });
  }
  if (name === "report_progress") return executeCommand(db, principal, { action: "add_note", projectId: required(args, "project_id"), itemId: required(args, "work_item_id"), summary: required(args, "summary"), sourceId: optional(args, "source_id"), idempotencyKey: required(args, "idempotency_key") });
  if (name === "report_completion") {
    const evidence = Array.isArray(args.evidence) ? args.evidence as Json[] : [];
    return reportCompletion(db, principal, {
      projectId: required(args, "project_id"), itemId: required(args, "work_item_id"), summary: required(args, "summary"),
      evidence: evidence.map((entry) => ({ type: optional(entry, "type"), label: optional(entry, "label"), uri: optional(entry, "uri"), result: optional(entry, "result") })),
      sourceId: optional(args, "source_id"), idempotencyKey: required(args, "idempotency_key"),
    });
  }
  if (name === "register_agent_session") return registerSourceSession(db, principal, { projectId: required(args, "project_id"), provider: required(args, "provider"), externalId: required(args, "external_session_id"), title: optional(args, "title"), model: optional(args, "model"), accountLabel: optional(args, "account_label"), codingSpaceId: optional(args, "coding_space_id"), assurance: optional(args, "assurance") });
  if (name === "begin_interaction" || name === "sync_interaction") return recordInteraction(db, principal, { projectId: required(args, "project_id"), sourceId: required(args, "source_id"), externalId: required(args, "external_interaction_id"), sequence: args.sequence == null ? undefined : Number(args.sequence), outcome: optional(args, "outcome"), summary: optional(args, "summary"), event: name === "begin_interaction" ? "started" : "completed" });
  if (name === "heartbeat_agent_session") return updateSourceHeartbeat(db, principal, { sourceId: required(args, "source_id"), state: optional(args, "state"), currentTaskIds: Array.isArray(args.current_task_ids) ? args.current_task_ids.map(String) : [] });
  if (name === "end_agent_session") return updateSourceHeartbeat(db, principal, { sourceId: required(args, "source_id"), end: true });
  if (name === "search_work") {
    const organizationId = await organizationFor(db, principal);
    return { results: await searchWorkItems(db, organizationId, { query: required(args, "query"), projectId: optional(args, "project_id"), limit: args.limit == null ? undefined : Number(args.limit) }) };
  }
  if (name === "report_simplify_finding") {
    return reportSimplificationFinding(db, principal, { projectId: required(args, "project_id"), kind: required(args, "kind") as FindingKind, workItemId: required(args, "work_item_id"), relatedWorkItemId: optional(args, "related_work_item_id"), reason: required(args, "reason"), detail: optional(args, "detail"), sourceId: optional(args, "source_id") });
  }
  if (name === "get_planning_context") {
    const organizationId = await organizationFor(db, principal);
    return getPlanningContext(db, organizationId, { projectId: required(args, "project_id"), objective: required(args, "objective"), sourceId: optional(args, "source_id") });
  }
  if (name === "explain_work_item") {
    const organizationId = await organizationFor(db, principal);
    return explainWorkItem(db, organizationId, required(args, "work_item_id"));
  }
  if (name === "get_handoff_package") {
    return getHandoffPackage(db, principal, required(args, "project_id"));
  }
  if (name === "record_decision") {
    const options = Array.isArray(args.options) ? args.options as Json[] : [];
    return recordDecision(db, principal, {
      projectId: required(args, "project_id"), question: required(args, "question"), description: optional(args, "description"),
      options: options.map((option) => ({ label: String(option.label ?? ""), relatedWorkItemId: optional(option, "related_work_item_id"), rationale: optional(option, "rationale") })),
      sourceId: optional(args, "source_id"), idempotencyKey: required(args, "idempotency_key"),
    });
  }
  if (name === "resolve_decision") {
    return resolveDecision(db, principal, {
      projectId: required(args, "project_id"), decisionWorkItemId: required(args, "decision_work_item_id"), winningOptionId: required(args, "winning_option_id"),
      resolutionReason: optional(args, "resolution_reason"), sourceId: optional(args, "source_id"),
    });
  }
  if (name === "submit_reconciliation_judgment") {
    const verdict = String(args.verdict ?? "");
    if (verdict !== "same" && verdict !== "different") throw toolError("VALIDATION_FAILED", "verdict must be 'same' or 'different'", 422);
    return submitJudgment(db, principal, {
      projectId: required(args, "project_id"), pairId: required(args, "pair_id"), verdict,
      justification: required(args, "justification"), sourceId: optional(args, "source_id"),
    });
  }
  if (name === "report_repo_state") {
    const symbols = Array.isArray(args.symbols) ? args.symbols as Json[] : [];
    return ingestRepoObservation(db, principal, {
      projectId: required(args, "project_id"), sourceId: optional(args, "source_id"), headSha: required(args, "head_sha"), branch: optional(args, "branch"),
      changedPaths: Array.isArray(args.changed_paths) ? args.changed_paths.map(String) : [],
      deletedPaths: Array.isArray(args.deleted_paths) ? args.deleted_paths.map(String) : [],
      verificationCommand: optional(args, "verification_command"), verificationExitCode: args.verification_exit_code == null ? undefined : Number(args.verification_exit_code),
      symbols: symbols.length
        ? symbols.slice(0, 2000).map((symbol) => ({ name: String(symbol.name ?? ""), kind: String(symbol.kind ?? "other"), file: String(symbol.file ?? ""), line: Number(symbol.line ?? 1) }))
        : undefined,
    });
  }
  if (name === "get_planning_health") {
    return getPlanningHealth(db, principal, required(args, "project_id"));
  }
  if (name === "get_saved_view") {
    const view = required(args, "view");
    assertSavedViewName(view);
    return getSavedView(db, principal, required(args, "project_id"), view);
  }
  throw toolError("NOT_FOUND", `Unknown tool: ${name}`, 404);
}

function projectBrief(view: ProjectView) {
  const items = view.workItems;
  // Proposals are reported separately from planned work whether or not gating is on: the
  // point of the ladder is that "somebody suggested this" and "we decided to do this" stop
  // looking identical to whoever reads the brief next.
  const proposals = items.filter((item) => item.maturity === "idea" || item.maturity === "proposal");
  const decided = view.project.gateProposals ? items.filter((item) => item.maturity === "accepted" || item.maturity === "committed") : items;
  const nextActions = decided.some((item) => item.status === "blocked")
    ? ["Resolve blockers before creating duplicate work", "Review completion claims and evidence"]
    : ["Claim the highest-priority ready item", "Record new accepted plans"];
  if (proposals.length) nextActions.unshift(`${proposals.length} proposal${proposals.length === 1 ? "" : "s"} await acceptance, so do not treat them as planned work`);
  return {
    project: view.project, revision: view.project.revision,
    active: decided.filter((item) => item.status === "in_progress"),
    ready: decided.filter((item) => item.status === "ready"),
    blocked: decided.filter((item) => item.status === "blocked"),
    review: decided.filter((item) => item.status === "in_review"),
    proposals,
    // Terminal work carrying a reason, so "why isn't this done" has an answer in the brief
    // rather than only in the event log.
    recentlyResolved: items.filter((item) => item.resolution && item.resolution !== "completed").slice(0, 10).map((item) => ({ itemKey: item.itemKey, title: item.title, resolution: item.resolution, reason: item.resolutionReason })),
    recentEvents: view.events.slice(0, 20), sources: view.sources, recommendedNextActions: nextActions,
  };
}

async function resourceList(db: PgD1, principal: Principal) {
  const projects = await listProjects(db, await organizationFor(db, principal));
  return projects.flatMap((project) => [
    { uri: `planbraid://projects/${project.id}/brief`, name: `${project.name} brief`, description: "Current active, ready, blocked, review work and sources", mimeType: "application/json" },
    { uri: `planbraid://projects/${project.id}/active`, name: `${project.name} active work`, description: "Current non-terminal work items", mimeType: "application/json" },
  ]);
}

async function readResource(db: PgD1, principal: Principal, uri: string) {
  const match = /^planbraid:\/\/projects\/([^/]+)\/(brief|active)$/.exec(uri);
  if (!match) throw toolError("NOT_FOUND", "Unknown resource", 404);
  const organizationId = await organizationFor(db, principal);
  const view = await loadProjectView(db, organizationId, match[1], { items: true, events: match[2] === "brief", sources: match[2] === "brief" });
  const value = match[2] === "brief" ? projectBrief(view) : { workItems: view.workItems.filter((item) => !["done", "cancelled"].includes(item.status)) };
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }] };
}

function promptList() {
  return [
    { name: "plan_project_work", title: "Plan project work", description: "Read current work, avoid duplicates, and record an accepted plan", arguments: [{ name: "project_id", required: true }] },
    { name: "handoff_work", title: "Handoff work", description: "Create an evidence-backed cross-agent handoff for one task. For a whole-project handoff, call the get_handoff_package tool instead.", arguments: [{ name: "work_item_id", required: true }] },
    { name: "project_status", title: "Project status", description: "Summarize authoritative current status", arguments: [{ name: "project_id", required: true }] },
  ];
}

function getPrompt(name: string, args?: Json) {
  const projectId = optional(args ?? {}, "project_id") ?? "<project_id>";
  const itemId = optional(args ?? {}, "work_item_id") ?? "<work_item_id>";
  const prompts: Record<string, string> = {
    plan_project_work: `Before planning, call get_planning_context for ${projectId} with your objective in one sentence. It returns what's already done, in progress, blocked, previously rejected, and already proposed but unimplemented; check all of it before proposing anything. Use get_project_brief for the wider status overview. Record accepted tasks with create_work_items and explicit dependencies.`,
    handoff_work: `Read ${itemId}, its events, evidence, dependencies, and source. Report progress, blockers, exact next action, and then sync the current interaction.`,
    project_status: `Read project ${projectId}. Summarize active, blocked, review, verified completion, and decisions from authoritative Planbraid data.`,
  };
  if (!prompts[name]) throw toolError("NOT_FOUND", "Unknown prompt", 404);
  return { description: name, messages: [{ role: "user" as const, content: { type: "text" as const, text: prompts[name] } }] };
}

function conciseResult(name: string, result: Json) {
  const serialized = JSON.stringify(result);
  return `${name} succeeded. ${serialized.length > 1800 ? `${serialized.slice(0, 1800)}…` : serialized}`;
}
function required(object: Json, key: string) { const value = object[key]; if (value == null || String(value).trim() === "") throw toolError("VALIDATION_FAILED", `${key} is required`, 422); return String(value); }
function optional(object: Json, key: string) { return object[key] == null ? undefined : String(object[key]); }
// The tools/list schema alone can't force a real description out of a caller: the
// low-level Server never validates arguments against it (only that "arguments" itself
// is an object), so a client that ignores the schema would otherwise sail straight
// through with an empty or one-word placeholder. A length floor can't verify quality,
// but it does reject the laziest failure mode outright instead of only asking nicely.
function detailedDescription(object: Json, key: string) {
  const value = required(object, key);
  if (value.trim().length < 20) throw toolError("VALIDATION_FAILED", `${key} must actually describe the work (what changes, acceptance criteria, known constraints), not a restatement of the title or a placeholder`, 422);
  return value;
}
// update_work_item's description is a genuine partial-update field (omitted means
// "leave it alone"), so this only enforces the same floor when a value is actually
// being set, never presence.
function optionalDetailedDescription(object: Json, key: string) {
  const value = optional(object, key);
  if (value !== undefined && value.trim().length < 20) throw toolError("VALIDATION_FAILED", `${key} must actually describe the work (what changes, acceptance criteria, known constraints), not a restatement of the title or a placeholder`, 422);
  return value;
}
function toolError(code: string, message: string, status = 422) { return Object.assign(new Error(message), { code, status }); }

/** The method name a tool call needs work:read vs work:write for, or the fixed scope a
 * non-tool method needs; used by route.ts's pre-dispatch scope check, which must run
 * before the request reaches the SDK so a 403 carries the original insufficient_scope
 * WWW-Authenticate challenge instead of a generic protocol error. */
export function rpcScope(method: string, toolName?: string) {
  if (["resources/list", "resources/read", "prompts/list", "prompts/get"].includes(method)) return "work:read";
  if (method !== "tools/call") return null;
  return ["resolve_project", "get_project_brief", "list_work_items", "get_work_item", "search_work", "get_ready_work", "get_planning_context", "explain_work_item", "get_handoff_package", "get_saved_view"].includes(toolName ?? "") ? "work:read" : "work:write";
}
