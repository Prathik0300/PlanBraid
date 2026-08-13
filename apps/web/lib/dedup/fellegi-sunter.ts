/**
 * E3 — Fellegi-Sunter scoring (RECONCILIATION_ARCHITECTURE.md §4.2), built as a path that
 * runs *alongside* the production cascade (`lib/dedup/match.ts`), not in place of it. It
 * only becomes the live adjudicator once the harness shows it beats the cascade baseline
 * (§13's own gate for this milestone) — until then `scripts/reconcile-eval.mjs` is the
 * only thing that calls it.
 *
 * The model: each feature `i` contributes `w_i = log2(m_i(γ)/u_i(γ))` — how many times
 * more likely that observed agreement level is under "same" than under "different". Sum
 * the contributions of every *observed* feature (a `null` feature, per features.ts, is
 * skipped rather than penalized), add the prior's own log-odds, and the total is the
 * pair's log-odds of being the same task. A feature whose `m` and `u` are nearly equal —
 * uninformative either way — contributes a weight near zero on its own, which is why an
 * honestly-uncertain seed table (see `SEED_WEIGHTS` below) is safe to ship: it doesn't
 * bias the score, it just doesn't sharpen it until real labels replace the guesses.
 */
import { computeFeatures, type FeatureContext, type FeatureId, type FeatureVector } from "./features.ts";
import { checkVetoes, type Candidate, type ProposalInput } from "./match.ts";
import { buildSignature } from "./signature.ts";

export type LevelWeights = Record<string, { m: number; u: number }>;
export type WeightTable = {
  /** λ = P(same) prior *among pairs that reach this scorer* — i.e. after Stage 1
   * blocking has already discarded the overwhelming majority of non-candidates, not the
   * unconditional duplicate rate across the whole project. */
  prior: number;
  /** C_merge / C_split. Same asymmetric-cost ratio used throughout the cascade (§10) —
   * the roadmap's own worked example is 200 (a false merge costs ~200x a false split). */
  costRatio: number;
  weights: Partial<Record<FeatureId, LevelWeights>>;
};

/**
 * Seed weights: reasoned from the asymmetric-error principle and the cascade's existing
 * thresholds, not fit to real labeled data — there is no live production database in this
 * environment to train against (§8.1 wants labels sourced from real merges/splits, and
 * this sandbox has none). `scripts/reconcile-train.mjs` re-estimates every `m`/`u` pair
 * from `reconciliation_labels` the moment enough real labels exist; until then these
 * numbers exist so the scorer is exercisable and testable, not because they're trusted.
 * Every feature with `m` close to `u` is a deliberately weak, close-to-neutral guess
 * rather than a confident one, so an untrained feature can't dominate a score.
 *
 * f8/f10/f11 (embedding, graph proximity, implementation overlap) are absent on purpose:
 * no caller populates those observations yet (E5/E7), and a feature with no weight entry
 * is treated exactly like a `null` observation — skipped, not zero-filled — so adding
 * their real weights later is additive, never a migration.
 */
export const SEED_WEIGHTS: WeightTable = {
  prior: 0.02,
  costRatio: 200,
  weights: {
    f1_fingerprint: { equal: { m: 0.99, u: 0.001 }, different: { m: 0.01, u: 0.999 } },
    f2_artifactJaccard: {
      high: { m: 0.6, u: 0.02 }, medium: { m: 0.25, u: 0.08 },
      low: { m: 0.1, u: 0.2 }, none: { m: 0.05, u: 0.7 },
    },
    f3_artifactContainment: {
      high: { m: 0.65, u: 0.02 }, medium: { m: 0.2, u: 0.08 },
      low: { m: 0.1, u: 0.2 }, none: { m: 0.05, u: 0.7 },
    },
    f4_symbolOverlap: { high: { m: 0.5, u: 0.03 }, low: { m: 0.2, u: 0.17 }, none: { m: 0.3, u: 0.8 } },
    f5_subsystem: {
      same: { m: 0.75, u: 0.15 }, adjacent: { m: 0.15, u: 0.35 }, different: { m: 0.1, u: 0.5 },
    },
    f6_action: {
      same: { m: 0.8, u: 0.3 }, compatible: { m: 0.2, u: 0.68 }, antonym: { m: 0.001, u: 0.02 },
    },
    f7_lexical: {
      high: { m: 0.55, u: 0.03 }, medium: { m: 0.25, u: 0.12 },
      low: { m: 0.15, u: 0.35 }, none: { m: 0.05, u: 0.5 },
    },
    f9_criteria: {
      high: { m: 0.5, u: 0.05 }, medium: { m: 0.2, u: 0.1 },
      low: { m: 0.15, u: 0.25 }, none: { m: 0.15, u: 0.6 },
    },
    f12_temporal: {
      "candidate-active": { m: 0.5, u: 0.6 },
      "candidate-done-recent": { m: 0.25, u: 0.15 },
      "candidate-done-stale": { m: 0.15, u: 0.15 },
      "candidate-cancelled": { m: 0.1, u: 0.1 },
    },
  },
};

export type FeatureContribution = { feature: FeatureId; level: string; weight: number };

/**
 * `w_i = log2(m/u)`, smoothed away from 0 and 1 so a single sparse label never produces
 * an infinite weight (the classic Fellegi-Sunter failure mode with small training sets —
 * §8's realistic scale for a single project is tens to low hundreds of labels, not the
 * millions record-linkage was originally designed around).
 */
const EPSILON = 1e-4;
function featureWeight(m: number, u: number): number {
  const clampedM = Math.min(1 - EPSILON, Math.max(EPSILON, m));
  const clampedU = Math.min(1 - EPSILON, Math.max(EPSILON, u));
  return Math.log2(clampedM / clampedU);
}

/**
 * Sums `w_i` over every feature that was actually observed *and* has a trained weight for
 * the level it landed on. Everything else — a `null` observation, or an observed level
 * the weight table has no entry for — contributes nothing, which is the Fellegi-Sunter
 * property that makes partial evidence safe: less information means a score closer to
 * the prior, never a penalty for not knowing.
 */
export function scoreFeatures(vector: FeatureVector, table: WeightTable): { logOdds: number; contributions: FeatureContribution[] } {
  const priorLogOdds = featureWeight(table.prior, 1 - table.prior);
  const contributions: FeatureContribution[] = [];
  let logOdds = priorLogOdds;
  for (const [feature, observation] of Object.entries(vector) as [FeatureId, FeatureVector[FeatureId]][]) {
    if (!observation) continue;
    const levels = table.weights[feature];
    const entry = levels?.[observation.level];
    if (!entry) continue;
    const weight = featureWeight(entry.m, entry.u);
    logOdds += weight;
    contributions.push({ feature, level: observation.level, weight });
  }
  return { logOdds, contributions };
}

/** `P(same) = 1 / (1 + 2^-logOdds)` — the same sigmoid as `2^x/(1+2^x)`, rearranged so
 * the exponent stays negative for confidently-same pairs, where `2^logOdds` alone would
 * overflow to `Infinity` for a large enough sum of confident features. */
export function probabilityOfMatch(logOdds: number): number {
  return 1 / (1 + Math.pow(2, -logOdds));
}

export type FsVerdict = "duplicate" | "possible" | "distinct";
export type FsDecision = {
  verdict: FsVerdict;
  probability: number;
  logOdds: number;
  collapseThreshold: number;
  contributions: FeatureContribution[];
};

/** Threshold derivation from RECONCILIATION_ARCHITECTURE.md §4.2: collapsing is worth it
 * only once `P(same)` clears `C_merge/(C_merge+C_split)` — at the roadmap's own 200:1
 * example this is ≈0.995, deliberately far above a coin flip because a false merge costs
 * ~200x what a false split does. The lower band uses a fixed 0.5 (more-likely-than-not),
 * not a second cost-derived threshold: Fellegi-Sunter's classical two-threshold method
 * bounds false-match/false-non-match *rates* from a large labeled set, which this project
 * doesn't have yet (§8.1); 0.5 is the honest fallback until real error-rate curves exist
 * to replace it, and it errs toward flagging more "possible" cases for a human, matching
 * §10's flag-conservatively bias for the current review UI. */
const POSSIBLE_THRESHOLD = 0.5;

export function decide(vector: FeatureVector, table: WeightTable): FsDecision {
  const { logOdds, contributions } = scoreFeatures(vector, table);
  const probability = probabilityOfMatch(logOdds);
  const collapseThreshold = table.costRatio / (table.costRatio + 1);
  const verdict: FsVerdict = probability >= collapseThreshold ? "duplicate" : probability >= POSSIBLE_THRESHOLD ? "possible" : "distinct";
  return { verdict, probability, logOdds, collapseThreshold, contributions };
}

export type FsAdjudication = {
  verdict: FsVerdict;
  probability: number;
  logOdds: number;
  method: "veto" | "fellegi-sunter";
  reason: string;
  contributions: FeatureContribution[];
};

/** Log-odds magnitude standing in for a veto's certainty. Not `Infinity`: a harness that
 * averages log-odds across many pairs (as `scripts/reconcile-eval.mjs` does) would have
 * one veto silently poison the mean. `probabilityOfMatch(50)` is already
 * indistinguishable from 1 in floating point, so nothing about the decision changes. */
const VETO_LOG_ODDS = 50;

function describeContributions(contributions: FeatureContribution[]): string {
  if (!contributions.length) return "No informative features observed";
  const strongest = [...contributions].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 3);
  return strongest.map((c) => `${c.feature}=${c.level} (${c.weight >= 0 ? "+" : ""}${c.weight.toFixed(1)})`).join(", ");
}

/**
 * The full E3 path: same vetoes as the production cascade (`checkVetoes`, shared rather
 * than duplicated — see match.ts's own note on why), then Fellegi-Sunter scoring for
 * whatever survives them. `table` defaults to `SEED_WEIGHTS`; `scripts/reconcile-eval.mjs`
 * passes a freshly-trained table when comparing candidates.
 */
export function adjudicateFs(
  proposal: ProposalInput,
  candidate: Candidate,
  table: WeightTable = SEED_WEIGHTS,
  context?: FeatureContext,
): FsAdjudication {
  const vetoed = checkVetoes(proposal, candidate);
  if (vetoed) {
    const isDuplicate = vetoed.verdict === "duplicate";
    return {
      verdict: isDuplicate ? "duplicate" : "distinct",
      probability: probabilityOfMatch(isDuplicate ? VETO_LOG_ODDS : -VETO_LOG_ODDS),
      logOdds: isDuplicate ? VETO_LOG_ODDS : -VETO_LOG_ODDS,
      method: "veto",
      reason: vetoed.reason,
      contributions: [],
    };
  }
  const vector = computeFeatures(proposal, candidate, context);
  const decision = decide(vector, table);
  return {
    verdict: decision.verdict,
    probability: decision.probability,
    logOdds: decision.logOdds,
    method: "fellegi-sunter",
    reason: describeContributions(decision.contributions),
    contributions: decision.contributions,
  };
}

/**
 * `lib/dedup/labels.ts`'s `snapshotAdjudication`, mirrored for the FS path: same
 * "compare `normalized` strings directly instead of hashing them" shortcut (fingerprint
 * equality only ever needs equality, not the actual SHA-256 — the hash is for storage
 * compactness, not correctness), so this stays synchronous and drops into
 * `evaluateReconciliation`'s adjudicator callback exactly like the cascade's own
 * snapshotter does. Used by `scripts/reconcile-eval.mjs` to score the golden set with the
 * FS path for direct comparison against the live cascade.
 */
export function snapshotAdjudicationFs(
  left: { title: string; description?: string },
  right: { title: string; description?: string },
  table: WeightTable = SEED_WEIGHTS,
): FsAdjudication {
  const leftSignature = buildSignature(left.title, left.description ?? "");
  const rightSignature = buildSignature(right.title, right.description ?? "");
  return adjudicateFs(
    { signature: leftSignature, fingerprintValue: leftSignature.normalized },
    { id: "candidate", itemKey: "", title: right.title, status: "", signature: rightSignature, fingerprintValue: rightSignature.normalized },
    table,
  );
}
