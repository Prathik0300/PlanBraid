/**
 * E0 — the golden set, and the pure evaluation function it feeds.
 *
 * `RECONCILIATION_ARCHITECTURE.md §8` requires this to exist before any feature it would
 * judge: without a measured baseline, a claim that a new signal (an embedding tier, a
 * synonym list, a learned scorer) improves the matcher is exactly the kind of assertion
 * `DEDUPLICATION_ARCHITECTURE.md §6.1` was written to stop.
 *
 * Every label here is a side effect of something a person already does, never a survey or
 * a labelling task:
 *   - merging two items is a positive label — a person said this is the same work;
 *   - splitting a wrong alias match is a negative label — a person said it is not;
 *   - dismissing a Simplify duplicate/possible_duplicate/redundant_done finding is a
 *     negative label at lower confidence — "keep both" is a real signal, but weaker than
 *     an explicit split, since a dismissal can also mean "not worth my time right now".
 *   - E6's Tier A judgment (RECONCILIATION_ARCHITECTURE.md §9) is the one source here
 *     that isn't a person: a connected agent, with the repository open, answering a
 *     precise question about a specific ambiguous pair. Weaker evidence than a human
 *     action — the proposing agent has "a mild incentive to answer different so its task
 *     gets created," §9's own words — which is exactly why `provider_family` exists on
 *     this table: to audit judgment-sourced labels against later human ones per provider,
 *     not to trust them at face value.
 */
import type { PgD1, PgD1PreparedStatement } from "@/db/pg-d1";
import { buildSignature } from "./signature.ts";
import { adjudicate, type Adjudication } from "./match.ts";

export type LabelVerdict = "same" | "different";
export type LabelConfidence = "high" | "medium" | "weak";
export type LabelSource = "merge" | "split" | "dismissal" | "judgment";

function labelId() {
  return `lbl_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Order-independent, so a merge and a later split of the same two items land on the same
 * logical pair even though which one is "left" and which is "right" differs by caller. */
function pairHash(a: string, b: string) {
  return [a, b].sort().join("::");
}

/**
 * Snapshots the matcher's own adjudication for this pair at label time, so the label
 * stays interpretable — "the scorer said 0.6, a person said same" — even after the scorer
 * that produced 0.6 has since changed. Never touches the database; titles/descriptions are
 * whatever the caller already has in hand.
 */
export function snapshotAdjudication(left: { title: string; description?: string }, right: { title: string; description?: string }): Adjudication {
  const leftSignature = buildSignature(left.title, left.description ?? "");
  const rightSignature = buildSignature(right.title, right.description ?? "");
  return adjudicate({ signature: leftSignature, fingerprintValue: leftSignature.normalized }, {
    id: "candidate", itemKey: "", title: right.title, status: "",
    signature: rightSignature, fingerprintValue: rightSignature.normalized,
  });
}

export type CaptureLabelInput = {
  organizationId: string;
  projectId: string;
  leftItemId: string;
  rightItemId: string;
  verdict: LabelVerdict;
  confidence: LabelConfidence;
  source: LabelSource;
  /** Frozen into the label's `features` JSON at capture time. Typed structurally rather
   * than as `Adjudication` specifically: every merge/split/dismissal caller already has a
   * real `Adjudication` in hand and it satisfies this shape as-is, but E6's judgment
   * labels (`source: "judgment"`) were never scored by the matcher at all — a plain
   * object literal describing the judgment itself is the honest thing to freeze there,
   * not a fabricated `Adjudication` pretending a structural method decided it. */
  adjudication: { verdict: string; score: number; method: string; reason: string };
  justification?: string;
  /** Which provider family answered, for `source: "judgment"` labels — §9's own audit
   * needs this to group agreement rates by provider. Absent for the human-sourced kinds. */
  providerFamily?: string;
};

/**
 * The statement that records one label. A `db.batch` participant like every other write in
 * the store, so label capture rides inside the same atomic commit as the action that
 * produced it — a merge that fails to commit must not leave an orphaned label behind.
 *
 * `ON CONFLICT DO NOTHING`: the same pair can be merged, split, and re-merged across a
 * project's life, and `UNIQUE(project_id, pair_hash, label_source)` keeps only the first
 * label of each kind for a pair — the first split is the meaningful signal; a second split
 * of a pair that was never re-merged in between would just be a duplicate of the same
 * correction, not new evidence.
 */
export function captureLabelStatement(db: PgD1, input: CaptureLabelInput): PgD1PreparedStatement {
  const features = {
    verdict: input.adjudication.verdict,
    score: input.adjudication.score,
    method: input.adjudication.method,
    reason: input.adjudication.reason,
  };
  return db.prepare(
    "INSERT INTO reconciliation_labels (id, organization_id, project_id, pair_hash, left_item_id, right_item_id, verdict, confidence, label_source, features, justification, provider_family) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, pair_hash, label_source) DO NOTHING",
  ).bind(
    labelId(), input.organizationId, input.projectId, pairHash(input.leftItemId, input.rightItemId),
    input.leftItemId, input.rightItemId, input.verdict, input.confidence, input.source,
    JSON.stringify(features), input.justification?.slice(0, 1000) ?? null, input.providerFamily ?? null,
  );
}

// ── The evaluation function ──────────────────────────────────────────────────────────

export type GoldenLabel = {
  leftItemId: string;
  rightItemId: string;
  verdict: LabelVerdict;
  confidence: LabelConfidence;
  source: LabelSource;
  /** What the matcher said at label time, kept for reference; evaluation always
   * re-adjudicates with the *current* matcher, since the whole point is to measure it. */
  recordedFeatures?: { verdict: string; score: number; method: string };
};

export type EvaluationReport = {
  total: number;
  /** Of labelled 'same' pairs, how many the current matcher would actually collapse
   * (verdict 'duplicate'). The recall the product cares about — a possible/distinct
   * result on a true duplicate is a miss, full stop. */
  recall: number;
  /** Of pairs the matcher would collapse, how many were genuinely labelled 'same'. */
  precision: number;
  /**
   * The one number that can veto a release (`DEDUPLICATION_ARCHITECTURE.md §6.3`'s
   * asymmetry): a pair labelled 'different' that the current matcher would collapse
   * anyway. Must be zero. Anything else is a false merge slipping past a veto that a
   * person has already, explicitly, corrected once.
   */
  falseMerges: number;
  falseMergeExamples: Array<{ leftItemId: string; rightItemId: string; matcherVerdict: string }>;
  /** Labelled 'same' that the matcher only flags as 'possible' — not wrong, but not
   * collapsed either. This is the residual DEDUPLICATION_ARCHITECTURE.md §6.1 says to
   * watch: if it stays near zero, a synonym list is enough and a semantic tier is not
   * earning its cost a second time. */
  splitTrueDuplicates: number;
  bySource: Record<LabelSource, { total: number; recall: number }>;
};

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 1 : numerator / denominator;
}

/**
 * Pure: no database, no clock, no network. Takes the golden set and an adjudicator
 * function (so this can score today's cascade, or a future Fellegi-Sunter scorer, without
 * this module knowing which) and produces the report `scripts/reconcile-eval.mjs` prints.
 *
 * `itemsById` supplies title/description for re-adjudication; a label whose item no longer
 * exists (deleted, or from test fixtures) is skipped rather than crashing the whole run —
 * one missing item must not blank out every other label's signal.
 */
export function evaluateReconciliation(
  labels: GoldenLabel[],
  itemsById: Map<string, { title: string; description?: string }>,
  // Structural, not `Adjudication` specifically: this function only ever reads
  // `result.verdict` below, and callers scoring E3's Fellegi-Sunter path
  // (`snapshotAdjudicationFs`, whose `FsAdjudication` carries `probability` rather than
  // `score`) need to pass exactly this and nothing more.
  adjudicator: (left: { title: string; description?: string }, right: { title: string; description?: string }) => { verdict: string },
): EvaluationReport {
  const usable = labels.filter((label) => itemsById.has(label.leftItemId) && itemsById.has(label.rightItemId));
  const bySourceCounts = new Map<LabelSource, { total: number; caught: number }>();
  let sameTotal = 0;
  let sameCaught = 0;
  let collapsedTotal = 0;
  let collapsedCorrect = 0;
  let falseMerges = 0;
  let splitTrueDuplicates = 0;
  const falseMergeExamples: EvaluationReport["falseMergeExamples"] = [];

  for (const label of usable) {
    const left = itemsById.get(label.leftItemId)!;
    const right = itemsById.get(label.rightItemId)!;
    const result = adjudicator(left, right);
    const collapses = result.verdict === "duplicate";

    const bucket = bySourceCounts.get(label.source) ?? { total: 0, caught: 0 };
    bucket.total += 1;

    if (label.verdict === "same") {
      sameTotal += 1;
      if (collapses) { sameCaught += 1; bucket.caught += 1; }
      else if (result.verdict === "possible") splitTrueDuplicates += 1;
    } else if (collapses) {
      falseMerges += 1;
      falseMergeExamples.push({ leftItemId: label.leftItemId, rightItemId: label.rightItemId, matcherVerdict: result.verdict });
    }
    if (collapses) { collapsedTotal += 1; if (label.verdict === "same") collapsedCorrect += 1; }

    bySourceCounts.set(label.source, bucket);
  }

  const bySource = {} as EvaluationReport["bySource"];
  for (const source of ["merge", "split", "dismissal", "judgment"] as const) {
    const bucket = bySourceCounts.get(source) ?? { total: 0, caught: 0 };
    bySource[source] = { total: bucket.total, recall: ratio(bucket.caught, bucket.total) };
  }

  return {
    total: usable.length,
    recall: ratio(sameCaught, sameTotal),
    precision: ratio(collapsedCorrect, collapsedTotal),
    falseMerges,
    falseMergeExamples,
    splitTrueDuplicates,
    bySource,
  };
}
