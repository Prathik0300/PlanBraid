/**
 * E5 — the static embedding tier's pure math (RECONCILIATION_ARCHITECTURE.md §6/§6.1,
 * "Route A: vectors in Postgres"). No database, no model, no inference: a real static
 * embedding model *is* a token→vector lookup table plus weighted mean pooling — "there is
 * no neural network at inference" is the whole design's point — so this module is exactly
 * that lookup-and-pool arithmetic, independent of where the vectors themselves came from.
 *
 * `token_vectors` (db/setup.ts) ships empty in this environment: the real distilled
 * `potion-base-8M` table (~8 MB) can't be downloaded or fabricated in this sandbox. Every
 * function here is written so an empty or partial lookup table degrades to "no embedding
 * computed" (`null`), never a wrong or fabricated one — the same "missing is principled,
 * not a wrong value" property E3's Fellegi-Sunter features already rely on for f8.
 */

export const EMBEDDING_DIM = 256;

export type WeightedVector = { vec: number[]; weight: number };

/**
 * Weighted mean pool: `Σ(vec·weight) / Σweight`. `null` when there is nothing to pool —
 * an empty list (none of this text's tokens have a row in `token_vectors`) or a
 * degenerate zero total weight — rather than returning an all-zero vector, which would
 * be a real point in embedding space (equidistant from everything) and not a faithful
 * stand-in for "no signal."
 */
export function meanPool(vectors: WeightedVector[]): number[] | null {
  if (!vectors.length) return null;
  const dim = vectors[0].vec.length;
  const totalWeight = vectors.reduce((sum, { weight }) => sum + weight, 0);
  if (totalWeight <= 0) return null;
  const pooled = new Array(dim).fill(0);
  for (const { vec, weight } of vectors) {
    for (let i = 0; i < dim; i += 1) pooled[i] += vec[i] * weight;
  }
  return pooled.map((value) => value / totalWeight);
}

/** Cosine similarity, 0 when either vector is the zero vector (undefined direction)
 * rather than throwing on the division. Used for direct in-process comparison (tests,
 * the ablation harness); live retrieval uses pgvector's own `<=>` operator instead, so
 * the ANN index does the work rather than a full scan through JavaScript. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** pgvector's text input/output format: `[0.1,0.2,...]`. Both PGlite's bundled vector
 * extension and every managed Postgres host's pgvector accept this directly as a
 * parameter bound to a `vector` column, and return it in the same shape on read. */
export function vectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

export function parseVectorLiteral(value: string): number[] {
  const trimmed = value.trim();
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (!inner) return [];
  return inner.split(",").map(Number);
}
