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

export type MatchMethod = "fingerprint" | "artifact" | "lexical" | "none";
export type MatchVerdict = "duplicate" | "possible" | "distinct";

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
 * Pure pairwise decision. No I/O, no database, no clock, no network — every branch is
 * directly testable, which matters because these are the rules that decide whether
 * work gets collapsed.
 */
export function adjudicate(proposal: ProposalInput, candidate: Candidate): Adjudication {
  const left = proposal.signature;
  const right = candidate.signature;

  // 1. Identical canonical form: same action, same object tokens, same artifacts.
  if (proposal.fingerprintValue && proposal.fingerprintValue === candidate.fingerprintValue) {
    return { verdict: "duplicate", score: 1, method: "fingerprint", reason: "Identical normalized task signature" };
  }

  // 2a. Opposite intent on the same subject is never the same task.
  if (actionsAreAntonyms(left.action, right.action)) {
    return { verdict: "distinct", score: 0, method: "none", reason: `Opposite actions (${left.action} vs ${right.action})` };
  }

  // 2b. Different concrete references outrank any similarity score. This is what keeps
  //     "rate limit /api/login" and "rate limit /api/signup" apart despite near-identical
  //     wording, and it is the single rule that makes automatic matching safe.
  const sharedArtifacts = left.artifacts.filter((artifact) => right.artifacts.includes(artifact));
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

const RANK: Record<MatchVerdict, number> = { duplicate: 2, possible: 1, distinct: 0 };

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
