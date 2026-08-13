/**
 * Where a piece of planning information came from.
 *
 * Planbraid mixes claims of very different strength: an agent's guess, an agent's report
 * of what a person said, a person's own click, and a machine check against the repository.
 * Recorded identically they become indistinguishable, and then "the plan says this is
 * done" means nothing. Every write stamps one of these.
 *
 * Ordered weakest to strongest. The ordering is load-bearing: lib/trust/confidence.ts
 * derives a level from the strongest provenance backing a claim, so adding a class means
 * deciding where it sits.
 */
import type { Principal } from "@/lib/store";

export const PROVENANCES = [
  /** Planbraid worked it out itself — a duplicate match, an inferred relationship. */
  "ai_inferred",
  /** An agent said so. The default for anything arriving over MCP. */
  "ai_proposed",
  /** An agent reported that a person decided this, and named them. */
  "human_stated",
  /** A person did it themselves, signed in. */
  "human_approved",
  /** Observed in the working tree: files changed, a command run and its exit status. */
  "code_observed",
  /** Tied to a commit that exists and touches the claimed scope. */
  "git_verified",
  /** Confirmed by a passing check outside the developer's machine. */
  "ci_verified",
] as const;

export type Provenance = (typeof PROVENANCES)[number];

const STRENGTH: Record<Provenance, number> = {
  ai_inferred: 1, ai_proposed: 2, human_stated: 3, human_approved: 4,
  code_observed: 5, git_verified: 6, ci_verified: 7,
};

export function provenanceStrength(value: string) {
  return STRENGTH[value as Provenance] ?? 0;
}

export function strongestProvenance(values: Iterable<string>): Provenance | null {
  let best: Provenance | null = null;
  for (const value of values) {
    if (provenanceStrength(value) > provenanceStrength(best ?? "")) best = value as Provenance;
  }
  return best;
}

/**
 * The class a write gets from who made it.
 *
 * A signed-in person in the web UI is `human_approved`. Everything arriving over a token
 * or OAuth connection is `ai_proposed` unless it names the person whose decision it is
 * reporting, which is the one case an agent can legitimately claim human authority — and
 * it lands a rung lower than a click, deliberately.
 */
export function provenanceFor(principal: Principal, options: { statedBy?: string | null; inferred?: boolean } = {}): Provenance {
  if (options.inferred) return "ai_inferred";
  if (principal.authentication === "browser") return "human_approved";
  return options.statedBy?.trim() ? "human_stated" : "ai_proposed";
}

/** Plain-language name, for the drawer and for anything an agent reads back. */
export const provenanceLabel: Record<Provenance, string> = {
  ai_inferred: "inferred by Planbraid",
  ai_proposed: "reported by an agent",
  human_stated: "stated by a person, via an agent",
  human_approved: "confirmed by you",
  code_observed: "observed in the working tree",
  git_verified: "verified against a commit",
  ci_verified: "verified by CI",
};

export function isVerifiedProvenance(value: string) {
  return provenanceStrength(value) >= STRENGTH.code_observed;
}
