/**
 * E6 — §9's audit rule: "track judgment-vs-later-human-split agreement per provider; if
 * a provider's judgments disagree with humans, down-weight them." Reuses E0's golden set
 * directly rather than a parallel tracking mechanism — a judgment label and a human
 * label (merge/split/dismissal) on the *same pair* (`pair_hash`) are the comparison this
 * function makes.
 *
 * Pure: given the label rows, no database. `scripts/reconcile-eval.mjs` supplies them.
 */
import type { LabelSource, LabelVerdict } from "./labels.ts";

export type ProviderAgreementRow = {
  pairHash: string;
  source: LabelSource;
  verdict: LabelVerdict;
  providerFamily: string | null;
  createdAt: string;
};

export type ProviderAgreementBucket = { total: number; agreements: number; disagreements: number; rate: number };
export type ProviderAgreementReport = Record<string, ProviderAgreementBucket>;

const HUMAN_SOURCES = new Set<LabelSource>(["merge", "split", "dismissal"]);

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 1 : numerator / denominator;
}

/**
 * The pair's most recent human-sourced label stands in for "what humans currently
 * believe about this pair" — a pair can genuinely be merged, later split back apart as a
 * correction, and the split is the more current truth, not the merge. Recency, not a
 * fixed source-priority order, is what actually tracks that.
 */
function latestHumanVerdict(rows: ProviderAgreementRow[]): LabelVerdict | null {
  const humanRows = rows.filter((row) => HUMAN_SOURCES.has(row.source));
  if (!humanRows.length) return null;
  return humanRows.reduce((latest, row) => (new Date(row.createdAt) > new Date(latest.createdAt) ? row : latest)).verdict;
}

/**
 * Grouped by `pairHash`, then by the judgment's own provider. A pair with a judgment but
 * no human label at all contributes nothing — there is nothing to audit it against yet;
 * this is not a gap, it's simply a judgment still awaiting the human action that would
 * make it auditable.
 */
export function measureProviderAgreement(labels: ProviderAgreementRow[]): ProviderAgreementReport {
  const byPair = new Map<string, ProviderAgreementRow[]>();
  for (const label of labels) {
    if (!byPair.has(label.pairHash)) byPair.set(label.pairHash, []);
    byPair.get(label.pairHash)!.push(label);
  }

  const report: ProviderAgreementReport = {};
  for (const rows of byPair.values()) {
    const judgments = rows.filter((row) => row.source === "judgment");
    if (!judgments.length) continue;
    const humanVerdict = latestHumanVerdict(rows);
    if (!humanVerdict) continue;

    for (const judgment of judgments) {
      const family = judgment.providerFamily ?? "unknown";
      const bucket = report[family] ?? { total: 0, agreements: 0, disagreements: 0, rate: 1 };
      bucket.total += 1;
      if (judgment.verdict === humanVerdict) bucket.agreements += 1; else bucket.disagreements += 1;
      report[family] = bucket;
    }
  }

  for (const bucket of Object.values(report)) bucket.rate = ratio(bucket.agreements, bucket.total);
  return report;
}
