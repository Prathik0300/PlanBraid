/**
 * E7's own gate (RECONCILIATION_ARCHITECTURE.md §13): "symbol-resolved artifacts
 * measurably lift precision." Reuses E0's `evaluateReconciliation` directly rather than
 * parallel scoring infrastructure — the only new idea here is *which* labels to score and
 * *what* to compare, not a new way of scoring them.
 *
 * Scoped to the labels where resolution could possibly matter: a same-labelled pair with
 * a shared symbol-classified artifact is exactly the population f4's `high-resolved` vs.
 * `high-unresolved` split can move — every other label is unaffected by
 * `resolvedSymbols` either way and would only dilute the comparison.
 */
import { evaluateReconciliation, type EvaluationReport, type GoldenLabel } from "./labels.ts";
import { snapshotAdjudicationFs } from "./fellegi-sunter.ts";
import { buildSignature, classifyArtifact } from "./signature.ts";

export type SymbolAblationReport = {
  /** Same-labelled pairs sharing at least one symbol-classified artifact — the
   * population these two reports are computed over. */
  symbolPairTotal: number;
  withResolution: EvaluationReport;
  withoutResolution: EvaluationReport;
};

function symbolArtifactsOf(item: { title: string; description?: string }): string[] {
  return buildSignature(item.title, item.description ?? "").artifacts.filter((artifact) => classifyArtifact(artifact) === "symbol");
}

function sharesSymbol(left: { title: string; description?: string }, right: { title: string; description?: string }): boolean {
  const leftSymbols = symbolArtifactsOf(left);
  if (!leftSymbols.length) return false;
  const rightSymbols = new Set(symbolArtifactsOf(right));
  return leftSymbols.some((symbol) => rightSymbols.has(symbol));
}

export function measureSymbolResolutionAblation(
  labels: GoldenLabel[],
  itemsById: Map<string, { title: string; description?: string }>,
  resolvedSymbols: ReadonlySet<string>,
): SymbolAblationReport {
  const symbolLabels = labels.filter((label) => {
    const left = itemsById.get(label.leftItemId);
    const right = itemsById.get(label.rightItemId);
    return left != null && right != null && sharesSymbol(left, right);
  });

  return {
    symbolPairTotal: symbolLabels.length,
    withResolution: evaluateReconciliation(symbolLabels, itemsById, (left, right) => snapshotAdjudicationFs(left, right, undefined, { resolvedSymbols })),
    withoutResolution: evaluateReconciliation(symbolLabels, itemsById, (left, right) => snapshotAdjudicationFs(left, right)),
  };
}
