/**
 * E1's own gate: "Blocking recall@50 ≥ 99%" (RECONCILIATION_ARCHITECTURE.md §13).
 *
 * This is a different question from E0's `evaluateReconciliation`, which measures whether
 * the *scorer* collapses a labelled-same pair once both items are already in hand.
 * Blocking recall measures something upstream and more fundamental: whether the pair ever
 * reaches the scorer at all. A duplicate the scorer would correctly collapse, but blocking
 * never retrieves, is invisible forever — indistinguishable in the product from a bug that
 * was never caught, which is exactly why §5 calls this "the only metric that matters at
 * this stage."
 *
 * Needs the database, unlike E0's harness: `retrieveCandidates` reads the live artifact
 * and rare-token indices, and there is no meaningful pure version of "would the index have
 * found this."
 */
import type { PgD1 } from "@/db/pg-d1";
import { retrieveCandidates } from "./blocking.ts";

export type BlockingGoldenLabel = { leftItemId: string; rightItemId: string; verdict: string };
export type BlockingGoldenItem = { projectId: string; title: string; description?: string; createdAt: string };

export type BlockingRecallReport = {
  total: number;
  recall: number;
  /** Pairs blocking failed to connect, named by which side was "new" — the one whose
   * title/description was handed to retrieveCandidates — and which side it should have
   * found. Every entry here is a genuine finding: something a real proposal would have
   * missed. */
  missed: Array<{ olderItemId: string; newerItemId: string; olderProjectId: string }>;
};

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 1 : numerator / denominator;
}

/**
 * Replays the golden set's `verdict: 'same'` pairs against the live blocking index:
 * for each pair, the item created *later* stands in for a fresh proposal (the direction
 * that actually happens in production — an agent proposes something, and blocking has to
 * find whatever *already exists*), and the report counts how often the earlier item
 * appears among the top-50 candidates retrieved for it.
 *
 * A pair whose two items live in different projects is skipped rather than counted as a
 * miss — blocking is project-scoped by design (§5, §11), so a cross-project label would
 * either be a data error or a testing artifact, never a real blocking-recall question.
 */
export async function measureBlockingRecall(
  db: PgD1,
  organizationId: string,
  labels: BlockingGoldenLabel[],
  itemsById: Map<string, BlockingGoldenItem>,
): Promise<BlockingRecallReport> {
  const sameLabels = labels.filter((label) => label.verdict === "same" && itemsById.has(label.leftItemId) && itemsById.has(label.rightItemId));

  let caught = 0;
  const missed: BlockingRecallReport["missed"] = [];
  let total = 0;

  for (const label of sameLabels) {
    const left = itemsById.get(label.leftItemId)!;
    const right = itemsById.get(label.rightItemId)!;
    if (left.projectId !== right.projectId) continue;
    total += 1;

    const leftIsNewer = new Date(left.createdAt).getTime() >= new Date(right.createdAt).getTime();
    const newer = leftIsNewer ? { ...left, id: label.leftItemId } : { ...right, id: label.rightItemId };
    const older = leftIsNewer ? { ...right, id: label.rightItemId } : { ...left, id: label.leftItemId };

    const candidates = await retrieveCandidates(db, organizationId, newer.projectId, [{ title: newer.title, description: newer.description }]);
    if (candidates.some((candidate) => candidate.id === older.id)) caught += 1;
    else missed.push({ olderItemId: older.id, newerItemId: newer.id, olderProjectId: older.projectId });
  }

  return { total, recall: ratio(caught, total), missed };
}
