/**
 * E3 — the pure half of `scripts/reconcile-train.mjs`: supervised MLE re-estimation of
 * Fellegi-Sunter m/u weights from labeled pairs. Split out from the script itself so it's
 * directly testable without a database, the same shape as `blocking-eval.ts` next to
 * `scripts/reconcile-eval.mjs` — the script's own job is only to fetch labels/items and
 * print the result.
 *
 * See `scripts/reconcile-train.mjs`'s module comment for the full reasoning (ground-truth
 * MLE vs. unsupervised EM, why vetoed pairs are excluded, why λ/costRatio aren't
 * re-estimated). This module only has the counting and smoothing math.
 */
import { computeFeatures, type FeatureId } from "./features.ts";
import { checkVetoes, type Candidate, type ProposalInput } from "./match.ts";
import { SEED_WEIGHTS, type WeightTable } from "./fellegi-sunter.ts";

export type TrainingPair = { proposal: ProposalInput; candidate: Candidate; verdict: "same" | "different" };

type LevelCounts = Map<string, { same: number; different: number }>;

export type TallyResult = {
  counts: Map<FeatureId, LevelCounts>;
  observedLevels: Map<FeatureId, Set<string>>;
  sameTotal: number;
  differentTotal: number;
  /** Pairs `checkVetoes` would catch before Fellegi-Sunter ever scores them — excluded
   * from every tally, since training on them would teach the model about observations it
   * will never actually see at scoring time. */
  vetoedSkipped: number;
};

const SMOOTHING_ALPHA = 0.5;

/** The set of levels a feature can land on, for Laplace-smoothing its count table.
 * Sourced from `SEED_WEIGHTS` where available — it already enumerates every real bucket —
 * falling back to whatever levels this sample actually observed when the seed table has
 * no entry for the feature at all (e.g. a brand-new feature added after the seed table
 * was last hand-written). */
export function levelUniverse(feature: FeatureId, observedLevels: Iterable<string>): string[] {
  const seeded = SEED_WEIGHTS.weights[feature];
  return seeded ? Object.keys(seeded) : [...new Set(observedLevels)];
}

export function tallyPairs(pairs: TrainingPair[]): TallyResult {
  const counts: TallyResult["counts"] = new Map();
  const observedLevels: TallyResult["observedLevels"] = new Map();
  let sameTotal = 0;
  let differentTotal = 0;
  let vetoedSkipped = 0;

  for (const { proposal, candidate, verdict } of pairs) {
    if (checkVetoes(proposal, candidate)) { vetoedSkipped += 1; continue; }
    if (verdict === "same") sameTotal += 1; else differentTotal += 1;

    const vector = computeFeatures(proposal, candidate);
    for (const [featureRaw, observation] of Object.entries(vector)) {
      const feature = featureRaw as FeatureId;
      if (!observation) continue;
      if (!counts.has(feature)) counts.set(feature, new Map());
      if (!observedLevels.has(feature)) observedLevels.set(feature, new Set());
      observedLevels.get(feature)!.add(observation.level);
      const perLevel = counts.get(feature)!;
      const entry = perLevel.get(observation.level) ?? { same: 0, different: 0 };
      entry[verdict] += 1;
      perLevel.set(observation.level, entry);
    }
  }

  return { counts, observedLevels, sameTotal, differentTotal, vetoedSkipped };
}

export type TrainingReportRow = {
  feature: FeatureId;
  status: "trained" | "kept-seed" | "kept-seed (unobserved)";
  sameObserved: number;
  differentObserved: number;
};

/**
 * Frequency-based MLE with additive (Laplace-family) smoothing, guarded by `minLabels`: a
 * feature/level pair with too few supporting labels keeps the ENTIRE feature at its seed
 * value rather than overwriting only its well-supported levels — a feature half-trained
 * and half-guessed would produce log-odds that aren't comparable across its own levels,
 * which is worse than an honestly-uniform guess.
 */
export function estimateWeights(tally: TallyResult, minLabels: number): { weights: WeightTable["weights"]; report: TrainingReportRow[] } {
  const weights: WeightTable["weights"] = {};
  const report: TrainingReportRow[] = [];

  for (const [feature, perLevel] of tally.counts.entries()) {
    const levels = levelUniverse(feature, tally.observedLevels.get(feature) ?? []);
    const totalSameObserved = [...perLevel.values()].reduce((sum, entry) => sum + entry.same, 0);
    const totalDifferentObserved = [...perLevel.values()].reduce((sum, entry) => sum + entry.different, 0);
    const supported = Math.min(totalSameObserved, totalDifferentObserved);

    if (supported < minLabels) {
      report.push({ feature, status: "kept-seed", sameObserved: totalSameObserved, differentObserved: totalDifferentObserved });
      const seeded = SEED_WEIGHTS.weights[feature];
      if (seeded) weights[feature] = seeded;
      continue;
    }

    const levelWeights: Record<string, { m: number; u: number }> = {};
    for (const level of levels) {
      const entry = perLevel.get(level) ?? { same: 0, different: 0 };
      const m = (entry.same + SMOOTHING_ALPHA) / (totalSameObserved + SMOOTHING_ALPHA * levels.length);
      const u = (entry.different + SMOOTHING_ALPHA) / (totalDifferentObserved + SMOOTHING_ALPHA * levels.length);
      levelWeights[level] = { m: Number(m.toFixed(4)), u: Number(u.toFixed(4)) };
    }
    weights[feature] = levelWeights;
    report.push({ feature, status: "trained", sameObserved: totalSameObserved, differentObserved: totalDifferentObserved });
  }

  for (const featureRaw of Object.keys(SEED_WEIGHTS.weights)) {
    const feature = featureRaw as FeatureId;
    if (!(feature in weights)) {
      weights[feature] = SEED_WEIGHTS.weights[feature];
      report.push({ feature, status: "kept-seed (unobserved)", sameObserved: 0, differentObserved: 0 });
    }
  }

  return { weights, report };
}
