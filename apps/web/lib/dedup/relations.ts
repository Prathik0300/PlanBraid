/**
 * E4 — Stage 3, relation typing (RECONCILIATION_ARCHITECTURE.md §3's pipeline diagram:
 * "set algebra, not statistics"). Stage 2 already answered "is this the same work"; this
 * stage answers "given that it probably isn't, what IS the relationship" for whatever
 * survives Stage 2 as `possible` or `conflict` — the one thing a proposal collapsing into
 * `duplicate` doesn't need, since it never becomes a second item to relate to anything.
 *
 * Pure, like every stage before it: no database, no clock, no network. Built directly on
 * `checkVetoes` (the same shared gate `adjudicate()` and `adjudicateFs()` both run first)
 * and `computeFeatures`'s f2/f3 artifact signals from E3, rather than a third
 * independent read of the same fields — the "two matchers that disagree" trap §10 warns
 * about applies to a third classifier just as much as a second scorer.
 */
import { checkVetoes, type Candidate, type ProposalInput } from "./match.ts";
import { jaccard } from "./signature.ts";
import type { AnnotationEdgeType } from "@/lib/graph/edges.ts";

export type RelationType = "DUPLICATE" | "SUBSET" | "SUPERSET" | "OVERLAP" | "CONFLICT" | "SEQUENCE" | "RELATED" | "NEW";

export type Relation = { type: RelationType; reason: string };

/**
 * SEQUENCE is listed here — it is a real relation type in §3's Stage 3 vocabulary, and
 * `edgeTypeForRelation` below maps it to a real edge type (`follows`) for whenever a
 * future signal can produce it — but `classifyRelation` never actually returns it today,
 * on purpose, not as an oversight. Detecting it needs two *different, both recognized*
 * action classes on shared ground (e.g. "add" the retry logic, later "test" the retry
 * logic) — and `checkVetoes`' veto 2c already vetoes exactly that combination to `distinct`
 * before Stage 3 ever runs, for any pair where neither action is `unknown`. §4.1 is
 * explicit that vetoes must stay absolute ("no learned weight may override them... keep
 * the gates"), so making SEQUENCE reachable would mean loosening veto 2c — a real,
 * separate design decision this milestone does not make. Verified by test
 * (`relations.test.mjs`) rather than left as an unstated gap.
 *
 * The same reasoning kills a subsystem-only RELATED case ("same directory, no shared
 * file"): veto 2b vetoes any pair where both sides name artifacts that don't intersect,
 * regardless of subsystem, and `deriveSubsystem` can only produce a value from file-kind
 * artifacts in the first place — so "same subsystem, disjoint artifacts" and "same
 * subsystem, no file artifacts at all" are both structurally unreachable too. RELATED
 * below is therefore driven by lexical similarity alone, which — unlike a subsystem
 * guess — is a signal §4's own feature table already trusts at a comparable bar
 * (`THRESHOLDS.lexicalFloor` in match.ts).
 */
const CONTAINMENT_SUBSET_BAR = 0.8;
/** Jaccard (§4's f2) at or above this bar is "these substantially describe the same
 * files," below it but still positive is "these touch some of the same ground" —
 * OVERLAP's bar. Lower than f2's own "low" bucket (0.0–0.4) on purpose: OVERLAP only
 * needs *some* genuine shared reference to be worth a link, not a strong one — a weak
 * link a person can ignore costs far less than silence about a real connection. */
const OVERLAP_JACCARD_BAR = 0.15;
/** Lexical (title-token) similarity high enough to call two proposals RELATED with no
 * shared artifact at all — the exact bar `THRESHOLDS.lexicalFloor` in match.ts already
 * uses for "worth mentioning as a possible match," so RELATED never fires on weaker
 * evidence than the cascade itself already trusts. */
const RELATED_LEXICAL_BAR = 0.3;

/**
 * Classifies the relationship between a proposal and one candidate. Callers pass the
 * single candidate they already care about (typically `bestMatch`'s winner) rather than
 * this module re-scanning a whole candidate list — Stage 2 already did that ranking, and
 * duplicating it here would risk the two disagreeing about which candidate matters most.
 */
export function classifyRelation(proposal: ProposalInput, candidate: Candidate): Relation {
  const vetoed = checkVetoes(proposal, candidate);
  if (vetoed) {
    if (vetoed.verdict === "duplicate") return { type: "DUPLICATE", reason: vetoed.reason };
    if (vetoed.verdict === "conflict") return { type: "CONFLICT", reason: vetoed.reason };
    // A plain `distinct` veto (disjoint artifacts, or incompatible non-antonym actions,
    // or an antonym with nothing shared to conflict over) means there is nothing here to
    // relate — Stage 3's NEW is exactly "create it standalone," the same outcome as
    // today's un-typed behavior.
    return { type: "NEW", reason: vetoed.reason };
  }

  const left = proposal.signature;
  const right = candidate.signature;
  const sharedArtifacts = left.artifacts.filter((artifact) => right.artifacts.includes(artifact));

  if (left.artifacts.length && right.artifacts.length && sharedArtifacts.length) {
    // Equal artifact sets on both sides with a compatible action (vetoes already ruled
    // out antonyms and incompatibility) is the cascade's own "artifact match" rule
    // (match.ts's THRESHOLDS.artifactMatch case) — relation typing has to agree with it,
    // not offer a second opinion, so this reads as DUPLICATE rather than SUBSET/SUPERSET
    // of exactly equal size.
    if (sharedArtifacts.length === left.artifacts.length && sharedArtifacts.length === right.artifacts.length) {
      return { type: "DUPLICATE", reason: `Same action on the same artifacts (${sharedArtifacts.join(", ")})` };
    }
    const containment = sharedArtifacts.length / Math.min(left.artifacts.length, right.artifacts.length);
    if (containment >= CONTAINMENT_SUBSET_BAR) {
      return left.artifacts.length < right.artifacts.length
        ? { type: "SUBSET", reason: `This proposal's artifacts are contained in the candidate's (${sharedArtifacts.join(", ")})` }
        : { type: "SUPERSET", reason: `This proposal's artifacts contain the candidate's (${sharedArtifacts.join(", ")})` };
    }
    if (jaccard(left.artifacts, right.artifacts) >= OVERLAP_JACCARD_BAR) {
      return { type: "OVERLAP", reason: `Overlapping artifacts (${sharedArtifacts.join(", ")})` };
    }
  }

  // RELATED: title-wording overlap is the only signal left that survives the vetoes
  // without a shared artifact (see the module comment above for why subsystem-only
  // relatedness can't be reached).
  const lexical = jaccard(left.objectTokens, right.objectTokens);
  if (lexical >= RELATED_LEXICAL_BAR) {
    return { type: "RELATED", reason: `Overlapping wording (${lexical.toFixed(2)})` };
  }

  return { type: "NEW", reason: "No meaningful overlap with this candidate" };
}

/**
 * The graph edge a typed relation becomes, `null` for the two types that don't produce
 * one: DUPLICATE is handled by the existing collapse path (the item never gets created
 * standalone, so there is nothing to link), and NEW is genuinely nothing to record. The
 * caller (`lib/store.ts`) always links from the newly-created item to the matched
 * candidate — SUBSET and SUPERSET read naturally from the new item's own perspective
 * ("this is a subset of that"), so the edge direction is consistent for every type.
 */
export function edgeTypeForRelation(type: RelationType): AnnotationEdgeType | null {
  switch (type) {
    case "SUBSET": return "subset_of";
    case "SUPERSET": return "superset_of";
    case "OVERLAP": return "overlaps_with";
    case "CONFLICT": return "conflicts_with";
    case "SEQUENCE": return "follows";
    case "RELATED": return "relates_to";
    case "DUPLICATE": case "NEW": return null;
  }
}
