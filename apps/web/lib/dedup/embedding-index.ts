/**
 * E5 — the database-backed half of the static embedding tier: computing and storing one
 * mean-pooled vector per work item in `work_item_embeddings`, from whatever rows
 * `token_vectors` currently has (see that table's own schema comment for why it ships
 * empty in this environment, and why that is a normal, handled state rather than a bug).
 */
import type { PgD1, PgD1PreparedStatement } from "@/db/pg-d1";
import { tokensOf } from "./tokens.ts";
import { meanPool, parseVectorLiteral, vectorLiteral, type WeightedVector } from "./embedding.ts";

const BACKFILL_BATCH = 200;

/** Fetches the `token_vectors` rows for a set of tokens. Batched across a whole call's
 * worth of items (or proposals) rather than one query per item — the same shape E1's
 * `retrieveCandidates` already uses for artifact/token lookups. */
async function loadVectors(db: PgD1, tokens: string[]): Promise<Map<string, WeightedVector>> {
  const map = new Map<string, WeightedVector>();
  if (!tokens.length) return map;
  const rows = await db.prepare("SELECT token, vec, weight FROM token_vectors WHERE token = ANY(?::text[])")
    .bind(tokens).all<{ token: string; vec: string; weight: number }>();
  for (const row of rows.results) {
    map.set(row.token, { vec: parseVectorLiteral(row.vec), weight: Number(row.weight ?? 1) });
  }
  return map;
}

/** Pools whichever of `tokens` have a row in `vectorsByToken`. `null` when none do — most
 * tokens, while `token_vectors` is empty, which is the expected default state. */
function poolFor(tokens: string[], vectorsByToken: Map<string, WeightedVector>): number[] | null {
  const present = tokens.map((token) => vectorsByToken.get(token)).filter((entry): entry is WeightedVector => entry != null);
  return meanPool(present);
}

/**
 * Statements that bring one item's stored embedding up to date with its current text.
 * Always a DELETE first, same as `blockingIndexStatements`: an edit can turn a
 * computable embedding into an uncomputable one (every distinctive word replaced by ones
 * `token_vectors` doesn't have), and a stale embedding left behind would keep matching
 * text the item no longer means.
 */
export async function embeddingIndexStatements(
  db: PgD1,
  input: { organizationId: string; projectId: string; workItemId: string; title: string; description: string; now: string },
): Promise<PgD1PreparedStatement[]> {
  const tokens = tokensOf(input.title, input.description);
  const vectorsByToken = await loadVectors(db, tokens);
  const pooled = poolFor(tokens, vectorsByToken);

  const statements: PgD1PreparedStatement[] = [
    db.prepare("DELETE FROM work_item_embeddings WHERE work_item_id = ? AND project_id = ?").bind(input.workItemId, input.projectId),
  ];
  if (pooled) {
    statements.push(
      db.prepare("INSERT INTO work_item_embeddings (organization_id, project_id, work_item_id, embedding, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(input.organizationId, input.projectId, input.workItemId, vectorLiteral(pooled), input.now),
    );
  }
  statements.push(db.prepare("UPDATE work_items SET embeddings_indexed_at = ? WHERE id = ?").bind(input.now, input.workItemId));
  return statements;
}

/**
 * Indexes items not yet through embedding indexing — both items written before this
 * milestone existed, and (the common case in this environment) items written while
 * `token_vectors` was still empty, so a real deploy that later loads the distilled table
 * needs this to sweep the backlog rather than waiting for every item to be edited again.
 * Bounded per call, same reasoning as `backfillBlockingIndex`: a large project converges
 * over a few calls instead of stalling one of them.
 */
export async function backfillEmbeddingIndex(db: PgD1, organizationId: string, projectId: string): Promise<number> {
  const pending = await db.prepare(
    "SELECT id, title, description FROM work_items WHERE project_id = ? AND organization_id = ? AND embeddings_indexed_at IS NULL ORDER BY updated_at DESC LIMIT ?",
  ).bind(projectId, organizationId, BACKFILL_BATCH).all<{ id: string; title: string; description: string }>();
  if (!pending.results.length) return 0;

  const now = new Date().toISOString();
  const statements: PgD1PreparedStatement[] = [];
  for (const row of pending.results) {
    statements.push(...await embeddingIndexStatements(db, { organizationId, projectId, workItemId: row.id, title: row.title, description: row.description ?? "", now }));
  }
  await db.batch(statements);
  return pending.results.length;
}

/**
 * The embedding-based retriever's DB half: for each proposal that has a computable
 * embedding (skipped entirely, no query issued, when it doesn't — the common case while
 * `token_vectors` is empty), the top `limit` existing items by cosine distance via
 * pgvector's `<=>` operator and the HNSW index on `work_item_embeddings`. Returns a
 * ranking per proposal index (aligned with `tokensByProposal`), `[]` for a proposal with
 * no computable embedding, matching the shape `fuseRankings` in blocking.ts already
 * expects from its other retrievers.
 *
 * Takes token lists rather than raw proposals: `retrieveCandidates` (blocking.ts) has
 * already run every proposal through `buildSignature` for its other two retrievers, and
 * `tokensOf` is exactly `buildSignature(...).objectTokens` (see tokens.ts) — recomputing
 * it here would be the same signature parse done twice for no reason.
 */
export async function retrieveByEmbedding(
  db: PgD1,
  projectId: string,
  tokensByProposal: string[][],
  limit: number,
): Promise<string[][]> {
  const allTokens = [...new Set(tokensByProposal.flat())];
  if (!allTokens.length) return tokensByProposal.map(() => []);

  const vectorsByToken = await loadVectors(db, allTokens);
  if (!vectorsByToken.size) return tokensByProposal.map(() => []);

  return Promise.all(tokensByProposal.map(async (tokens) => {
    const pooled = poolFor(tokens, vectorsByToken);
    if (!pooled) return [];
    const rows = await db.prepare(
      "SELECT work_item_id FROM work_item_embeddings WHERE project_id = ? ORDER BY embedding <=> ?::vector LIMIT ?",
    ).bind(projectId, vectorLiteral(pooled), limit).all<{ work_item_id: string }>();
    return rows.results.map((row) => row.work_item_id);
  }));
}
