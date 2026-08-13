/**
 * M19 — decisions and conflicts.
 *
 * "AI-generated planning should not automatically become project policy." A decision is
 * an ordinary work item (`type: 'decision'`) carrying a set of options; recording one is
 * open to anyone, agent or person, because *noticing* a conflict is exactly the kind of
 * thing an agent is well placed to do — but resolving one is human-only, the same D1
 * principal check the maturity ladder already enforces, because a resolution is the one
 * write in this whole product that permanently forecloses an approach for every future
 * agent that might otherwise propose it again.
 *
 * Deliberately built entirely on primitives that already exist rather than a parallel
 * write path: creating the decision item goes through the same `create_item` command as
 * any task (now carrying an actual `type`), linking an option to competing work goes
 * through `add_dependency` with the `conflicts_with` annotation type, and resolving
 * supersedes the losing side through the same `transition_item` path everything else
 * uses — which means every one of those writes already gets provenance (M9), an op-log
 * entry (M25), and idempotent replay for free, because they are not special-cased here at
 * all.
 */
import { executeCommand, organizationFor, type Principal } from "@/lib/store.ts";
import { loadProjectView } from "@/lib/read/project-view.ts";
import type { PgD1 } from "@/db/pg-d1";

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function isHumanPrincipal(principal: Principal) {
  return principal.authentication === "browser";
}

function domainError(code: string, message: string, status = 422, details?: unknown) {
  return Object.assign(new Error(message), { code, status, details });
}

export type DecisionOptionInput = { label: string; relatedWorkItemId?: string; rationale?: string };

export type DecisionOption = {
  id: string;
  label: string;
  relatedWorkItemId: string | null;
  rationale: string;
  status: "open" | "accepted" | "rejected";
};

export type Decision = {
  workItemId: string;
  itemKey: string;
  question: string;
  status: string;
  options: DecisionOption[];
};

function mapOption(row: Record<string, unknown>): DecisionOption {
  return {
    id: String(row.id), label: String(row.label),
    relatedWorkItemId: row.related_work_item_id ? String(row.related_work_item_id) : null,
    rationale: String(row.rationale ?? ""), status: String(row.status ?? "open") as DecisionOption["status"],
  };
}

/**
 * Raises a decision. At least two options are required — a "decision" with one option
 * is just a proposal, and forcing the real minimum here is what keeps this feature from
 * becoming a second way to create an ordinary task.
 */
export async function recordDecision(
  db: PgD1, principal: Principal,
  input: { projectId: string; question: string; description?: string; options: DecisionOptionInput[]; sourceId?: string; idempotencyKey: string },
): Promise<Decision> {
  const cleanOptions = input.options.map((option) => ({ ...option, label: option.label.trim().slice(0, 240) })).filter((option) => option.label);
  if (cleanOptions.length < 2) throw domainError("VALIDATION_FAILED", "A decision needs at least two options to be a decision");

  const organizationId = await organizationFor(db, principal);
  const created = await executeCommand(db, principal, {
    action: "create_item", projectId: input.projectId, title: input.question.trim().slice(0, 240) || "Untitled decision",
    description: input.description, type: "decision",
    // A decision is open the moment it's raised, not a task awaiting acceptance into a
    // plan — so it starts at 'in_progress' rather than the normal 'proposed' default.
    // This also matters mechanically: ALLOWED_TRANSITIONS (store.ts) only allows a direct
    // move to 'done' from 'in_progress' or 'in_review', and resolveDecision closes a
    // decision in one step with no intermediate planned/ready hops to walk through.
    status: "in_progress",
    // Requesting 'accepted' here is a preference, not a guarantee: create_item's existing
    // clamp (store.ts) still holds an agent-raised decision to 'proposal' until a human
    // touches it, exactly like any other item. That is the right behavior, not a gap to
    // route around — an agent flagging a conflict shouldn't get to also declare it settled.
    maturity: "accepted", sourceId: input.sourceId, idempotencyKey: `${input.idempotencyKey}:create`,
  }) as unknown as { itemId: string; itemKey: string };

  // create_item above replays idempotently on a retry (same itemId back), but the option
  // rows and conflicts_with edges below are not behind that same idempotency record, so a
  // naive retry would insert every option a second time. Guard on whether this decision
  // already has options instead: real first call, none yet; replay, already there.
  const already = await db.prepare("SELECT COUNT(*)::int AS count FROM decision_options WHERE decision_work_item_id = ? AND organization_id = ?").bind(created.itemId, organizationId).first<{ count: number }>();
  if (Number(already?.count ?? 0) > 0) return readDecision(db, organizationId, created.itemId, created.itemKey);

  for (const [index, option] of cleanOptions.entries()) {
    await db.prepare(
      "INSERT INTO decision_options (id, organization_id, project_id, decision_work_item_id, label, related_work_item_id, rationale, proposed_by_source_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')",
    ).bind(id("opt"), organizationId, input.projectId, created.itemId, option.label, option.relatedWorkItemId ?? null, option.rationale?.trim().slice(0, 1000) ?? "", input.sourceId ?? null).run();

    if (option.relatedWorkItemId) {
      await executeCommand(db, principal, {
        action: "add_dependency", projectId: input.projectId, fromWorkItemId: created.itemId, toWorkItemId: option.relatedWorkItemId,
        type: "conflicts_with", reason: `Option in decision ${created.itemKey}`, sourceId: input.sourceId, idempotencyKey: `${input.idempotencyKey}:conflicts:${index}`,
      });
    }
  }

  return readDecision(db, organizationId, created.itemId, created.itemKey);
}

async function readDecision(db: PgD1, organizationId: string, workItemId: string, itemKey?: string): Promise<Decision> {
  const [itemRow, optionRows] = await db.batch([
    db.prepare("SELECT item_key, title, status FROM work_items WHERE id = ? AND organization_id = ?").bind(workItemId, organizationId),
    db.prepare("SELECT * FROM decision_options WHERE decision_work_item_id = ? AND organization_id = ? ORDER BY created_at").bind(workItemId, organizationId),
  ]);
  const item = (itemRow.results as Record<string, unknown>[])[0];
  if (!item) throw domainError("NOT_FOUND", "Decision not found", 404);
  return {
    workItemId, itemKey: itemKey ?? String(item.item_key), question: String(item.title), status: String(item.status),
    options: (optionRows.results as Record<string, unknown>[]).map(mapOption),
  };
}

/**
 * Resolves a decision. Human-only — the same authority check `set_maturity` already
 * enforces for promoting a proposal, applied here to the one decision that matters more:
 * once resolved, the losing options' related work is superseded, and a future proposal
 * matching a rejected approach will read that rejection back through
 * `get_planning_context`'s rejected bucket, reason and all. An agent choosing that on its
 * own would be exactly the "AI-generated planning becomes project policy" the roadmap
 * warns against.
 */
export async function resolveDecision(
  db: PgD1, principal: Principal,
  input: { projectId: string; decisionWorkItemId: string; winningOptionId: string; resolutionReason?: string; sourceId?: string },
): Promise<Decision> {
  if (!isHumanPrincipal(principal)) {
    throw domainError("AUTHORITY_REQUIRED", "Only a person can resolve a decision. An agent can raise one with record_decision, but a person has to choose.", 403);
  }
  const organizationId = await organizationFor(db, principal);
  const options = await db.prepare("SELECT * FROM decision_options WHERE decision_work_item_id = ? AND organization_id = ?").bind(input.decisionWorkItemId, organizationId).all<Record<string, unknown>>();
  const winner = options.results.find((row) => String(row.id) === input.winningOptionId);
  if (!winner) throw domainError("NOT_FOUND", "That option does not belong to this decision", 404);
  // Already resolved exactly this way: this is what an idempotent client retry looks
  // like, so replay the current state rather than erroring. Already resolved a
  // *different* way is a genuine conflict, not a retry, and must fail loudly.
  if (String(winner.status) === "accepted") return readDecision(db, organizationId, input.decisionWorkItemId);
  if (String(winner.status) !== "open") throw domainError("VALIDATION_FAILED", "This option was already rejected by an earlier resolution of this decision", 422);

  const reason = input.resolutionReason?.trim().slice(0, 1000);
  const losers = options.results.filter((row) => String(row.id) !== input.winningOptionId);

  await db.prepare("UPDATE decision_options SET status = 'accepted' WHERE id = ? AND organization_id = ?").bind(winner.id, organizationId).run();
  for (const loser of losers) {
    await db.prepare("UPDATE decision_options SET status = 'rejected' WHERE id = ? AND organization_id = ?").bind(loser.id, organizationId).run();

    const relatedId = loser.related_work_item_id ? String(loser.related_work_item_id) : null;
    if (!relatedId) continue;
    const view = await loadProjectView(db, organizationId, input.projectId, { items: true });
    const relatedItem = view.workItems.find((entry) => entry.id === relatedId);
    // Already resolved on its own (done, or independently cancelled) — leave it as is
    // rather than overwriting a resolution this decision did not create.
    if (!relatedItem || relatedItem.status === "done" || relatedItem.status === "cancelled") continue;

    await executeCommand(db, principal, {
      action: "transition_item", projectId: input.projectId, itemId: relatedId, expectedVersion: relatedItem.version,
      status: "cancelled", resolution: "superseded",
      resolutionReason: reason ? `Superseded by decision ${input.decisionWorkItemId}: ${reason}` : `Superseded by a decision`,
      sourceId: input.sourceId, idempotencyKey: `${input.decisionWorkItemId}:supersede:${relatedId}`,
    });
    await executeCommand(db, principal, {
      action: "add_dependency", projectId: input.projectId, fromWorkItemId: input.decisionWorkItemId, toWorkItemId: relatedId,
      type: "supersedes", reason: reason || "Resolved by decision", sourceId: input.sourceId, idempotencyKey: `${input.decisionWorkItemId}:supersede-edge:${relatedId}`,
    });
  }

  const decisionItem = (await loadProjectView(db, organizationId, input.projectId, { items: true })).workItems.find((entry) => entry.id === input.decisionWorkItemId);
  if (decisionItem && decisionItem.status !== "done") {
    await executeCommand(db, principal, {
      action: "transition_item", projectId: input.projectId, itemId: input.decisionWorkItemId, expectedVersion: decisionItem.version,
      status: "done", resolution: "completed", resolutionReason: reason, sourceId: input.sourceId, idempotencyKey: `${input.decisionWorkItemId}:close`,
    });
  }

  return readDecision(db, organizationId, input.decisionWorkItemId);
}

/**
 * E4 — "conflicts raise decisions": the follow-up half of `create_work_items`, called by
 * the MCP route handler with `createWorkItemsDeduplicated`'s own result array.
 * Necessarily a separate call rather than something `lib/store.ts` does itself —
 * `recordDecision` calls back into `executeCommand`/`organizationFor` from that same
 * module, so `store.ts` importing this file would be circular. Lives here instead of
 * inlined in `app/mcp/route.ts` so it is unit-testable against a real database without
 * going through HTTP routing, the same way every other planning primitive in this
 * directory is tested.
 *
 * Mutates each matching result entry in place with a `decision` field, and returns the
 * same array for convenience. Only entries with `status: "created"` and a `relation` of
 * type `"CONFLICT"` are acted on — anything else (a plain create, a collapsed match, a
 * non-conflict relation already turned into an edge by `lib/store.ts`) is left untouched.
 */
export async function raiseConflictDecisions(
  db: PgD1, principal: Principal,
  input: { projectId: string; sourceId?: string; idempotencyKey: string; results: Array<Record<string, unknown>> },
): Promise<Array<Record<string, unknown>>> {
  for (const [index, entry] of input.results.entries()) {
    const relation = entry.relation as { type: string; reason: string; workItemId: string; itemKey: string } | undefined;
    if (relation?.type !== "CONFLICT" || entry.status !== "created") continue;
    const decision = await recordDecision(db, principal, {
      projectId: input.projectId, sourceId: input.sourceId,
      question: `${entry.itemKey} conflicts with ${relation.itemKey}: ${relation.reason}`,
      options: [
        { label: `Do ${entry.itemKey} as proposed`, relatedWorkItemId: String(entry.workItemId) },
        { label: `Keep ${relation.itemKey} as is`, relatedWorkItemId: relation.workItemId },
      ],
      idempotencyKey: `${input.idempotencyKey}:conflict-decision:${index}`,
    });
    entry.decision = { workItemId: decision.workItemId, itemKey: decision.itemKey };
  }
  return input.results;
}

/** Every unresolved decision in a project — the "N decisions need attention" queue. */
export async function listOpenDecisions(db: PgD1, organizationId: string, projectId: string): Promise<Decision[]> {
  const rows = await db.prepare("SELECT id, item_key, title, status FROM work_items WHERE project_id = ? AND organization_id = ? AND type = 'decision' AND status <> 'done' AND archived_at IS NULL ORDER BY created_at").bind(projectId, organizationId).all<Record<string, unknown>>();
  const decisions: Decision[] = [];
  for (const row of rows.results) decisions.push(await readDecision(db, organizationId, String(row.id), String(row.item_key)));
  return decisions;
}
