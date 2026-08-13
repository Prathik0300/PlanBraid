/**
 * M14 / feature 13 — work overlap detection, v0.
 *
 * "A v0 is nearly free: buildSignature already extracts file paths and symbols from every
 * title and description. Nothing compares them across live claims." This is that
 * comparison: given a proposed title/description, which work items currently held under
 * an active F1 lease (lib/store.ts's work_claims) share a concrete artifact with it.
 *
 * Deliberately narrower than M11's `inProgress` bucket, which ranks by lexical relevance
 * to a stated objective. This asks a cheaper, more mechanical question — "does this touch
 * the same file or symbol someone is holding right now" — independent of whether the
 * objective's wording happens to be similar. The two are complementary, not redundant:
 * a proposal can share zero words with an in-progress item's title and still collide with
 * it on the file it touches.
 */
import { buildSignature } from "@/lib/dedup/signature.ts";
import { text, type Row } from "@/lib/read/rows.ts";
import type { PgD1 } from "@/db/pg-d1";

export type CollisionMatch = {
  workItemId: string;
  itemKey: string;
  title: string;
  sourceId: string;
  heartbeatAt: string;
  sharedArtifacts: string[];
};

export async function checkCollisions(
  db: PgD1, organizationId: string, projectId: string,
  scope: { title: string; description?: string },
  options?: { excludeSourceId?: string },
): Promise<CollisionMatch[]> {
  const signature = buildSignature(scope.title, scope.description ?? "");
  if (!signature.artifacts.length) return [];

  const artifactRows = await db.prepare(
    "SELECT wa.work_item_id, wa.artifact, wi.item_key, wi.title FROM work_item_artifacts wa " +
    "JOIN work_items wi ON wi.id = wa.work_item_id " +
    "WHERE wa.project_id = ? AND wi.organization_id = ? AND wa.artifact = ANY(?::text[]) " +
    "AND EXISTS (SELECT 1 FROM work_claims wc WHERE wc.work_item_id = wi.id AND wc.lease_expires_at > now())",
  ).bind(projectId, organizationId, signature.artifacts).all<Row>();
  if (!artifactRows.results.length) return [];

  const sharedArtifacts = new Map<string, { itemKey: string; title: string; artifacts: Set<string> }>();
  for (const row of artifactRows.results) {
    const workItemId = text(row, "work_item_id");
    const entry = sharedArtifacts.get(workItemId) ?? { itemKey: text(row, "item_key"), title: text(row, "title"), artifacts: new Set<string>() };
    entry.artifacts.add(text(row, "artifact"));
    sharedArtifacts.set(workItemId, entry);
  }

  const workItemIds = [...sharedArtifacts.keys()];
  // A second query rather than folding into the first: joining claims directly would
  // multiply one artifact-match row per concurrent claim on the same item, which is rare
  // (work_claims' unique key is per source, not per item) but real, and picking "the"
  // holder is a separate decision — most recent heartbeat — from finding the overlap.
  const claimRows = await db.prepare(
    "SELECT DISTINCT ON (work_item_id) work_item_id, source_id, heartbeat_at FROM work_claims " +
    "WHERE work_item_id = ANY(?::text[]) AND lease_expires_at > now() ORDER BY work_item_id, heartbeat_at DESC",
  ).bind(workItemIds).all<Row>();

  const matches: CollisionMatch[] = [];
  for (const row of claimRows.results) {
    const workItemId = text(row, "work_item_id");
    const sourceId = text(row, "source_id");
    if (options?.excludeSourceId && sourceId === options.excludeSourceId) continue;
    const entry = sharedArtifacts.get(workItemId);
    if (!entry) continue;
    matches.push({ workItemId, itemKey: entry.itemKey, title: entry.title, sourceId, heartbeatAt: text(row, "heartbeat_at"), sharedArtifacts: [...entry.artifacts] });
  }
  return matches;
}
