/**
 * M16 — evidence-backed completion (feature 6, §9 decision 1).
 *
 * "Claude says it finished" must stop being sufficient. Before this module, the MCP
 * report_completion tool trusted a `verified` boolean the calling agent set on itself —
 * an agent could always pass `verified: true` and land directly on `done` with nothing
 * checking the claim at all, which is the exact gap feature 6 exists to close.
 *
 * The fix is to stop trusting the *caller's* claim and start trusting the *evidence's*
 * own `result` field instead, using the same definition of "verified" M9's
 * lib/trust/confidence.ts already uses (`result === "verified"`) so the two halves of the
 * trust model can never quietly disagree about what counts. That evidence comes from
 * exactly one mechanical source today: M15's report_repo_state, which only ever writes
 * `result: "verified"` when a configured verification command actually exited zero — not
 * from anything an agent asserts about itself in this call.
 *
 * `done is reached by a human, or by the verifier when machine evidence passes` (roadmap
 * §9, decision 1): this function is that verifier. A human still reaches `done` directly
 * through the web UI's status control, which calls `transition_item` itself and is
 * entirely unaffected by this gate — M8's authority model already trusts a browser
 * principal completely; this module only closes the *agent* path.
 *
 * One detail that matters: the gate is decided from evidence that already existed
 * *before* this call, never from evidence this same call is attaching. Deciding it after
 * inserting the call's own entries would let an agent write `result: "verified"` straight
 * into its own evidence array and reach `done` immediately — identical to the old
 * `verified: true` boolean, just wearing a different field name. "The verifier" has to be
 * a separate act from "the claim," and the one mechanical source of pre-existing
 * `result: "verified"` evidence today is M15's report_repo_state, which computes that
 * value itself from a real exit code in an earlier call, never from anything asserted
 * inside this one.
 */
import { executeCommand, organizationFor, type Principal } from "@/lib/store.ts";
import { currentVersionOf } from "@/lib/read/project-view.ts";
import type { PgD1 } from "@/db/pg-d1";

function domainError(code: string, message: string, status = 422, details?: unknown) {
  return Object.assign(new Error(message), { code, status, details });
}

export type CompletionEvidenceInput = { type?: string; label?: string; uri?: string; result?: string };

export type ReportCompletionInput = {
  projectId: string;
  itemId: string;
  summary: string;
  evidence?: CompletionEvidenceInput[];
  sourceId?: string;
  idempotencyKey: string;
};

export type ReportCompletionResult = { itemId: string; status: "done" | "in_review"; verified: boolean; projectRevision: number };

async function digest(value: string) {
  const hashed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function reportCompletion(db: PgD1, principal: Principal, input: ReportCompletionInput): Promise<ReportCompletionResult> {
  const organizationId = await organizationFor(db, principal);
  const key = input.idempotencyKey;
  // A dedicated top-level idempotency check, not just the sub-commands' own keys below.
  // Reason: the transition's expectedVersion is read fresh on every call, and a retry
  // after the first call already succeeded would see a version the sub-commands' own
  // idempotent replays don't advance to — a genuine version mismatch, not a duplicate
  // request, and executeCommand would correctly reject it as IDEMPOTENCY_MISMATCH.
  // Short-circuiting here, before any of that version arithmetic happens, is what makes a
  // retry return the original result instead of erroring.
  const scope = `${organizationId}:${principal.userId}:report_completion`;
  const cached = await db.prepare("SELECT response FROM idempotency_records WHERE scope = ? AND idempotency_key = ?").bind(scope, key).first<{ response: string }>();
  if (cached) return JSON.parse(cached.response) as ReportCompletionResult;

  // Decided from evidence that already existed before this call — see the module note on
  // why that ordering, not "after attaching this call's own evidence", is load-bearing.
  const verifiedBefore = await db.prepare("SELECT 1 FROM evidence WHERE work_item_id = ? AND result = 'verified' LIMIT 1").bind(input.itemId).first();
  const verified = Boolean(verifiedBefore);
  const status = verified ? "done" : "in_review";

  await executeCommand(db, principal, { action: "add_note", projectId: input.projectId, itemId: input.itemId, summary: input.summary, sourceId: input.sourceId, idempotencyKey: `${key}:summary` });
  for (const [index, entry] of (input.evidence ?? []).entries()) {
    await executeCommand(db, principal, {
      action: "add_evidence", projectId: input.projectId, itemId: input.itemId, type: entry.type ?? "agent_claim",
      label: entry.label ?? "Completion evidence", uri: entry.uri, result: entry.result, sourceId: input.sourceId,
      idempotencyKey: `${key}:evidence:${index}`,
    });
  }

  const latest = await currentVersionOf(db, organizationId, input.itemId);
  if (!latest) throw domainError("NOT_FOUND", "Work item not found", 404);

  const response = await executeCommand(db, principal, {
    action: "transition_item", projectId: input.projectId, itemId: input.itemId, expectedVersion: latest.version, status,
    reason: verified ? "Completion reported, backed by machine-verified evidence" : "Completion reported; awaiting verification or human review",
    sourceId: input.sourceId, idempotencyKey: `${key}:transition`,
  }) as unknown as { projectRevision: number };

  const result: ReportCompletionResult = { itemId: input.itemId, status, verified, projectRevision: response.projectRevision };
  await db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?) ON CONFLICT (scope, idempotency_key) DO NOTHING")
    .bind(scope, key, await digest(JSON.stringify(input)), JSON.stringify(result)).run();
  return result;
}
