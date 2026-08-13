/**
 * How much a work item's current state should be believed.
 *
 * Derived, never stored, for the same reason the board column is derived: a confidence
 * score written into a row is a claim about a moment, and the moment passes. An item
 * marked "high confidence: verified" three weeks ago, whose evidence has since been
 * deleted and whose blocker has since reopened, is not high confidence — but a stored
 * number would still say so, and a stale trust signal is worse than none.
 *
 * Pure: no database, no network, and `now` is a parameter. Every branch is directly
 * testable, which matters because this is the number a person uses to decide whether to
 * re-check an agent's work.
 */
import type { WorkEvent, WorkItem } from "@/lib/contracts";
import { isVerifiedProvenance, provenanceLabel, provenanceStrength, strongestProvenance, type Provenance } from "./provenance.ts";

export type ConfidenceLevel = "high" | "medium" | "low";

export type Confidence = {
  level: ConfidenceLevel;
  /** Plain sentences, in the order they should be read. Never a bare score. */
  reasons: string[];
  /** The strongest provenance behind the current state, if anything recorded one. */
  basis: Provenance | null;
  /** When the state was last touched by something at least as strong as its basis. */
  lastConfirmedAt: string | null;
  /** How many distinct model families independently proposed this. */
  corroboration: number;
};

export type ConfidenceInput = {
  item: Pick<WorkItem, "id" | "status" | "maturity" | "statusProvenance" | "verificationStatus" | "completionConfidence" | "updatedAt">;
  /** Events for this item, newest first. */
  events: Pick<WorkEvent, "eventType" | "createdAt" | "provenance">[];
  /** Distinct model families that proposed it, from aliases. Callers already compute this
   * for ranking; it is passed in rather than recomputed so the two can never disagree. */
  corroboration: number;
  /** Whether any evidence is attached at all, and whether any of it was machine-checked. */
  evidenceCount: number;
  verifiedEvidenceCount: number;
  now: number;
};

/** Past this, an unconfirmed claim is old enough to be worth re-checking. */
const STALE_DAYS = 14;

function daysSince(timestamp: string, now: number) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor((now - parsed) / 86_400_000));
}

function provenanceOf(event: { provenance: string | null }) {
  return event.provenance;
}

/**
 * The rules, in the order they fire. Completion is judged hardest because it is the claim
 * most often wrong: "an agent says it finished" and "the implementation exists" are the
 * distinction this whole trust layer exists to preserve.
 */
export function confidenceOf(input: ConfidenceInput): Confidence {
  const { item, events, now } = input;
  // The item's own status provenance is the primary basis; the event log can only raise it
  // (a later verification), never lower it.
  const provenances = [item.statusProvenance, ...events.map(provenanceOf)].filter((value): value is string => Boolean(value));
  const basis = strongestProvenance(provenances);
  const lastConfirmedAt = events.find((event) => {
    const value = provenanceOf(event);
    return value != null && basis != null && provenanceStrength(value) >= provenanceStrength(basis);
  })?.createdAt ?? null;

  const reasons: string[] = [];
  const age = daysSince(lastConfirmedAt ?? item.updatedAt, now);
  const claimsDone = item.status === "done";
  const verified = input.verifiedEvidenceCount > 0 || (basis != null && isVerifiedProvenance(basis));

  if (basis) reasons.push(`Current state ${provenanceLabel[basis]}.`);

  // 1. A completion claim is only as good as its evidence.
  if (claimsDone) {
    if (verified) reasons.push("Completion is backed by machine-checked evidence.");
    else if (input.evidenceCount > 0) reasons.push("Completion has evidence attached, but nothing has checked it.");
    else reasons.push("Marked done with no evidence attached.");
  }

  // 2. Independent agreement is real evidence about a proposal, and nothing about whether
  //    the work happened. Reported either way, weighed only for the former.
  if (input.corroboration > 1) reasons.push(`Proposed independently by ${input.corroboration} different models.`);

  // 3. Age is the signal that quietly invalidates the rest.
  if (age >= STALE_DAYS) reasons.push(`Nothing has confirmed this for ${age} days.`);

  const level = levelFor({ claimsDone, verified, hasEvidence: input.evidenceCount > 0, basis, corroboration: input.corroboration, age, maturity: item.maturity });
  if (!reasons.length) reasons.push("No corroborating record either way.");

  return { level, reasons, basis, lastConfirmedAt, corroboration: input.corroboration };
}

function levelFor(input: { claimsDone: boolean; verified: boolean; hasEvidence: boolean; basis: Provenance | null; corroboration: number; age: number; maturity: string }): ConfidenceLevel {
  // A completion nobody checked is the single most misleading state in the product, so it
  // is capped at low regardless of how strong the rest of the record looks.
  if (input.claimsDone && !input.verified) return input.hasEvidence ? "medium" : "low";
  if (input.verified) return input.age >= STALE_DAYS ? "medium" : "high";

  const strength = provenanceStrength(input.basis ?? "");
  // An unaccepted proposal is not a weak fact about the project; it is an accurate fact
  // about a proposal. It gets no confidence boost from agreement and no penalty for age.
  if (input.maturity === "proposal" || input.maturity === "idea") return input.corroboration > 1 ? "medium" : "low";
  if (strength >= 4) return input.age >= STALE_DAYS ? "medium" : "high";
  if (strength >= 3 || input.corroboration > 1) return "medium";
  return "low";
}
