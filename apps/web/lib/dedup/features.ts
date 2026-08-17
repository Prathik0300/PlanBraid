/**
 * E3 — the twelve comparison features (RECONCILIATION_ARCHITECTURE.md §4), computed as
 * discrete agreement *levels* rather than raw scores: Fellegi-Sunter (§4.2) is a model
 * over categorical agreement, not continuous similarity, and bucketing here is what lets
 * `m`/`u` be simple lookup tables instead of a density estimation problem.
 *
 * A feature observation is `null` when there is genuinely nothing to compare — both sides
 * name no artifact, neither has acceptance criteria, and so on — never coerced to a
 * "none/no agreement" level. §4.2's whole argument for Fellegi-Sunter over a hand-tuned
 * cascade is that a missing feature gets weight zero automatically; folding "absent" into
 * "observed and disagreeing" would quietly reintroduce the exact problem FS exists to
 * avoid.
 *
 * Four of the twelve are not computed here at all: f4 (symbol overlap) is *approximated*
 * from unresolved symbol-looking tokens, clearly weaker than the real thing — E7's
 * tree-sitter grounding is what resolves symbols against an actual repository. f8
 * (embedding cosine) needs E5's static embeddings, f10 (graph proximity) needs dependency
 * data, and f11 (implementation overlap) needs evidence/repo-observation data — none of
 * which this module has on its own. All three arrive via `context` when a caller has
 * them; every caller that doesn't simply leaves that feature missing, which Fellegi-Sunter
 * handles correctly by construction.
 */
import { classifyArtifact, compareSubsystems, jaccard, type TaskSignature } from "./signature.ts";

export type FeatureId =
  | "f1_fingerprint" | "f2_artifactJaccard" | "f3_artifactContainment" | "f4_symbolOverlap"
  | "f5_subsystem" | "f6_action" | "f7_lexical" | "f8_embedding"
  | "f9_criteria" | "f10_graphProximity" | "f11_implementationOverlap" | "f12_temporal";

export type FeatureObservation = { level: string } | null;
export type FeatureVector = Record<FeatureId, FeatureObservation>;

/** Shared four-way bucketing for a 0..1 similarity score. Coarse on purpose: with a
 * handful of golden labels to estimate m/u from (§8.1's realistic scale for a single
 * project), four buckets are already close to as much resolution as sparse data supports
 * — more buckets would mean more parameters estimated from the same small sample. */
function bucket4(score: number): string {
  if (score >= 0.8) return "high";
  if (score >= 0.4) return "medium";
  if (score > 0) return "low";
  return "none";
}

function observedJaccard(left: string[], right: string[]): FeatureObservation {
  if (!left.length && !right.length) return null;
  return { level: bucket4(jaccard(left, right)) };
}

function f1(proposalFingerprint: string, candidateFingerprint: string | null): FeatureObservation {
  if (!proposalFingerprint || !candidateFingerprint) return null;
  return { level: proposalFingerprint === candidateFingerprint ? "equal" : "different" };
}

function f2(left: TaskSignature, right: TaskSignature): FeatureObservation {
  return observedJaccard(left.artifacts, right.artifacts);
}

/** `|A∩B| / min(|A|,|B|)` — undefined, not zero, when either side names no artifact at
 * all (the denominator would be zero), unlike f2's Jaccard, which still has a real
 * "one side offers nothing to overlap with" answer when only one side is empty. */
function f3(left: TaskSignature, right: TaskSignature): FeatureObservation {
  if (!left.artifacts.length || !right.artifacts.length) return null;
  const shared = left.artifacts.filter((artifact) => right.artifacts.includes(artifact)).length;
  return { level: bucket4(shared / Math.min(left.artifacts.length, right.artifacts.length)) };
}

/**
 * Jaccard over artifacts `classifyArtifact` already calls "symbol" — by default just
 * unresolved names (`refreshAccessToken`), a guess from spelling alone. E7
 * (RECONCILIATION_ARCHITECTURE.md §7, TS/JS only) grounds that guess: when `context`
 * carries a real symbol table for this project (`repo_symbols`, populated by the
 * bridge's optional tree-sitter parse), a high-overlap match where the shared name is
 * *confirmed* against actual code splits into its own level from one that's merely
 * spelled the same. This is the doc's own claim made concrete — "the highest-precision
 * feature the scorer has" only once it's actually resolved, not before — so the two
 * cases get different weights in `SEED_WEIGHTS` rather than being folded together.
 */
function f4(left: TaskSignature, right: TaskSignature, resolvedSymbols?: ReadonlySet<string>): FeatureObservation {
  const leftSymbols = left.artifacts.filter((artifact) => classifyArtifact(artifact) === "symbol");
  const rightSymbols = right.artifacts.filter((artifact) => classifyArtifact(artifact) === "symbol");
  if (!leftSymbols.length && !rightSymbols.length) return null;
  const score = jaccard(leftSymbols, rightSymbols);
  if (score < 0.5) return { level: score > 0 ? "low" : "none" };
  const shared = leftSymbols.filter((symbol) => rightSymbols.includes(symbol));
  const resolved = resolvedSymbols != null && shared.some((symbol) => resolvedSymbols.has(symbol));
  return { level: resolved ? "high-resolved" : "high-unresolved" };
}

function f5(left: TaskSignature, right: TaskSignature): FeatureObservation {
  const relation = compareSubsystems(left.subsystem, right.subsystem);
  return relation === "unknown" ? null : { level: relation };
}

/** Antonym pairs are vetoed before Fellegi-Sunter scoring ever runs (§3's pipeline —
 * Stage 2a vetoes, then 2b scoring), so "antonym" is real in this function's own output
 * for direct testing, but never actually reaches a live weight lookup in the assembled
 * pipeline. `action` defaults to "unknown" rather than being absent when unclassifiable,
 * so this is never a missing feature — an unclassifiable verb is itself information
 * (weak: neither confirms nor denies agreement), matching `actionsCompatible`'s existing
 * "unknown is a wildcard" rule elsewhere in this module. */
function f6(left: TaskSignature, right: TaskSignature): FeatureObservation {
  if (left.action === "unknown" || right.action === "unknown") return { level: "compatible" };
  return { level: left.action === right.action ? "same" : "compatible" };
}

/**
 * Weighted-field lexical similarity — this module's version of §4's "BM25F over title^3,
 * criteria^2, description^1". Two real deviations from that spec, both because of an
 * existing, deliberate design choice this module inherits rather than overrides:
 * `buildSignature` never turns a description into object tokens ("too noisy to compare as
 * bags of words" — signature.ts's own long-standing reasoning), so there is no
 * description-token field to weight at all, and what's computed here is plain per-field
 * Jaccard rather than true corpus-relative BM25F (which needs document-frequency
 * statistics; E1's rare-token index already computes exactly that for retrieval, and
 * wiring it into this pairwise scoring function is a reasonable future refinement, not
 * something this milestone's own build-order row requires).
 */
function f7(left: TaskSignature, right: TaskSignature): FeatureObservation {
  const titleHasSignal = left.objectTokens.length || right.objectTokens.length;
  const criteriaHasSignal = left.criteria.length || right.criteria.length;
  if (!titleHasSignal && !criteriaHasSignal) return null;
  const titleScore = titleHasSignal ? jaccard(left.objectTokens, right.objectTokens) : null;
  const criteriaScore = criteriaHasSignal ? jaccard(left.criteria, right.criteria) : null;
  const combined = titleScore != null && criteriaScore != null
    ? (titleScore * 3 + criteriaScore * 2) / 5
    : (titleScore ?? criteriaScore)!;
  return { level: bucket4(combined) };
}

function f9(left: TaskSignature, right: TaskSignature): FeatureObservation {
  return observedJaccard(left.criteria, right.criteria);
}

const RESOLVED_STATUSES = new Set(["done", "cancelled"]);
const STALE_DAYS = 14;

/** The candidate's own lifecycle state relative to now — "age gap, status pair,
 * staleness" (§4's f12) folded into one feature, since the proposal side of this
 * comparison is always "just proposed, right now" by construction and contributes no
 * lifecycle information of its own. Always observed: every real candidate has a status. */
function f12(candidateStatus: string, candidateUpdatedAt: string | undefined, now: number): FeatureObservation {
  if (candidateStatus === "cancelled") return { level: "candidate-cancelled" };
  if (!RESOLVED_STATUSES.has(candidateStatus)) return { level: "candidate-active" };
  const updated = candidateUpdatedAt ? Date.parse(candidateUpdatedAt) : NaN;
  const days = Number.isFinite(updated) ? (now - updated) / 86_400_000 : Infinity;
  return { level: days >= STALE_DAYS ? "candidate-done-stale" : "candidate-done-recent" };
}

export type FeatureContext = {
  /** Cosine similarity of static embeddings, 0..1 — E5. */
  embeddingCosine?: number;
  /** Adamic-Adar over shared prerequisites/dependents, already normalized to 0..1 by the
   * caller — computing it needs the project's dependency graph, which this pure module
   * deliberately does not fetch itself. */
  graphProximity?: number;
  /** Fraction of evidence-attached files shared between the two items, 0..1 — needs M15's
   * repo_observations/evidence data, fetched by the caller. */
  implementationOverlap?: number;
  /** E7 — every symbol name tree-sitter has actually confirmed exists in this project's
   * code (`repo_symbols`), fetched by the caller. Absent or empty both leave f4 at
   * `high-unresolved` rather than `high-resolved` — there is nothing to confirm against
   * either way, so the two cases are handled identically on purpose, not distinguished. */
  resolvedSymbols?: ReadonlySet<string>;
  candidateStatus?: string;
  candidateUpdatedAt?: string;
  now?: number;
};

/**
 * The full feature vector for one proposal/candidate pair. Pure given `context` — nothing
 * here touches a database, a clock (`context.now` defaults to `Date.now()` only as a
 * convenience for callers that don't care), or a network boundary, matching every other
 * stage of this pipeline that can be pure.
 */
export function computeFeatures(
  proposal: { signature: TaskSignature; fingerprintValue: string },
  candidate: { signature: TaskSignature; fingerprintValue: string | null },
  context: FeatureContext = {},
): FeatureVector {
  const left = proposal.signature;
  const right = candidate.signature;
  const now = context.now ?? Date.now();
  return {
    f1_fingerprint: f1(proposal.fingerprintValue, candidate.fingerprintValue),
    f2_artifactJaccard: f2(left, right),
    f3_artifactContainment: f3(left, right),
    f4_symbolOverlap: f4(left, right, context.resolvedSymbols),
    f5_subsystem: f5(left, right),
    f6_action: f6(left, right),
    f7_lexical: f7(left, right),
    f8_embedding: context.embeddingCosine == null ? null : { level: bucket4(context.embeddingCosine) },
    f9_criteria: f9(left, right),
    f10_graphProximity: context.graphProximity == null ? null : { level: bucket4(context.graphProximity) },
    f11_implementationOverlap: context.implementationOverlap == null ? null : { level: bucket4(context.implementationOverlap) },
    f12_temporal: context.candidateStatus == null ? null : f12(context.candidateStatus, context.candidateUpdatedAt, now),
  };
}
