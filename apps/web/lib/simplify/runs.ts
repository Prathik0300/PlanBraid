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
import { analyzeProject, type Finding } from "./analyze.ts";

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
  const findings = analyzeProject({ items, dependencies });

  const ready = await getReadyWork(db, principal, { projectId: input.projectId, limit: 3, avoidCollisions: false });
  for (const entry of ready.workItems as Array<WorkItem & { unlockCount: number; reason: string }>) {
    // Only worth saying when finishing it actually frees something; otherwise "do this
    // first" is just restating that the board has a ready column.
    if (!entry.unlockCount) continue;
    findings.push({
      kind: "do_first",
      dedupeKey: `do_first:${entry.id}`,
      workItemId: entry.id,
      verdict: "informational",
      reason: `Do ${entry.itemKey} first`,
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

export async function dismissSimplificationFinding(db: PgD1, principal: Principal, input: { findingId: string }) {
  const organizationId = await organizationFor(db, principal);
  const updated = await db.prepare("UPDATE simplification_findings SET status = 'dismissed' WHERE id = ? AND organization_id = ? AND status = 'open' RETURNING id")
    .bind(input.findingId, organizationId).first<{ id: string }>();
  if (!updated) throw Object.assign(new Error("Finding not found"), { code: "NOT_FOUND", status: 404 });
  return { findingId: input.findingId, status: "dismissed" as const };
}
