/**
 * E1 — blocking rebuild (RECONCILIATION_ARCHITECTURE.md §5).
 *
 * Finding F2 was a correctness bug, not a performance one: candidates used to come from
 * `ORDER BY updated_at DESC LIMIT 500`, which silently drops the candidates worth the most
 * — finished work, which is exactly what sorts last by recency, and matching against it is
 * what prevents redundant work rather than a redundant card. M7 fixed half of this (the
 * artifact index, `lib/dedup/artifacts.ts`) but kept the recency window as a fallback for
 * any proposal that names no concrete artifact.
 *
 * This module removes that fallback entirely and replaces it with a second retriever: a
 * rare-token index over the same stemmed object tokens `buildSignature` already extracts
 * (`lib/dedup/tokens.ts`), fused with the artifact retriever by Reciprocal Rank Fusion
 * (RRF). Recall is the only metric that matters at this stage — a duplicate that never
 * reaches the scorer is invisible forever — so **never filter by status**: done and
 * cancelled items are candidates by design, and age plays no part in retrieval at all.
 *
 * Two retrievers here, a third (vector ANN, E5 — `lib/dedup/embedding-index.ts`) fused in
 * below. Not the full five-retriever design the architecture document's Stage 1 diagram
 * lays out: BM25F full-text and the structural (objective/dependency) retrievers are
 * later stages (E6 onward per §13's build order); adding them here would be building
 * ahead of the milestone that's actually scoped to need them. The embedding retriever is
 * a genuine no-op — contributes nothing to fusion, costs one skipped query, not a slow
 * one — for as long as `token_vectors` stays empty, so its presence here changes nothing
 * about E1's own measured behavior until real distilled weights are loaded.
 */
import type { PgD1, PgD1PreparedStatement } from "@/db/pg-d1";
import type { WorkItem } from "@/lib/contracts";
import { mapItem, text, type Row } from "@/lib/read/rows.ts";
import { buildSignature } from "./signature.ts";
import { artifactsOf, classifyArtifact } from "./artifacts.ts";
import { tokensOf } from "./tokens.ts";
import { retrieveByEmbedding } from "./embedding-index.ts";

/** How many unindexed items one call will backfill. Bounded so importing a large project
 * spreads its indexing over several writes instead of stalling one of them. */
const BACKFILL_BATCH = 200;

/** RRF's damping constant. §5 specifies 60 — high enough that a retriever's #1 and #2
 * results aren't wildly different in weight, which matters here because a candidate
 * found by only one of two retrievers should still compete fairly against one found by
 * both, rather than being crowded out by a single retriever's top pick. */
const RRF_K = 60;

/** Blocking's own budget, independent of any later stage's limit: "take the top 50" per
 * §5, the number the blocking-recall@50 success gate (§13, E1's row) is measured against. */
const TOP_N = 50;

// ── Write-time indexing ──────────────────────────────────────────────────────────────

/**
 * Statements that make both indices match this item's current text. Always a delete
 * followed by inserts, for both tables: an edited title can *drop* an artifact or a token,
 * and an index that only ever grows would keep matching text the item no longer contains.
 * `artifacts_indexed_at` is shared by both indices — see the module note on
 * `backfillBlockingIndex` for why that has to be true for backfill to be correct.
 */
export function blockingIndexStatements(
  db: PgD1,
  input: { organizationId: string; projectId: string; workItemId: string; title: string; description: string; now: string },
): PgD1PreparedStatement[] {
  const artifacts = artifactsOf(input.title, input.description);
  const tokens = tokensOf(input.title, input.description);
  const statements: PgD1PreparedStatement[] = [
    db.prepare("DELETE FROM work_item_artifacts WHERE work_item_id = ? AND project_id = ?").bind(input.workItemId, input.projectId),
  ];
  for (const artifact of artifacts.slice(0, 60)) {
    statements.push(
      db.prepare("INSERT INTO work_item_artifacts (organization_id, project_id, work_item_id, artifact, kind) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project_id, artifact, work_item_id) DO NOTHING")
        .bind(input.organizationId, input.projectId, input.workItemId, artifact.slice(0, 200), classifyArtifact(artifact)),
    );
  }
  statements.push(db.prepare("DELETE FROM work_item_tokens WHERE work_item_id = ? AND project_id = ?").bind(input.workItemId, input.projectId));
  for (const token of tokens.slice(0, 60)) {
    statements.push(
      db.prepare("INSERT INTO work_item_tokens (organization_id, project_id, work_item_id, token) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, token, work_item_id) DO NOTHING")
        .bind(input.organizationId, input.projectId, input.workItemId, token.slice(0, 100)),
    );
  }
  statements.push(db.prepare("UPDATE work_items SET artifacts_indexed_at = ? WHERE id = ?").bind(input.now, input.workItemId));
  return statements;
}

/**
 * Indexes items written before either index existed, or restored after a merge archived
 * them (`split_alias`).
 *
 * Both indices are backfilled together from one query and one shared "already indexed"
 * flag (`artifacts_indexed_at`) — deliberately, not two independent passes each filtering
 * on that same column. Running the artifact and token backfills as separate calls would
 * be a real bug: the first call to complete would stamp `artifacts_indexed_at`, and the
 * second would then find zero rows left to process, silently leaving every pre-existing
 * item's token index empty forever. One query, both indices built from it, one stamp at
 * the end — there is exactly one "has this item been through blocking indexing" fact, and
 * only one write path is allowed to answer it.
 */
export async function backfillBlockingIndex(db: PgD1, organizationId: string, projectId: string): Promise<number> {
  const pending = await db.prepare(
    "SELECT id, title, description FROM work_items WHERE project_id = ? AND organization_id = ? AND artifacts_indexed_at IS NULL ORDER BY updated_at DESC LIMIT ?",
  ).bind(projectId, organizationId, BACKFILL_BATCH).all<{ id: string; title: string; description: string }>();
  if (!pending.results.length) return 0;

  const now = new Date().toISOString();
  const statements: PgD1PreparedStatement[] = [];
  for (const row of pending.results) {
    statements.push(...blockingIndexStatements(db, { organizationId, projectId, workItemId: row.id, title: row.title, description: row.description ?? "", now }));
  }
  await db.batch(statements);
  return pending.results.length;
}

// ── Pure ranking primitives (Reciprocal Rank Fusion) ────────────────────────────────────
//
// Everything below is deliberately free of the database: given the data blocking's
// DB-backed shell already fetched, ranking and fusing candidates is arithmetic, and
// keeping it that way is what makes the RRF math itself directly unit-testable, matching
// the pipeline's own rule that retrieval and scoring stay pure functions wherever the
// database allows it.

export type RankedCandidate = { workItemId: string; score: number };

/**
 * `RRF(d) = Σ 1/(k + rank_r(d))`, summed over whichever retrievers' ranked lists contain
 * `d`. Rank-based on purpose: an artifact-overlap count and a summed-IDF weight live on
 * completely different scales, and RRF is exactly the fusion method that never needs them
 * reconciled — only each retriever's own internal ordering matters.
 */
export function fuseRankings(rankings: string[][], k = RRF_K): RankedCandidate[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((workItemId, index) => {
      const rank = index + 1;
      scores.set(workItemId, (scores.get(workItemId) ?? 0) + 1 / (k + rank));
    });
  }
  return [...scores.entries()]
    .map(([workItemId, score]) => ({ workItemId, score }))
    .sort((a, b) => b.score - a.score || a.workItemId.localeCompare(b.workItemId));
}

/**
 * Ranks candidates by how many artifacts they share with the proposal, most first. Ties
 * break on work item id — deterministic, and deliberately *not* recency: breaking ties by
 * `updated_at` would quietly reintroduce the exact bias F2 exists to remove, just one
 * level down from where it used to live.
 */
export function rankByArtifactOverlap(proposalArtifacts: string[], candidateArtifacts: Map<string, string[]>): string[] {
  const proposalSet = new Set(proposalArtifacts);
  return [...candidateArtifacts.entries()]
    .map(([workItemId, artifacts]) => ({ workItemId, shared: artifacts.filter((artifact) => proposalSet.has(artifact)).length }))
    .filter((entry) => entry.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.workItemId.localeCompare(b.workItemId))
    .map((entry) => entry.workItemId);
}

/**
 * Smoothed IDF, always strictly positive so a token that appears in nearly every item in
 * the project still contributes a small amount of weight rather than zero or negative —
 * negative weight would let a common word actively *de-rank* a candidate it shares with
 * the proposal, which is backwards for a retrieval-stage signal.
 */
export function computeIdf(documentFrequency: Map<string, number>, totalDocuments: number): Map<string, number> {
  const idf = new Map<string, number>();
  for (const [token, df] of documentFrequency) idf.set(token, Math.log((totalDocuments + 1) / (df + 1)) + 1);
  return idf;
}

/** Ranks candidates by the summed IDF of the tokens they share with the proposal — the
 * "distinctive wording" retriever: two items sharing a rare word rank far above two
 * sharing only common ones, without needing an arbitrary rarity cutoff. */
export function rankByRareTokens(proposalTokens: string[], candidateTokens: Map<string, string[]>, idf: Map<string, number>): string[] {
  const proposalSet = new Set(proposalTokens);
  return [...candidateTokens.entries()]
    .map(([workItemId, tokens]) => ({ workItemId, weight: tokens.filter((token) => proposalSet.has(token)).reduce((sum, token) => sum + (idf.get(token) ?? 0), 0) }))
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.workItemId.localeCompare(b.workItemId))
    .map((entry) => entry.workItemId);
}

function groupToMap(rows: Row[], idColumn: string, valueColumn: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const id = text(row, idColumn);
    map.set(id, [...(map.get(id) ?? []), text(row, valueColumn)]);
  }
  return map;
}

// ── Read-time retrieval (the DB-backed shell) ───────────────────────────────────────────

/**
 * The candidate set for a batch of proposals: for each proposal, the top 50 items by RRF
 * fusion of the artifact and rare-token retrievers, unioned across the whole batch.
 *
 * A proposal that shares neither an artifact nor a token with anything in the project
 * retrieves nothing — deliberately. That is not a gap the old recency fallback needs to
 * paper over; it is an accurate statement that nothing in the project currently looks
 * like this proposal. Manufacturing candidates by recency alone was the bug (F2), not the
 * fix for missing signal.
 *
 * Deliberately not filtered by status — done and cancelled items are candidates by
 * design, matching `DEDUPLICATION_ARCHITECTURE.md §5`.
 */
export async function retrieveCandidates(
  db: PgD1,
  organizationId: string,
  projectId: string,
  proposals: Array<{ title: string; description?: string }>,
  options: { includeEmbeddings?: boolean } = {},
): Promise<WorkItem[]> {
  // `includeEmbeddings` defaults to on — every real caller wants it, since it is a
  // genuine no-op (see the module comment) rather than an expensive optional extra. It
  // exists purely for `measureEmbeddingAblation` (embedding-eval.ts), which has to run
  // retrieval twice, with and without the third retriever, over the identical candidate
  // pool to measure what it alone contributes — the whole point of §8's ablation
  // discipline: "prove it, or delete it," which needs a true before/after to prove.
  const includeEmbeddings = options.includeEmbeddings !== false;
  const signatures = proposals.map((proposal) => buildSignature(proposal.title, proposal.description ?? ""));
  const allArtifacts = [...new Set(signatures.flatMap((signature) => signature.artifacts))].slice(0, 400);
  const allTokens = [...new Set(signatures.flatMap((signature) => signature.objectTokens))].slice(0, 400);
  if (!allArtifacts.length && !allTokens.length) return [];

  const [artifactRows, tokenRows, dfRows, totalRow, embeddingRankings] = await Promise.all([
    allArtifacts.length
      ? db.prepare("SELECT work_item_id, artifact FROM work_item_artifacts WHERE project_id = ? AND artifact = ANY(?::text[])").bind(projectId, allArtifacts).all<Row>()
      : Promise.resolve({ results: [] as Row[] }),
    allTokens.length
      ? db.prepare("SELECT work_item_id, token FROM work_item_tokens WHERE project_id = ? AND token = ANY(?::text[])").bind(projectId, allTokens).all<Row>()
      : Promise.resolve({ results: [] as Row[] }),
    allTokens.length
      ? db.prepare("SELECT token, COUNT(DISTINCT work_item_id)::int AS df FROM work_item_tokens WHERE project_id = ? AND token = ANY(?::text[]) GROUP BY token").bind(projectId, allTokens).all<Row>()
      : Promise.resolve({ results: [] as Row[] }),
    db.prepare("SELECT COUNT(*)::int AS total FROM work_items WHERE project_id = ? AND organization_id = ? AND archived_at IS NULL").bind(projectId, organizationId).all<Row>(),
    includeEmbeddings ? retrieveByEmbedding(db, projectId, signatures.map((signature) => signature.objectTokens), TOP_N) : Promise.resolve(signatures.map(() => [] as string[])),
  ]);

  const artifactsByItem = groupToMap(artifactRows.results, "work_item_id", "artifact");
  const tokensByItem = groupToMap(tokenRows.results, "work_item_id", "token");
  const documentFrequency = new Map(dfRows.results.map((row) => [text(row, "token"), Number(row.df ?? 0)]));
  const totalDocuments = Number(totalRow.results[0]?.total ?? 0);
  const idf = computeIdf(documentFrequency, totalDocuments);

  const unionIds = new Set<string>();
  signatures.forEach((signature, index) => {
    const artifactRanking = rankByArtifactOverlap(signature.artifacts, artifactsByItem);
    const tokenRanking = rankByRareTokens(signature.objectTokens, tokensByItem, idf);
    const fused = fuseRankings([artifactRanking, tokenRanking, embeddingRankings[index]]).slice(0, TOP_N);
    for (const entry of fused) unionIds.add(entry.workItemId);
  });
  if (!unionIds.size) return [];

  const rows = await db.prepare("SELECT * FROM work_items WHERE project_id = ? AND organization_id = ? AND archived_at IS NULL AND id = ANY(?::text[])")
    .bind(projectId, organizationId, [...unionIds]).all<Row>();
  return rows.results.map(mapItem);
}
