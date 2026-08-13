/**
 * The adjudication cascade.
 *
 * Ordered cheapest-and-most-decisive first, with hard vetoes that no similarity score
 * can override. The error costs are asymmetric: a false split leaves one visible
 * duplicate card that anyone can merge later, while a false merge silently loses work
 * and points an agent at the wrong task. Every threshold here is therefore biased
 * toward splitting.
 */

import { actionsAreAntonyms, actionsCompatible, jaccard, type TaskSignature } from "./signature.ts";

export const THRESHOLDS = {
  /** Identical artifact sets plus a compatible action. Strong enough to match on. */
  artifactMatch: 0.95,
  /** Token overlap below this, with no shared artifacts, is not worth reporting. */
  lexicalFloor: 0.3,
  /** Token overlap high enough to flag as a possible duplicate, never to match on. */
  lexicalStrong: 0.75,
};

export type MatchMethod = "fingerprint" | "artifact" | "lexical" | "conflict" | "none";
/**
 * `conflict` (E4, fixes finding F3): opposite intent on the *same* concrete reference —
 * "add auth middleware" and "remove auth middleware" on the same file — is not unrelated
 * work the way antonym actions on disjoint artifacts are. It used to collapse into plain
 * `distinct` here, which is technically safe (never a false merge) but throws away real
 * information: two proposals that name the same thing and mean opposite things about it
 * are worth surfacing to a person, not silently treated the same as two proposals that
 * share nothing at all. `lib/dedup/relations.ts` (Stage 3) is what turns this into an
 * actual raised decision; this module only has to stop discarding the signal.
 */
export type MatchVerdict = "duplicate" | "possible" | "distinct" | "conflict";

export type Candidate = {
  id: string;
  itemKey: string;
  title: string;
  status: string;
  updatedAt?: string;
  signature: TaskSignature;
  fingerprintValue: string | null;
};

export type Adjudication = {
  verdict: MatchVerdict;
  score: number;
  method: MatchMethod;
  reason: string;
};

export type ProposalInput = { signature: TaskSignature; fingerprintValue: string };

/**
 * The hard gates from `DEDUPLICATION_ARCHITECTURE.md §4.2` /
 * `RECONCILIATION_ARCHITECTURE.md §4.1`, factored out so the production cascade
 * (`adjudicate`, below) and E3's Fellegi-Sunter scorer (`lib/dedup/fellegi-sunter.ts`)
 * run the *same* veto checks rather than two independently-maintained copies that could
 * silently drift apart — exactly the "two matchers that disagree in front of a user"
 * failure §10 warns about, one level below where that section applies it.
 *
 * Returns a veto's `Adjudication` if one fires, or `null` if the pair survives every
 * gate and scoring should proceed. Order matters: fingerprint equality is checked first
 * because it is decisive and free, before either veto's own cost is paid.
 */
export function checkVetoes(proposal: ProposalInput, candidate: Candidate): Adjudication | null {
  const left = proposal.signature;
  const right = candidate.signature;

  // 1. Identical canonical form: same action, same object tokens, same artifacts (and,
  //    since E2, the same subsystem/criteria/qualifiers too).
  if (proposal.fingerprintValue && proposal.fingerprintValue === candidate.fingerprintValue) {
    return { verdict: "duplicate", score: 1, method: "fingerprint", reason: "Identical normalized task signature" };
  }

  const sharedArtifacts = left.artifacts.filter((artifact) => right.artifacts.includes(artifact));

  // 2a. Opposite intent on the same subject is never the same task — but when both name
  //     the same concrete artifact, it is not *unrelated* work either (F3): "add auth
  //     middleware" and "remove auth middleware" on the same file are a real CONFLICT, a
  //     person should see, not two cards that happen never to be compared again. Opposite
  //     intent on artifacts that share nothing stays plain `distinct` — an antonym alone,
  //     with no concrete overlap to hang a conflict on, is exactly what `distinct` means.
  if (actionsAreAntonyms(left.action, right.action)) {
    if (sharedArtifacts.length) {
      return {
        verdict: "conflict", score: 0, method: "conflict",
        reason: `Opposite actions (${left.action} vs ${right.action}) on the same artifacts (${sharedArtifacts.join(", ")})`,
      };
    }
    return { verdict: "distinct", score: 0, method: "none", reason: `Opposite actions (${left.action} vs ${right.action})` };
  }

  // 2b. Different concrete references outrank any similarity score. This is what keeps
  //     "rate limit /api/login" and "rate limit /api/signup" apart despite near-identical
  //     wording, and it is the single rule that makes automatic matching safe.
  if (left.artifacts.length && right.artifacts.length && !sharedArtifacts.length) {
    return {
      verdict: "distinct", score: 0, method: "none",
      reason: `Different artifacts (${left.artifacts.join(", ")} vs ${right.artifacts.join(", ")})`,
    };
  }

  // 2c. Same references, different kind of work. "Add X" and "Test X" are both real.
  if (!actionsCompatible(left.action, right.action)) {
    return { verdict: "distinct", score: 0, method: "none", reason: `Different actions (${left.action} vs ${right.action})` };
  }

  return null;
}

/**
 * Pure pairwise decision. No I/O, no database, no clock, no network — every branch is
 * directly testable, which matters because these are the rules that decide whether
 * work gets collapsed.
 */
export function adjudicate(proposal: ProposalInput, candidate: Candidate): Adjudication {
  const vetoed = checkVetoes(proposal, candidate);
  if (vetoed) return vetoed;

  const left = proposal.signature;
  const right = candidate.signature;
  const sharedArtifacts = left.artifacts.filter((artifact) => right.artifacts.includes(artifact));

  // 3. Identical artifact sets with a compatible action: the same work on the same thing.
  if (left.artifacts.length && sharedArtifacts.length === left.artifacts.length && sharedArtifacts.length === right.artifacts.length) {
    return {
      verdict: "duplicate", score: THRESHOLDS.artifactMatch, method: "artifact",
      reason: `Same action (${left.action}) on the same artifacts (${sharedArtifacts.join(", ")})`,
    };
  }

  // 4. Overlapping wording is a hint for a human, never grounds to collapse work.
  const lexical = jaccard(left.objectTokens, right.objectTokens);
  if (lexical >= THRESHOLDS.lexicalStrong || (sharedArtifacts.length > 0 && lexical >= THRESHOLDS.lexicalFloor)) {
    return { verdict: "possible", score: lexical, method: "lexical", reason: `Overlapping wording (${lexical.toFixed(2)})` };
  }
  return { verdict: "distinct", score: lexical, method: "none", reason: "Insufficient overlap" };
}

export type Proposal = { ref?: string; title: string; description?: string; status?: string; priority?: string; dependsOn?: string[] };

// `conflict` ranks above `possible`: a hard structural signal (opposite intent, same
// concrete artifact) is more decisive than a fuzzy lexical resemblance to some other
// candidate, so if a proposal has both, the conflict is what gets surfaced and acted on.
const RANK: Record<MatchVerdict, number> = { duplicate: 3, conflict: 2, possible: 1, distinct: 0 };

/** Picks the strongest verdict across all candidates, breaking ties by score. */
export function bestMatch(proposal: ProposalInput, candidates: Candidate[]): (Adjudication & { candidate: Candidate }) | null {
  let best: (Adjudication & { candidate: Candidate }) | null = null;
  for (const candidate of candidates) {
    const decision = adjudicate(proposal, candidate);
    if (decision.verdict === "distinct") continue;
    if (!best || RANK[decision.verdict] > RANK[best.verdict] || (RANK[decision.verdict] === RANK[best.verdict] && decision.score > best.score)) {
      best = { ...decision, candidate };
    }
  }
  return best;
}

/**
 * Plain-language justification. Scores mean nothing to a person; naming the artifact
 * that matched, and when, means something to both a person and an agent.
 */
export function explain(match: Adjudication & { candidate: Candidate }) {
  const age = match.candidate.updatedAt ? relativeAge(match.candidate.updatedAt) : null;
  const provenance = age ? `, last updated ${age}` : "";
  if (match.candidate.status === "done") {
    return `${match.candidate.itemKey} "${match.candidate.title}" is already done${provenance}. ${match.reason}. Reopen it with evidence if this needs redoing.`;
  }
  if (match.candidate.status === "cancelled") {
    return `${match.candidate.itemKey} "${match.candidate.title}" was cancelled${provenance}. ${match.reason}. Reopen it if this is back in scope.`;
  }
  return `${match.reason} as ${match.candidate.itemKey} "${match.candidate.title}" (${match.candidate.status.replaceAll("_", " ")}${provenance}).`;
}

function relativeAge(timestamp: string) {
  const elapsed = Date.now() - new Date(`${timestamp.replace(" ", "T")}${timestamp.endsWith("Z") ? "" : "Z"}`).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "just now";
  const minutes = Math.round(elapsed / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
