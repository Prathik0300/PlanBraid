/**
 * E8 — the one module RECONCILIATION_ARCHITECTURE.md §10 asks for:
 * `relate(A, B) → relation + confidence + explanation`, over the SAME cascade
 * (`checkVetoes` → `adjudicate` for the collapse decision, `classifyRelation` for the
 * typed edge, `explain` for the sentence) every caller answering "how related are these
 * two items" should go through — rather than each caller re-deriving its own scoring
 * (§10's own "two matchers that will disagree in front of a user" warning) or working
 * around the async-fingerprint requirement with its own placeholder value.
 *
 * `.normalized` stands in for a real SHA-256 fingerprint, for equality-comparison
 * purposes only — the same shortcut `lib/dedup/labels.ts`'s `snapshotAdjudication` and
 * `lib/dedup/fellegi-sunter.ts`'s `snapshotAdjudicationFs` already use, safe for the
 * identical reason: `fingerprint()` only ever needs to answer "are these equal," and two
 * equal strings hash to the same value by definition, so comparing the strings directly
 * is exactly as correct and lets every caller here stay synchronous. This is what
 * replaces the ad hoc `fingerprintValue: ""` placeholder `lib/simplify/analyze.ts` used
 * to construct by hand at each call site.
 *
 * `signature` is accepted pre-built on either side specifically so a caller scanning many
 * pairs (Simplify's O(n²) duplicate scan) can compute each item's signature once and
 * reuse it across every pair it appears in, rather than `relate()` silently recomputing
 * it per call — the exact memoization `lib/simplify/analyze.ts` already did by hand
 * before this module existed, preserved here instead of undone by "unifying" it away.
 *
 * Deliberately scoped to the two callers RECONCILIATION_ARCHITECTURE.md §10 names that
 * ask the *same* strict question `create_work_items` asks — "is this the same work, or a
 * typed variant of it" — Simplify, and (via `resolve.ts`'s own direct use of `bestMatch`/
 * `classifyRelation`, which needs the fuller batched-candidate-list shape this simpler
 * pairwise function doesn't provide) `create_work_items` itself. Planning context
 * (`lib/planning/context.ts`) asks a genuinely different, *broader* question — "what's
 * worth knowing about before I plan," where even action-incompatible background is
 * useful context, not something a duplicate-detection veto should silently remove — so
 * its own `relevance()`/`isRelevant()` stays intentionally more permissive and does not
 * route through this module's vetoes; only its CONFLICT-flagging (additive, see that
 * module) reuses `classifyRelation` directly. "Plan merge" (`PLAN_VERSION_CONTROL.md`),
 * §10's fourth named caller, is a distinct, unbuilt feature and out of this milestone.
 */
import { buildSignature, type TaskSignature } from "./signature.ts";
import { adjudicate, explain, type Candidate, type MatchVerdict } from "./match.ts";
import { classifyRelation, type RelationType } from "./relations.ts";

export type RelateSide = { title: string; description?: string; signature?: TaskSignature };
export type RelateCandidate = RelateSide & { id: string; itemKey: string; status: string; updatedAt?: string };

export type Relate = {
  /** The collapse decision — `duplicate` is the only verdict that should ever suppress
   * creating a new item. */
  verdict: MatchVerdict;
  /** The typed edge Stage 3 assigns — what `edgeTypeForRelation` (relations.ts) turns
   * into a real graph edge. */
  relation: RelationType;
  score: number;
  /** The short, raw reason (`adjudicate()`'s own `.reason`, e.g. "Same artifacts
   * (foo.ts)") — for a caller building its own sentence, like a command's audit-trail
   * `reason` field, where `explanation` below would be needlessly verbose or double up
   * on a detail the caller already states itself (the candidate's item key, say). */
  reason: string;
  /** The full, ready-to-show sentence (`explain()`'s own output) — names the candidate,
   * its status and age, and the reason together. What a finding's `detail` field wants. */
  explanation: string;
};

function resolveSignature(side: RelateSide): TaskSignature {
  return side.signature ?? buildSignature(side.title, side.description ?? "");
}

export function relate(proposal: RelateSide, candidate: RelateCandidate): Relate {
  const proposalSignature = resolveSignature(proposal);
  const candidateSignature = resolveSignature(candidate);
  const proposalInput = { signature: proposalSignature, fingerprintValue: proposalSignature.normalized };
  const candidateFull: Candidate = {
    id: candidate.id, itemKey: candidate.itemKey, title: candidate.title, status: candidate.status, updatedAt: candidate.updatedAt,
    signature: candidateSignature, fingerprintValue: candidateSignature.normalized,
  };
  const adjudication = adjudicate(proposalInput, candidateFull);
  const relation = classifyRelation(proposalInput, candidateFull);
  return {
    verdict: adjudication.verdict,
    relation: relation.type,
    score: adjudication.score,
    reason: adjudication.reason,
    explanation: explain({ ...adjudication, candidate: candidateFull }),
  };
}
