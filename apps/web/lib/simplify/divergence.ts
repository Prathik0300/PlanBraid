/**
 * M17 — divergence detection, `evidence_removed` half.
 *
 * `findPossiblyImplemented` (lib/simplify/analyze.ts) is pure: everything it needs is
 * already sitting in `items` and `evidence`. This one is not, and cannot be — telling
 * "a file was deleted" from "a file was merely edited" needs the deleted-path list M15's
 * `repo_observations` carries (see the bridge hook's `git diff --name-status` change),
 * which is not exposed on `DashboardState` at all, on purpose: it would be a growing
 * per-commit log with no use anywhere else in the product. This module reads it directly,
 * the same way M11's collision.ts and M15's ingest.ts already do.
 *
 * "With file evidence" (roadmap M17) is read literally: a candidate item must already
 * carry `commit`-type evidence (M15's own, computed from a real artifact match), not
 * merely share a text-extracted artifact token with something that got deleted. A
 * deletion only counts if it happened after the *most recent* such evidence — the last
 * confirmed-present moment — not merely after completion.
 */
import type { PgD1 } from "@/db/pg-d1";
import type { WorkItem, DashboardState } from "@/lib/contracts";
import { text, type Row } from "@/lib/read/rows.ts";
import { touchesArtifact } from "@/lib/evidence/ingest.ts";
import type { Finding } from "./analyze.ts";

type Evidence = DashboardState["evidence"];

export async function findEvidenceRemoved(db: PgD1, organizationId: string, projectId: string, items: WorkItem[], evidence: Evidence): Promise<Finding[]> {
  const doneById = new Map(items.filter((item) => item.status === "done").map((item) => [item.id, item]));
  if (!doneById.size) return [];

  // The most recent commit-evidence timestamp per item: a deletion only matters if it
  // happened after the last confirmed-present moment, not merely after item.completedAt,
  // which says when the claim was made, not when the file was last actually observed.
  const lastConfirmedAt = new Map<string, string>();
  for (const entry of evidence) {
    if (entry.type !== "commit" || !doneById.has(entry.workItemId)) continue;
    const existing = lastConfirmedAt.get(entry.workItemId);
    if (!existing || entry.createdAt > existing) lastConfirmedAt.set(entry.workItemId, entry.createdAt);
  }
  if (!lastConfirmedAt.size) return [];

  const [artifactRows, observationRows] = await db.batch([
    db.prepare("SELECT work_item_id, artifact FROM work_item_artifacts WHERE project_id = ? AND organization_id = ? AND work_item_id = ANY(?::text[])")
      .bind(projectId, organizationId, [...lastConfirmedAt.keys()]),
    db.prepare("SELECT deleted_paths, created_at FROM repo_observations WHERE project_id = ? AND organization_id = ? AND deleted_paths <> '[]'").bind(projectId, organizationId),
  ]);
  if (!observationRows.results.length) return [];

  const artifactsByItem = new Map<string, string[]>();
  for (const row of artifactRows.results as Row[]) {
    const workItemId = text(row, "work_item_id");
    artifactsByItem.set(workItemId, [...(artifactsByItem.get(workItemId) ?? []), text(row, "artifact")]);
  }

  const deletions: Array<{ path: string; createdAt: string }> = [];
  for (const row of observationRows.results as Row[]) {
    const paths = JSON.parse(text(row, "deleted_paths")) as string[];
    const createdAt = text(row, "created_at");
    for (const path of paths) deletions.push({ path, createdAt });
  }

  const findings: Finding[] = [];
  for (const [itemId, confirmedAt] of lastConfirmedAt) {
    const item = doneById.get(itemId)!;
    const artifacts = artifactsByItem.get(itemId) ?? [];
    if (!artifacts.length) continue;
    const removed = deletions.filter((deletion) => deletion.createdAt > confirmedAt && artifacts.some((artifact) => touchesArtifact(deletion.path, artifact)));
    if (!removed.length) continue;
    const paths = [...new Set(removed.map((entry) => entry.path))];
    findings.push({
      kind: "evidence_removed",
      dedupeKey: `evidence_removed:${itemId}`,
      workItemId: itemId,
      verdict: "informational",
      reason: `${item.itemKey} is marked done, but a later commit removed ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}`,
      detail: "The file(s) this item's evidence pointed to no longer exist under that name. Confirm the work still stands, or reopen it.",
      proposedCommand: {
        action: "transition_item", projectId: item.projectId, itemId, expectedVersion: item.version,
        status: "ready", reason: `Evidence removed: ${paths.slice(0, 3).join(", ")} no longer exists`, idempotencyKey: `simplify-evidence-removed-${itemId}`,
      },
    });
  }
  return findings;
}
