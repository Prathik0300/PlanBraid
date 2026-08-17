import { waitUntil } from "@vercel/functions";
import type { PgD1 } from "@/db/pg-d1";
import { ensureSchema } from "@/db/setup";
import type { WorkStatus } from "@/lib/contracts";
import { createWorkItemsDeduplicated, executeCommand, findMatchingProject, getReadyWork, organizationFor, principalFromBearer, recordInteraction, registerSourceSession, startWork, updateSourceHeartbeat, type Principal } from "@/lib/store";
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
import { getSavedView, SAVED_VIEWS, assertSavedViewName } from "@/lib/planning/views.ts";
import { ANNOTATION_EDGE_TYPES, DAG_EDGE_TYPES } from "@/lib/graph/edges.ts";
import { agentAccountKey, normalizeAccountLabel } from "@/lib/providers.ts";
import { dispatchNotification, type PushEnvironment } from "@/lib/push";
import { oauthChallenge } from "@/lib/oauth";
import { env as runtimeEnv } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";

type Env = PushEnvironment & { DB: PgD1 };
type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type Json = Record<string, unknown>;

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"];

const tools = [
  { name: "resolve_project", description: "Resolve the canonical Planbraid project for the work at hand. Always call this first, passing this session's absolute working directory and the repository's git remote when you have them: those identify a project exactly, while a name alone can miss and lead to a duplicate.", inputSchema: { type: "object", properties: { project_id: { type: "string" }, query: { type: "string" }, directory: { type: "string", description: "Absolute path of the current working directory." }, git_remote: { type: "string", description: "The repository's origin remote, in any form; git@ and .git spellings are normalized." } } } },
  { name: "create_project", description: "Create a Planbraid project for a repository or initiative. Pass directory and git_remote whenever you have them: proposals are matched against existing projects first, so calling this for a repository someone already set up in the web UI returns that project (status 'matched') rather than creating a duplicate. Check the returned status and use the returned project_id either way.", inputSchema: { type: "object", required: ["name", "idempotency_key"], properties: { name: { type: "string" }, directory: { type: "string", description: "Absolute path of the repository or working directory this project tracks, for example /Users/you/Projects/my-app." }, description: { type: "string" }, git_remote: { type: "string", description: "Canonical remote URL, for example https://github.com/owner/repo." }, idempotency_key: { type: "string" } } } },
  { name: "update_project", description: "Update a project's details. Use this to bind your absolute working directory to a project that was created in the web UI without one: a project with no directory cannot be matched to this repository by future sessions. Omitted fields are left unchanged.", inputSchema: { type: "object", required: ["project_id", "idempotency_key"], properties: { project_id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, directory: { type: "string", description: "Absolute path of the working directory this project tracks." }, git_remote: { type: "string" }, idempotency_key: { type: "string" } } } },
  { name: "get_project_brief", description: "Get compact current project context: active, ready, blocked, review, recent events, sources, and recommended next actions.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" }, focus: { type: "string" } } } },
  { name: "list_work_items", description: "List current project work with structured status/source filters.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" }, status: { type: "string" }, source_id: { type: "string" }, query: { type: "string" }, limit: { type: "number" } } } },
  { name: "get_ready_work", description: "Get work that is actually actionable right now: unblocked by dependencies, not claimed by another active session, ranked by how much finishing it unlocks. Prefer this over list_work_items when deciding what to work on next.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" }, source_id: { type: "string", description: "This session's source ID. Excludes work already claimed by other active sessions; does not exclude this session's own claims." }, limit: { type: "number", description: "Defaults to 5." }, avoid_collisions: { type: "boolean", description: "Defaults to true. Set false to see all unblocked work regardless of other sessions' claims." } } } },
  { name: "get_work_item", description: "Get one work item with source, evidence, dependencies, and recent events.", inputSchema: { type: "object", required: ["work_item_id"], properties: { work_item_id: { type: "string" } } } },
  { name: "create_work_items", description: "Propose one or more work items in one operation. Proposals are matched against work the project already has: a restatement of existing work returns that item's ID instead of creating a duplicate, so always use the returned workItemId rather than assuming a new item was created. Check each result's status field (created, matched, or uncertain) and any warning before starting work. When a created item is a subset, superset, or overlap of existing work, or naturally follows it, the result's relation field says so and a real link is recorded automatically; when it directly conflicts with existing work (opposite intent, same concrete file or endpoint), a decision is also raised for a person to resolve: check for a relation field with type CONFLICT and a decision field in the result. When a match is genuinely ambiguous, the result carries needsJudgment (also collected at the top level): answer it with submit_reconciliation_judgment if you can tell from the repository, naming what settles it.", inputSchema: { type: "object", required: ["project_id", "items", "idempotency_key"], properties: { project_id: { type: "string" }, source_id: { type: "string" }, import_request_id: { type: "string", description: "Set this when reporting your full local plan in response to a pending import request (surfaced by register_agent_session), so Planbraid can mark that request complete. Omit otherwise." }, idempotency_key: { type: "string" }, items: { type: "array", maxItems: 50, items: { type: "object", required: ["title"], properties: { ref: { type: "string", description: "Optional caller-chosen handle echoed back in the result, for correlating proposals with outcomes." }, title: { type: "string" }, description: { type: "string" }, status: { type: "string" }, priority: { type: "string" }, depends_on: { type: "array", items: { type: "string" }, description: "IDs of prerequisite tasks: this item cannot start until each one is done. Each entry is either another item's ref from this same call, or the work_item_id of a task that already exists." } } } } } } },
  { name: "accept_work_items", description: "Record that the user accepted proposed work, naming who decided. Work you propose is recorded as a proposal, not as an accepted plan; this is how a proposal becomes real work. Only call it when the user actually said so in this conversation; an acceptance you report is stored as their statement, attributed to them.", inputSchema: { type: "object", required: ["project_id", "work_item_ids", "stated_by", "idempotency_key"], properties: { project_id: { type: "string" }, work_item_ids: { type: "array", items: { type: "string" }, maxItems: 100 }, stated_by: { type: "string", description: "Who accepted this, as they identify themselves. Required: an acceptance with nobody behind it is not an acceptance." }, reason: { type: "string" }, source_id: { type: "string" }, idempotency_key: { type: "string" } } } },
  { name: "update_work_item", description: "Update descriptive fields using optimistic expected_version concurrency.", inputSchema: { type: "object", required: ["project_id", "work_item_id", "expected_version", "idempotency_key"], properties: { project_id: { type: "string" }, work_item_id: { type: "string" }, expected_version: { type: "number" }, source_id: { type: "string" }, title: { type: "string" }, description: { type: "string" }, priority: { type: "string" }, assignee: { type: ["string", "null"] }, idempotency_key: { type: "string" } } } },
  { name: "start_work", description: "Atomically claim/start ready work and attribute it to this source session. Takes an exclusive lease: fails with WORK_LEASED (409) naming the current holder if another live session already holds one, unless force is set.", inputSchema: { ...transitionSchema(), properties: { ...transitionSchema().properties, force: { type: "boolean", description: "Override another live session's lease and take it over. The takeover is recorded in the transition's own reason." } } } },
  { name: "block_work", description: "Mark work blocked with a structured reason, optionally naming the specific prerequisite tasks it is waiting on.", inputSchema: { ...transitionSchema(), properties: { ...transitionSchema().properties, blocker_work_item_ids: { type: "array", items: { type: "string" }, description: "IDs of tasks that must complete before this one can proceed. A 'blocks' dependency edge is recorded from each one to this task." } }, required: ["project_id", "work_item_id", "expected_version", "reason", "idempotency_key"] } },
  { name: "link_work_items", description: "Declare a relationship between two work items: an ordering dependency (one blocks or is required by the other) or a non-ordering annotation (related, duplicate, superseded). Name fields for role, not position: the prerequisite is the task that must happen first.", inputSchema: { type: "object", required: ["project_id", "prerequisite_work_item_id", "dependent_work_item_id", "idempotency_key"], properties: { project_id: { type: "string" }, prerequisite_work_item_id: { type: "string", description: "The task that must be resolved first." }, dependent_work_item_id: { type: "string", description: "The task that is waiting on the prerequisite." }, type: { type: "string", enum: [...DAG_EDGE_TYPES, ...ANNOTATION_EDGE_TYPES], description: "Defaults to 'blocks'. Use 'requires' for a soft dependency, or an annotation type ('relates_to', 'duplicates', 'supersedes') for a non-ordering relationship." }, reason: { type: "string" }, source_id: { type: "string" }, idempotency_key: { type: "string" } } } },
  { name: "report_progress", description: "Append a concise, durable progress update without replacing task description.", inputSchema: { type: "object", required: ["project_id", "work_item_id", "summary", "idempotency_key"], properties: { project_id: { type: "string" }, work_item_id: { type: "string" }, source_id: { type: "string" }, summary: { type: "string" }, idempotency_key: { type: "string" } } } },
  { name: "report_completion", description: "Report implementation completion with evidence. This always lands the item in review, not done: reaching done requires either a person's decision or evidence this call attached (or that already existed on the item, for example from a repository observation) actually being machine-verified. There is no way to mark your own claim verified from this call: that flag was removed because nothing checked it.", inputSchema: { type: "object", required: ["project_id", "work_item_id", "expected_version", "summary", "idempotency_key"], properties: { project_id: { type: "string" }, work_item_id: { type: "string" }, expected_version: { type: "number" }, source_id: { type: "string" }, summary: { type: "string" }, evidence: { type: "array", maxItems: 20, items: { type: "object", properties: { type: { type: "string" }, label: { type: "string" }, uri: { type: "string" }, result: { type: "string" } } } }, idempotency_key: { type: "string" } } } },
  { name: "reopen_work", description: "Reopen completed/review work with a reason and current expected version.", inputSchema: { ...transitionSchema(), required: ["project_id", "work_item_id", "expected_version", "reason", "idempotency_key"] } },
  { name: "register_agent_session", description: "Register or resume any MCP client, agent, or personal-model session and return a stable Planbraid source ID. The response may include pendingImportRequest if the user has asked this specific agent, from the website, to report everything it knows about the project - when present, read your full local task list or plan for this project and report it in one create_work_items call with import_request_id set to its id.", inputSchema: { type: "object", required: ["project_id", "provider", "external_session_id"], properties: { project_id: { type: "string" }, provider: { type: "string", description: "Free-form client, agent, or provider name; for example codex, local-llama, or my-personal-agent." }, external_session_id: { type: "string", description: "Stable conversation or session identifier from the connecting client." }, title: { type: "string" }, model: { type: "string", description: "Optional free-form model name or identifier." }, account_label: { type: "string", description: "Optional. Which of the user's logins for this model you are running as, when you know it (for example 'work'). Ignored when the connection already identifies its account, which is the normal case - do not invent a value." }, coding_space_id: { type: "string" }, assurance: { type: "string" } } } },
  { name: "begin_interaction", description: "Record the start of one user-prompt/agent-turn interaction.", inputSchema: interactionSchema("started") },
  { name: "sync_interaction", description: "Close and reconcile an agent interaction after task lifecycle tools have been called. Creates one durable notification.", inputSchema: interactionSchema("completed") },
  { name: "heartbeat_agent_session", description: "Refresh active source presence and current task claims.", inputSchema: { type: "object", required: ["source_id"], properties: { source_id: { type: "string" }, state: { type: "string" }, current_task_ids: { type: "array", items: { type: "string" } } } } },
  { name: "end_agent_session", description: "Close source presence without deleting its history.", inputSchema: { type: "object", required: ["source_id"], properties: { source_id: { type: "string" } } } },
  { name: "search_work", description: "Search task IDs, titles, and descriptions across authorized projects.", inputSchema: { type: "object", required: ["query"], properties: { project_id: { type: "string" }, query: { type: "string" }, limit: { type: "number" } } } },
  { name: "report_simplify_finding", description: "Corroborate or report a plan-review finding: a duplicate, a task already covered by finished work, work that conflicts with something else in progress, a stale proposal, or something you noticed that doesn't fit those. If another agent or the structural review already flagged the same thing, this adds your agreement to it instead of creating a second entry, and is safe to call more than once: it never double-counts your own agreement. Never proposes an action on its own; a person still decides whether anything changes.", inputSchema: { type: "object", required: ["project_id", "kind", "work_item_id", "reason"], properties: { project_id: { type: "string" }, kind: { type: "string", enum: ["duplicate", "possible_duplicate", "redundant_done", "conflicting_work", "blocked_chain", "started_while_blocked", "stale", "planning_loop", "possibly_implemented", "evidence_removed", "agent_flagged"], description: "Use agent_flagged for anything that doesn't match one of the structural kinds." }, work_item_id: { type: "string" }, related_work_item_id: { type: "string", description: "The other task, for duplicate, possible_duplicate, redundant_done, and conflicting_work." }, reason: { type: "string" }, detail: { type: "string" }, source_id: { type: "string" } } } },
  { name: "get_handoff_package", description: "Get a full project handoff: verified-complete work you must not redo, unverified completion claims worth checking before trusting, currently active work and who holds it, blocked chains, recently rejected approaches, and ranked next actions. Unlike get_planning_context this is not filtered to one objective; call it when picking up a project cold, at the start of a session, or when a person asks you to summarize where things stand.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" } } } },
  { name: "explain_work_item", description: "Get a causal answer to \"why hasn't this been done\": completed, rejected (with the reason), deferred, blocked by a dependency chain (named down to the root), blocked externally, in progress and by whom, in review awaiting verification, still an unaccepted proposal, or genuinely not started yet. Returns exactly one cause, not a status string.", inputSchema: { type: "object", required: ["work_item_id"], properties: { work_item_id: { type: "string" } } } },
  { name: "get_planning_context", description: "Call this BEFORE planning or proposing new work, not after. Describe what you are about to work on in a sentence; returns what the project already knows that's relevant to it: work already done, in progress and by whom, blocked and why, previously rejected and why, proposals already sitting unimplemented, and anyone currently holding a live claim on a file or symbol you're about to touch even if their task's wording looks unrelated, plus plain guidance built from those facts. This is how you avoid re-proposing something already finished, already rejected, or already being worked on by someone else. Prefer this over get_project_brief when you are about to create work, since the brief is a status overview and this is filtered to what matters for your specific objective.", inputSchema: { type: "object", required: ["project_id", "objective"], properties: { project_id: { type: "string" }, objective: { type: "string", description: "What you are about to plan or propose, in your own words; a sentence is enough." }, source_id: { type: "string" } } } },
  { name: "record_decision", description: "Raise a decision between two or more competing approaches: this project cannot do both, and someone needs to pick. Either an agent or a person can call this to flag one; it does not settle anything on its own. Link each option to the work item it would keep or create with related_work_item_id where you have one, so resolving the decision can act on it. A person resolves it with resolve_decision.", inputSchema: { type: "object", required: ["project_id", "question", "options", "idempotency_key"], properties: { project_id: { type: "string" }, question: { type: "string", description: "The decision to make, as a short question, for example 'REST or GraphQL for the public API?'" }, description: { type: "string" }, options: { type: "array", minItems: 2, maxItems: 10, items: { type: "object", required: ["label"], properties: { label: { type: "string" }, related_work_item_id: { type: "string", description: "The work item this option keeps or represents, if one already exists. Losing this option later cancels that item as superseded." }, rationale: { type: "string" } } } }, source_id: { type: "string" }, idempotency_key: { type: "string" } } } },
  { name: "resolve_decision", description: "Resolve a decision raised with record_decision, choosing one option. Person only: an agent cannot call this. The losing options are marked rejected, and any work item they were linked to is cancelled as superseded, with a supersedes edge back to this decision, so it surfaces later as a rejected approach rather than a live proposal.", inputSchema: { type: "object", required: ["project_id", "decision_work_item_id", "winning_option_id"], properties: { project_id: { type: "string" }, decision_work_item_id: { type: "string" }, winning_option_id: { type: "string" }, resolution_reason: { type: "string" }, source_id: { type: "string" } } } },
  { name: "submit_reconciliation_judgment", description: "Answer a needsJudgment question from create_work_items: with the repository open, you can usually tell better than a structural score whether two tasks are really the same work. justification is required and must name the specific artifact or behavior that settles it (for example \"different: #31 rotates the signing key, this renews the client's token\"): a bare \"same\" or \"different\" is rejected. This records your answer as evidence; it never merges or links anything on its own.", inputSchema: { type: "object", required: ["project_id", "pair_id", "verdict", "justification"], properties: { project_id: { type: "string" }, pair_id: { type: "string", description: "The pairId from the needsJudgment entry you're answering." }, verdict: { type: "string", enum: ["same", "different"] }, justification: { type: "string", description: "Must name a concrete artifact or behavior, not just restate the verdict." }, source_id: { type: "string" } } } },
  { name: "report_repo_state", description: "Report repository state observed at turn end: the commit sha, branch, file paths changed since the merge base, which of those were deleted or renamed away, and the exit status of a verification command if one ran. Paths and commit metadata only, never file contents or diffs. Work items whose known files intersect the changed paths get evidence attached automatically; evidence is only marked verified when a verification command actually ran and passed. Optionally include symbols (function, class, method, interface, type, or enum names with file and line) parsed from the changed TypeScript/JavaScript files, if you have that available: these ground artifact references in real code instead of a guessed name, and feed the reconciliation engine's precision. Safe to call once per commit even across retries or multiple sessions on one branch.", inputSchema: { type: "object", required: ["project_id", "head_sha"], properties: { project_id: { type: "string" }, source_id: { type: "string" }, head_sha: { type: "string" }, branch: { type: "string" }, changed_paths: { type: "array", maxItems: 200, items: { type: "string" }, description: "Repo-relative file paths only, never contents or diffs." }, deleted_paths: { type: "array", maxItems: 200, items: { type: "string" }, description: "The subset of changed_paths that no longer exists under that name (deleted or renamed away)." }, verification_command: { type: "string", description: "The command that was run, for the record. Not executed by Planbraid." }, verification_exit_code: { type: "number", description: "The exit status of that command. 0 marks matched evidence as verified." }, symbols: { type: "array", maxItems: 2000, items: { type: "object", required: ["name", "kind", "file", "line"], properties: { name: { type: "string" }, kind: { type: "string", enum: ["function", "class", "method", "interface", "type", "enum", "other"] }, file: { type: "string" }, line: { type: "number" } } }, description: "Declaration names found in the changed files, TypeScript/JavaScript only. Names and locations, never source text." } } } },
  { name: "get_planning_health", description: "Get the project's planning debt: every open Simplify finding, weighted by kind and ranked heaviest first, plus a 0-100 score derived from that same list. Always read the debt list, not just the score - the score exists to summarize the list, not to replace it, and a person should act on specific entries, not chase a number. Runs a fresh review pass each call, so this always reflects current state.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" } } } },
  { name: "get_saved_view", description: "One of five fixed structured views over project state: 'active' (in-progress work and who holds it), 'blocking_release' (which items are blocking the most other work, ranked), 'keeps_getting_proposed' (planning loops - proposed repeatedly with nothing implemented), 'no_proof' (marked done with nothing verifying it), or 'needs_decision' (open decisions awaiting a person). Structured retrieval only, not a natural-language query - pick the view name that matches what you're asking.", inputSchema: { type: "object", required: ["project_id", "view"], properties: { project_id: { type: "string" }, view: { type: "string", enum: [...SAVED_VIEWS] } } } },
];

function transitionSchema() {
  return { type: "object", required: ["project_id", "work_item_id", "expected_version", "idempotency_key"], properties: { project_id: { type: "string" }, work_item_id: { type: "string" }, expected_version: { type: "number" }, source_id: { type: "string" }, reason: { type: "string" }, idempotency_key: { type: "string" } } };
}

function interactionSchema(event: string) {
  return { type: "object", required: ["project_id", "source_id", "external_interaction_id"], properties: { project_id: { type: "string" }, source_id: { type: "string" }, external_interaction_id: { type: "string" }, sequence: { type: "number" }, outcome: { type: "string" }, summary: { type: "string" }, event: { const: event } } };
}

async function handleMcp(request: Request, env: Env) {
  await ensureSchema(env.DB);
  const url = new URL(request.url);
  // Built from the origin plus a literal path, so the ?agent= marker below never
  // participates in OAuth resource matching.
  const resource = `${url.origin}/mcp`;
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  // How two CLI aliases sharing one credential tell themselves apart: each alias points
  // at .../mcp?agent=<name> in its own MCP config. Purely a label within an
  // already-authenticated account, and grants no access of its own.
  const agentMarker = url.searchParams.get("agent");
  const authorization = request.headers.get("authorization");
  const principal = await principalFromBearer(env.DB, authorization, resource, agentMarker) ?? (local && !authorization ? { userId: "local-demo-user", email: "you@planbraid.local", displayName: normalizeAccountLabel(agentMarker) ?? "Local agent", agentAccountId: agentAccountKey("local-demo", agentMarker) ?? undefined, agentAccountLabel: normalizeAccountLabel(agentMarker) ?? undefined, scopes: ["work:read", "work:write"], authentication: "local" as const } : null);
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
    return rpcResult(rpc.id, { protocolVersion, capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } }, serverInfo: { name: "planbraid", title: "Planbraid - One Plan Across Every Agent", version: "0.1.0", description: "Plans, progress, blockers, and completions braided across any MCP-compatible client or model" }, instructions: "Start with resolve_project to find the project for the current repository or directory; if nothing matches, create_project binds a new one to that directory. If a project matches but has no directory bound (created in the web UI), call update_project once with your absolute working directory so later sessions resolve it automatically. Before proposing or planning new work, call get_planning_context with your objective in a sentence: it surfaces what the project already knows that's relevant to it, so you don't re-propose something already done, already rejected, or already being worked on by someone else. Register this client or model with its own free-form identity; which of the user's accounts you are running as is resolved from the connection itself, so do not guess at one. Record accepted work, start/block/progress/completion changes, and sync every interaction. Work you propose is recorded as a proposal, not as an accepted plan: when the user actually agrees to it, call accept_work_items naming who decided. Completion requires evidence or remains in review. Use get_ready_work, not list_work_items, when deciding what to work on next." });
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
  if (name === "resolve_project") {
    const organizationId = await organizationFor(db, principal);
    const projects = await listProjects(db, organizationId);
    const explicit = args.project_id ? projects.find((project) => project.id === args.project_id) : null;
    if (explicit) return { project: explicit, confidence: "exact" };

    // Identity first: a remote or working directory pins one project exactly, and a
    // bare query string can miss it (".git" suffixes, name casing) and mislead an agent
    // into creating a duplicate.
    const strong = await findMatchingProject(db, organizationId, { directory: optional(args, "directory"), gitRemote: optional(args, "git_remote") });
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
    return loadWorkItemDetail(db, organizationId, required(args, "work_item_id"));
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
        ref: optional(item, "ref"), title: required(item, "title"), description: optional(item, "description"),
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
  if (name === "update_work_item") return executeCommand(db, principal, { action: "update_item", projectId: required(args, "project_id"), itemId: required(args, "work_item_id"), expectedVersion: Number(args.expected_version), sourceId: optional(args, "source_id"), title: optional(args, "title"), description: optional(args, "description"), priority: optional(args, "priority") as never, assignee: args.assignee == null ? args.assignee as null | undefined : String(args.assignee), idempotencyKey: required(args, "idempotency_key") });
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
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }], ttlMs: 15000, cacheScope: "private" };
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
  return ["resolve_project", "get_project_brief", "list_work_items", "get_work_item", "search_work", "get_ready_work", "get_planning_context", "explain_work_item", "get_handoff_package", "get_saved_view"].includes(name) ? "work:read" : "work:write";
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
