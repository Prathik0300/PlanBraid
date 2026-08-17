/**
 * E6 — Tier A, the answering half (RECONCILIATION_ARCHITECTURE.md §9). Needs
 * `organizationFor` from `lib/store.ts`, so this lives above that module rather than
 * inside it — the identical reason `lib/planning/decisions.ts`'s `raiseConflictDecisions`
 * isn't called from `lib/store.ts` either. The question-raising half
 * (`lib/dedup/judgments.ts`) has no such dependency and is what `lib/store.ts` calls
 * directly while creating the proposal.
 *
 * Answering a judgment only ever captures a label (E0's golden set) — it never merges,
 * links, or otherwise mutates the graph on its own. §9 frames the whole point of auditing
 * judgments against later human actions as *not* trusting an agent's "same"/"different" at
 * face value ("the proposing agent has a mild incentive to answer different so its task
 * gets created"); automatically acting on the answer would be exactly the trust this
 * milestone exists to avoid extending.
 */
import type { PgD1 } from "@/db/pg-d1";
import { organizationFor, type Principal } from "@/lib/store.ts";
import { captureLabelStatement, type LabelVerdict } from "@/lib/dedup/labels.ts";
import { isAcceptableJustification } from "@/lib/dedup/judgments.ts";
import { providerFamily } from "@/lib/providers.ts";

function domainError(code: string, message: string, status = 422, details?: unknown) {
  return Object.assign(new Error(message), { code, status, details });
}

type JudgmentRequestRow = {
  id: string; organization_id: string; project_id: string; left_item_id: string; right_item_id: string;
  question: string; status: string; answered_verdict: string | null;
};

export type JudgmentAnswer = {
  pairId: string;
  status: "answered";
  verdict: LabelVerdict;
  /** True when this call found the request already answered the same way — a retry, not
   * a new answer — and simply replayed the existing state rather than erroring or
   * double-counting a second label. */
  alreadyAnswered: boolean;
};

/**
 * Records an answer to a standing judgment request. Rejects a justification that fails
 * §9's honesty check before touching the database at all — the whole point of requiring
 * one is that a bare verdict is worth nothing as a label, so there is no partial-credit
 * path where a trivial justification still gets recorded.
 */
export async function submitJudgment(
  db: PgD1, principal: Principal,
  input: { projectId: string; pairId: string; verdict: LabelVerdict; justification: string; sourceId?: string },
): Promise<JudgmentAnswer> {
  if (!isAcceptableJustification(input.justification)) {
    throw domainError(
      "VALIDATION_FAILED",
      "Justification must name a specific artifact or behavior, not a bare verdict like \"different\" or \"same\" — see the evidence in the original question and reference what actually distinguishes (or matches) the two.",
    );
  }

  const organizationId = await organizationFor(db, principal);
  const row = await db.prepare("SELECT * FROM reconciliation_judgment_requests WHERE id = ? AND project_id = ? AND organization_id = ?")
    .bind(input.pairId, input.projectId, organizationId).first<JudgmentRequestRow>();
  if (!row) throw domainError("NOT_FOUND", "Judgment request not found", 404);

  if (row.status === "answered") {
    // Same answer twice looks like a client retry, not new evidence — replay rather than
    // erroring or writing a second, redundant label. A different answer to an
    // already-answered question is a genuine conflict, matching resolveDecision's own
    // "already resolved a different way" rule.
    if (row.answered_verdict === input.verdict) return { pairId: input.pairId, status: "answered", verdict: input.verdict, alreadyAnswered: true };
    throw domainError("VALIDATION_FAILED", "This judgment was already answered differently — it cannot be re-answered.", 422);
  }

  const source = input.sourceId
    ? await db.prepare("SELECT provider FROM sources WHERE id = ? AND organization_id = ?").bind(input.sourceId, organizationId).first<{ provider: string }>()
    : null;
  const family = source ? providerFamily(source.provider) : undefined;

  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE reconciliation_judgment_requests SET status = 'answered', answered_verdict = ?, answered_justification = ?, answered_by_source_id = ?, answered_at = ? WHERE id = ? AND organization_id = ?")
      .bind(input.verdict, input.justification.slice(0, 1000), input.sourceId ?? null, now, input.pairId, organizationId),
    captureLabelStatement(db, {
      organizationId, projectId: input.projectId, leftItemId: row.left_item_id, rightItemId: row.right_item_id,
      verdict: input.verdict,
      // Weaker than a human action (merge/split default to 'high') but stronger than a
      // dismissal ('weak') — an agent with the repository open and a required
      // justification is real evidence, just not yet audited against a human.
      confidence: "medium",
      source: "judgment",
      adjudication: {
        verdict: input.verdict === "same" ? "duplicate" : "distinct",
        score: input.verdict === "same" ? 1 : 0,
        method: "judgment",
        reason: input.justification,
      },
      justification: input.justification,
      providerFamily: family,
    }),
  ]);

  return { pairId: input.pairId, status: "answered", verdict: input.verdict, alreadyAnswered: false };
}
