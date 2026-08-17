/**
 * E5's own gate (RECONCILIATION_ARCHITECTURE.md §13): "ablation proves the paraphrase
 * case improves; otherwise delete it." §8.1's discipline applies here exactly as it did
 * to §6's original removal of the embedding tier — a new signal earns its place by a
 * measured improvement on the golden set, not by being theoretically well-motivated.
 *
 * A "paraphrase" pair, for this measurement, is a same-labelled pair where E1's own two
 * retrievers (artifact overlap, rare tokens) have *zero* signal — no shared artifact, no
 * shared object token — the exact case §6 argues only a semantic signal can ever catch.
 * Every other same-labelled pair is excluded from this report on purpose: E1 already
 * finds those, so whether embeddings also happen to find them proves nothing about
 * whether the tier is earning its keep.
 *
 * Needs the database, like `measureBlockingRecall` — retrieval is not a pure function.
 */
import type { PgD1 } from "@/db/pg-d1";
import { retrieveCandidates } from "./blocking.ts";
import { buildSignature } from "./signature.ts";
import type { BlockingGoldenItem, BlockingGoldenLabel } from "./blocking-eval.ts";

export type EmbeddingAblationReport = {
  /** Same-labelled pairs where E1 alone (artifact + rare-token retrieval) has no signal
   * at all — the population this report's recall numbers are computed over. */
  paraphraseTotal: number;
  /** Blocking recall@50 on that population using the live retriever set (including
   * embeddings, if `token_vectors` has anything for these pairs' words). */
  recallWithEmbeddings: number;
  /** The same measurement with the embedding retriever switched off — the counterfactual
   * that makes "improves" a comparison rather than a single number. */
  recallWithoutEmbeddings: number;
  /** Pairs the embedding retriever alone catches: missed without it, caught with it —
   * the direct evidence for or against keeping the tier. */
  improvedPairs: Array<{ olderItemId: string; newerItemId: string }>;
};

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 1 : numerator / denominator;
}

export async function measureEmbeddingAblation(
  db: PgD1,
  organizationId: string,
  labels: BlockingGoldenLabel[],
  itemsById: Map<string, BlockingGoldenItem>,
): Promise<EmbeddingAblationReport> {
  const sameLabels = labels.filter((label) => label.verdict === "same" && itemsById.has(label.leftItemId) && itemsById.has(label.rightItemId));

  let paraphraseTotal = 0;
  let caughtWith = 0;
  let caughtWithout = 0;
  const improvedPairs: EmbeddingAblationReport["improvedPairs"] = [];

  for (const label of sameLabels) {
    const left = itemsById.get(label.leftItemId)!;
    const right = itemsById.get(label.rightItemId)!;
    if (left.projectId !== right.projectId) continue;

    const leftSignature = buildSignature(left.title, left.description ?? "");
    const rightSignature = buildSignature(right.title, right.description ?? "");
    const sharesArtifact = leftSignature.artifacts.some((artifact) => rightSignature.artifacts.includes(artifact));
    const sharesToken = leftSignature.objectTokens.some((token) => rightSignature.objectTokens.includes(token));
    if (sharesArtifact || sharesToken) continue; // E1 already has signal here; not a paraphrase case.

    paraphraseTotal += 1;
    const leftIsNewer = new Date(left.createdAt).getTime() >= new Date(right.createdAt).getTime();
    const newer = leftIsNewer ? { ...left, id: label.leftItemId } : { ...right, id: label.rightItemId };
    const older = leftIsNewer ? { ...right, id: label.rightItemId } : { ...left, id: label.leftItemId };

    const [withEmbeddings, withoutEmbeddings] = await Promise.all([
      retrieveCandidates(db, organizationId, newer.projectId, [{ title: newer.title, description: newer.description }]),
      retrieveCandidates(db, organizationId, newer.projectId, [{ title: newer.title, description: newer.description }], { includeEmbeddings: false }),
    ]);
    const foundWith = withEmbeddings.some((candidate) => candidate.id === older.id);
    const foundWithout = withoutEmbeddings.some((candidate) => candidate.id === older.id);
    if (foundWith) caughtWith += 1;
    if (foundWithout) caughtWithout += 1;
    if (foundWith && !foundWithout) improvedPairs.push({ olderItemId: older.id, newerItemId: newer.id });
  }

  return {
    paraphraseTotal,
    recallWithEmbeddings: ratio(caughtWith, paraphraseTotal),
    recallWithoutEmbeddings: ratio(caughtWithout, paraphraseTotal),
    improvedPairs,
  };
}
