/**
 * Persisting and applying a Simplify pass.
 *
 * The analysis itself lives in ./analyze.ts and stays pure; this is the thin layer that
 * gives it a database. Findings are stored rather than computed-and-discarded for two
 * reasons: a connected agent contributes to the same run on its next turn, and applying
 * one later has to be auditable.
 */

import type { PgD1 } from "@/db/pg-d1";
import type { Command, WorkItem } from "@/lib/contracts";
import { executeCommand, getReadyWork, loadDashboard, organizationFor, type Principal } from "@/lib/store";
import { providerFamily } from "@/lib/providers.ts";
import { captureLabelStatement, snapshotAdjudication } from "@/lib/dedup/labels.ts";
import { analyzeProject, pairKey, type Finding, type FindingKind } from "./analyze.ts";
import { findEvidenceRemoved } from "./divergence.ts";

type Row = Record<string, unknown>;

export type StoredFinding = Finding & {
  id: string;
  runId: string;
  origin: string;
  agreedBy: string[];
  status: "open" | "applied" | "dismissed";
};

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function mapFinding(row: Row): StoredFinding {
  const command = row.proposed_command ? JSON.parse(String(row.proposed_command)) as Command : undefined;
  return {
    id: String(row.id),
    runId: String(row.run_id),
    kind: String(row.kind) as Finding["kind"],
    dedupeKey: String(row.dedupe_key),
    workItemId: String(row.work_item_id ?? ""),
    relatedWorkItemId: row.related_work_item_id ? String(row.related_work_item_id) : undefined,
    verdict: String(row.verdict) as Finding["verdict"],
    reason: String(row.reason ?? ""),
    detail: String(row.detail ?? ""),
    proposedCommand: command,
    origin: String(row.origin ?? "matcher"),
    agreedBy: JSON.parse(String(row.agreed_by ?? "[]")) as string[],
    status: String(row.status ?? "open") as StoredFinding["status"],
  };
}

async function ownedProject(db: PgD1, organizationId: string, projectId: string) {
  const project = await db.prepare("SELECT id FROM projects WHERE id = ? AND organization_id = ?").bind(projectId, organizationId).first<{ id: string }>();
  if (!project) throw Object.assign(new Error("Project not found"), { code: "NOT_FOUND", status: 404 });
  return project;
}

/**
 * Runs the structural pass and stores the result as a new run.
 *
 * "Do first" is appended here rather than inside analyze.ts because getReadyWork needs
 * the database and already encodes the ranking (unlock count, then priority, then
 * corroboration). Recomputing it in the pure module would be a second ranking free to
 * disagree with the one agents get from get_ready_work.
 */
export async function createSimplificationRun(db: PgD1, principal: Principal, input: { projectId: string }) {
  const organizationId = await organizationFor(db, principal);
  await ownedProject(db, organizationId, input.projectId);

  const state = await loadDashboard(db, principal);
  const items = state.workItems.filter((item) => item.projectId === input.projectId);
  // Dashboard edges carry no project id, so scope them by membership instead: an edge
  // belongs to this pass only when both ends are items in this project.
  const itemIds = new Set(items.map((item) => item.id));
  const dependencies = state.dependencies.filter((edge) => itemIds.has(edge.fromWorkItemId) && itemIds.has(edge.toWorkItemId));
  // Aliases and evidence carry no project id either, scoped the same way as dependencies:
  // by membership in this project's items. Sources and events do carry project_id directly.
  const aliases = state.aliases.filter((alias) => itemIds.has(alias.workItemId));
  const evidence = state.evidence.filter((entry) => itemIds.has(entry.workItemId));
  const sources = state.sources.filter((source) => source.projectId === input.projectId);
  // loadDashboard's `events` is capped at 250 rows for the whole organization, which is
  // fine for the activity stream but wrong here: findPlanningLoops needs to know whether a
  // `work_item.started` event *ever* fired for an old, quiet item, and that event is
  // exactly the kind likely to have scrolled out of a 250-row window. Fetched directly and
  // unbounded, scoped to this project.
  const startedRows = await db.prepare("SELECT work_item_id FROM work_events WHERE project_id = ? AND organization_id = ? AND event_type = 'work_item.started'").bind(input.projectId, organizationId).all<{ work_item_id: string }>();
  const events = startedRows.results.map((row) => ({ eventType: "work_item.started", workItemId: row.work_item_id } as (typeof state.events)[number]));
  const findings = analyzeProject({ items, dependencies, aliases, sources, events, evidence });
  // findPossiblyImplemented lives in analyzeProject itself (pure, needs only items+evidence);
  // findEvidenceRemoved needs repo_observations' deleted-path list directly, which is not
  // part of DashboardState, so it runs here alongside do_first as the other DB-backed pass.
  findings.push(...await findEvidenceRemoved(db, organizationId, input.projectId, items, evidence));

  const ready = await getReadyWork(db, principal, { projectId: input.projectId, limit: 3, avoidCollisions: false });
  for (const entry of ready.workItems as Array<WorkItem & { unlockCount: number; reason: string }>) {
    // Only worth saying when finishing it actually frees something; otherwise "do this
    // first" is just restating that the board has a ready column.
    if (!entry.unlockCount) continue;
    // Up to 3 of these can be open findings at once, and none of them has a dependency
    // on the others (getReadyWork already excludes anything blocked) — they are
    // independent starting points, not competing claims to be done "first". Naming
    // each one "first" produced multiple do_first cards each telling the user to start
    // there, which reads as contradictory rather than as a set of options.
    findings.push({
      kind: "do_first",
      dedupeKey: `do_first:${entry.id}`,
      workItemId: entry.id,
      verdict: "informational",
      reason: `${entry.itemKey} is ready to start`,
      detail: entry.reason,
    });
  }

  const runId = id("run");
  const statements = [
    db.prepare("INSERT INTO simplification_runs (id, organization_id, project_id, status, requested_by) VALUES (?, ?, ?, 'open', ?)")
      .bind(runId, organizationId, input.projectId, principal.displayName),
    ...findings.map((finding) => db.prepare(
      "INSERT INTO simplification_findings (id, run_id, organization_id, project_id, kind, work_item_id, related_work_item_id, verdict, reason, detail, proposed_command, origin, agreed_by, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'matcher', '[]', ?) ON CONFLICT (run_id, dedupe_key) DO NOTHING",
    ).bind(
      id("fnd"), runId, organizationId, input.projectId, finding.kind, finding.workItemId || null,
      finding.relatedWorkItemId ?? null, finding.verdict, finding.reason.slice(0, 500), finding.detail.slice(0, 1000),
      finding.proposedCommand ? JSON.stringify(finding.proposedCommand) : null, finding.dedupeKey,
    )),
  ];
  await db.batch(statements);
  return readSimplificationRun(db, principal, { runId });
}

/** The newest run for a project, or a specific one by id. */
export async function readSimplificationRun(db: PgD1, principal: Principal, input: { runId?: string; projectId?: string }) {
  const organizationId = await organizationFor(db, principal);
  const run = input.runId
    ? await db.prepare("SELECT * FROM simplification_runs WHERE id = ? AND organization_id = ?").bind(input.runId, organizationId).first<Row>()
    : await db.prepare("SELECT * FROM simplification_runs WHERE project_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1").bind(input.projectId, organizationId).first<Row>();
  if (!run) return null;
  const rows = await db.prepare("SELECT * FROM simplification_findings WHERE run_id = ? AND organization_id = ? ORDER BY created_at").bind(String(run.id), organizationId).all<Row>();
  return {
    id: String(run.id),
    projectId: String(run.project_id),
    status: String(run.status),
    requestedBy: String(run.requested_by),
    createdAt: String(run.created_at),
    findings: rows.results.map(mapFinding),
  };
}

/**
 * Applies one finding by running the command it proposed, through the same
 * executeCommand path everything else uses. A finding with no command is informational
 * and cannot be applied.
 */
export async function applySimplificationFinding(db: PgD1, principal: Principal, input: { findingId: string }) {
  const organizationId = await organizationFor(db, principal);
  const row = await db.prepare("SELECT * FROM simplification_findings WHERE id = ? AND organization_id = ?").bind(input.findingId, organizationId).first<Row>();
  if (!row) throw Object.assign(new Error("Finding not found"), { code: "NOT_FOUND", status: 404 });
  const finding = mapFinding(row);
  if (finding.status !== "open") return { findingId: finding.id, status: finding.status, alreadyResolved: true };
  if (!finding.proposedCommand) throw Object.assign(new Error("This finding is informational and has nothing to apply"), { code: "VALIDATION_FAILED", status: 422 });

  const result = await executeCommand(db, principal, finding.proposedCommand);
  await db.prepare("UPDATE simplification_findings SET status = 'applied' WHERE id = ? AND organization_id = ?").bind(finding.id, organizationId).run();
  return { findingId: finding.id, status: "applied" as const, result };
}

/** Finding kinds the structural pass pairs two items for — the same set analyze.ts's own
 * findDuplicates/findRedundantAgainstDone route through pairKey. Everything else is keyed
 * by a single work item. */
const PAIRED_KINDS = new Set<FindingKind>(["duplicate", "possible_duplicate", "redundant_done", "conflicting_work"]);

/**
 * The dedupe key a reported finding would carry if the structural pass had found it,
 * so an agent's report of an *existing* structural finding lands on the exact same row
 * (via `UNIQUE(run_id, dedupe_key)`) instead of creating a look-alike beside it.
 */
function reportedFindingKey(kind: FindingKind, workItemId: string, relatedWorkItemId?: string) {
  if (PAIRED_KINDS.has(kind) && relatedWorkItemId) return pairKey(kind, workItemId, relatedWorkItemId);
  return `${kind}:${workItemId}`;
}

/**
 * Lets a connected agent corroborate an existing finding, or flag something the
 * structural pass did not — the design `db/setup.ts`'s schema comment described and
 * nothing implemented (finding F10).
 *
 * Two paths, and only one of them can touch a live command:
 *  - The computed key matches an open finding on the project's current run: this is
 *    corroboration. The agent's provider family is added to `agreed_by`; nothing else
 *    about the finding changes, and in particular its `proposedCommand` is untouched —
 *    corroboration is agreement, not an escalation of authority.
 *  - No match: a new finding is stored with `origin: 'agent'` and no `proposedCommand`
 *    at all, ever, regardless of what the caller passes. Only the structural matcher's
 *    own vetted rules may hand a person something to click; an agent's free-form report
 *    is evidence for a person to weigh, exactly like every other 'possible' verdict in
 *    this pipeline.
 */
export async function reportSimplificationFinding(
  db: PgD1,
  principal: Principal,
  input: { projectId: string; kind: FindingKind; workItemId: string; relatedWorkItemId?: string; reason: string; detail?: string; sourceId?: string },
) {
  const organizationId = await organizationFor(db, principal);
  await ownedProject(db, organizationId, input.projectId);

  const source = input.sourceId ? await db.prepare("SELECT provider FROM sources WHERE id = ? AND organization_id = ?").bind(input.sourceId, organizationId).first<{ provider: string }>() : null;
  // Family, not the raw provider string or account: two logins for one model agreeing
  // with itself is not independent corroboration, matching how getReadyWork already
  // counts proposing agents.
  const family = source ? providerFamily(source.provider) : "unknown";

  // Corroboration targets the project's current run — the same one a person's own Simplify
  // press produced — because that is the only row a matching dedupe_key can land on
  // (UNIQUE(run_id, dedupe_key) is scoped per run). If the project has never had one, a
  // real structural pass is run first so the agent's report lands beside a full analysis
  // instead of alone in an otherwise-empty run.
  let run = await readSimplificationRun(db, principal, { projectId: input.projectId });
  if (!run) run = await createSimplificationRun(db, principal, { projectId: input.projectId });
  if (!run) throw Object.assign(new Error("Could not open a Simplify run for this project"), { code: "INTERNAL_ERROR", status: 500 });

  // `UNIQUE(run_id, dedupe_key)` has no status in it, so at most one row for this pair can
  // ever exist in this run regardless of whether it is open, applied, or dismissed — the
  // lookup has to check every status, not just open ones, or an insert against an
  // already-resolved row would silently collide with `ON CONFLICT DO NOTHING` and this
  // function would misreport a no-op as a fresh "created" finding.
  const dedupeKey = reportedFindingKey(input.kind, input.workItemId, input.relatedWorkItemId);
  const existing = run.findings.find((finding) => finding.dedupeKey === dedupeKey);
  if (existing && existing.status !== "open") {
    return { findingId: existing.id, status: "already_resolved" as const, resolution: existing.status, agreedBy: existing.agreedBy };
  }
  if (existing) {
    if (existing.agreedBy.includes(family)) return { findingId: existing.id, status: "already_corroborated" as const, agreedBy: existing.agreedBy };
    const agreedBy = [...existing.agreedBy, family];
    await db.prepare("UPDATE simplification_findings SET agreed_by = ? WHERE id = ? AND organization_id = ?").bind(JSON.stringify(agreedBy), existing.id, organizationId).run();
    return { findingId: existing.id, status: "corroborated" as const, agreedBy };
  }

  const findingId = id("fnd");
  const reason = input.reason.trim().slice(0, 500) || "Flagged by a connected agent";
  const detail = (input.detail ?? "").trim().slice(0, 1000);
  const inserted = await db.prepare(
    "INSERT INTO simplification_findings (id, run_id, organization_id, project_id, kind, work_item_id, related_work_item_id, verdict, reason, detail, proposed_command, origin, agreed_by, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, 'possible', ?, ?, NULL, 'agent', ?, ?) ON CONFLICT (run_id, dedupe_key) DO NOTHING RETURNING id",
  ).bind(findingId, run.id, organizationId, input.projectId, input.kind, input.workItemId || null, input.relatedWorkItemId ?? null, reason, detail, JSON.stringify([family]), dedupeKey).first<{ id: string }>();
  if (inserted) return { findingId: inserted.id, status: "created" as const, agreedBy: [family] };

  // Lost the insert race to a concurrent report with the same key (or the `existing`
  // lookup above ran against a stale in-memory snapshot of the run). Re-read and recurse
  // once rather than guessing at what landed; the second pass sees the real row and takes
  // whichever branch above actually applies to it.
  const winner = await db.prepare("SELECT id FROM simplification_findings WHERE run_id = ? AND dedupe_key = ? AND organization_id = ?").bind(run.id, dedupeKey, organizationId).first<{ id: string }>();
  if (!winner) throw Object.assign(new Error("Could not report this finding"), { code: "INTERNAL_ERROR", status: 500 });
  const winnerRow = await db.prepare("SELECT * FROM simplification_findings WHERE id = ?").bind(winner.id).first<Row>();
  const winnerFinding = mapFinding(winnerRow!);
  if (winnerFinding.status !== "open") return { findingId: winnerFinding.id, status: "already_resolved" as const, resolution: winnerFinding.status, agreedBy: winnerFinding.agreedBy };
  if (winnerFinding.agreedBy.includes(family)) return { findingId: winnerFinding.id, status: "already_corroborated" as const, agreedBy: winnerFinding.agreedBy };
  const agreedBy = [...winnerFinding.agreedBy, family];
  await db.prepare("UPDATE simplification_findings SET agreed_by = ? WHERE id = ? AND organization_id = ?").bind(JSON.stringify(agreedBy), winnerFinding.id, organizationId).run();
  return { findingId: winnerFinding.id, status: "corroborated" as const, agreedBy };
}

/** Finding kinds whose dismissal means "these are not the same work" — the pair semantics
 * a reconciliation label needs. Every other kind (blocked_chain, cycle, stale, ...) has no
 * "same work" pair to label at all, and dismissing one says nothing about the matcher. */
const DUPLICATE_SHAPED_KINDS = new Set(["duplicate", "possible_duplicate", "redundant_done"]);

export async function dismissSimplificationFinding(db: PgD1, principal: Principal, input: { findingId: string }) {
  const organizationId = await organizationFor(db, principal);
  const row = await db.prepare("SELECT * FROM simplification_findings WHERE id = ? AND organization_id = ? AND status = 'open'").bind(input.findingId, organizationId).first<Row>();
  if (!row) throw Object.assign(new Error("Finding not found"), { code: "NOT_FOUND", status: 404 });
  const finding = mapFinding(row);

  const statements = [
    db.prepare("UPDATE simplification_findings SET status = 'dismissed' WHERE id = ? AND organization_id = ?").bind(input.findingId, organizationId),
  ];
  // E0's golden set, at weaker confidence than an explicit split: "keep both" is a real
  // negative signal, but a dismissal can also just mean "not worth my time right now"
  // rather than a considered "these are different" — see lib/dedup/labels.ts.
  if (DUPLICATE_SHAPED_KINDS.has(finding.kind) && finding.relatedWorkItemId) {
    const [leftRow, rightRow] = await db.batch([
      db.prepare("SELECT title, description FROM work_items WHERE id = ? AND organization_id = ?").bind(finding.workItemId, organizationId),
      db.prepare("SELECT title, description FROM work_items WHERE id = ? AND organization_id = ?").bind(finding.relatedWorkItemId, organizationId),
    ]);
    const left = (leftRow.results as Row[])[0];
    const right = (rightRow.results as Row[])[0];
    if (left && right) {
      statements.push(captureLabelStatement(db, {
        organizationId, projectId: String(row.project_id),
        leftItemId: finding.workItemId, rightItemId: finding.relatedWorkItemId,
        verdict: "different", confidence: "weak", source: "dismissal",
        adjudication: snapshotAdjudication({ title: String(left.title ?? ""), description: String(left.description ?? "") }, { title: String(right.title ?? ""), description: String(right.description ?? "") }),
      }));
    }
  }
  await db.batch(statements);
  return { findingId: input.findingId, status: "dismissed" as const };
}
