/**
 * Appending to the plan operation log.
 *
 * `PLAN_VERSION_CONTROL.md §7` is explicit about the shape of this milestone: "Write ops
 * *alongside* existing mutations; keep current tables as the materialized view... The
 * system must work identically with the log ignored." Nothing here is on the critical
 * path of any existing read or write — `lib/store.ts`'s commands behave exactly as they
 * did before this file existed if every call site below were deleted.
 *
 * Deliberately its own transaction, separate from the primary command's `commitMutation`
 * batch, rather than folded into it. The alternative — one shared transaction spanning
 * both — would need restructuring `executeCommand`'s dozen mutation branches around a
 * single wrapping transaction, which is real risk against an already-large, already-tested
 * function for a feature explicitly scoped as observational infrastructure. The tradeoff
 * this accepts: a process crash in the narrow window between the primary write committing
 * and this call running would leave that one operation unlogged. The primary write is
 * never at risk — this call runs only after it has already succeeded — and a rare gap in
 * an audit trail is a defensible cost for not touching the write path this milestone
 * explicitly says must keep working unchanged.
 */
import type { PgD1 } from "@/db/pg-d1";
import { canonicalize, hashOp } from "./hash.ts";

export type AuthorKind = "human" | "agent";

export type AppendPlanOpInput = {
  organizationId: string;
  projectId: string;
  /** Always 'canonical' until session branches exist (deferred past this milestone —
   * PLAN_VERSION_CONTROL.md §4.1). Parameterized now so that milestone is additive. */
  branch?: string;
  /** The command's own `action` field, unmodified — the op log's vocabulary is exactly
   * the domain's existing command vocabulary, not a second one invented for this. */
  type: string;
  payload: Record<string, unknown>;
  authorKind: AuthorKind;
  authorName: string;
  sourceId?: string | null;
};

/**
 * Serializes concurrent writers onto a correct parent for one (project, branch) pair.
 * `tx.lock()` is transaction-scoped (`pg_advisory_xact_lock`) and releases automatically on
 * commit or rollback — the same primitive `create_project` already relies on for exactly
 * this kind of read-then-write race, so this reuses a pattern already proven in this
 * codebase rather than inventing a second locking strategy.
 *
 * Returns the new op's hash, or null if this exact operation (identical type, payload, and
 * parent) was already logged — a caller sees that rather than a duplicate row, since
 * uniqueness is `(project_id, hash)` and the insert is `ON CONFLICT DO NOTHING`.
 *
 * **A known gap in how thoroughly this can be verified in this repository**: the test
 * double behind `tests/support/local-pg.mjs` (`@electric-sql/pglite`, an embedded
 * single-instance WASM Postgres) does not actually block a second concurrent
 * `pg_advisory_xact_lock` call the way real Postgres does — three transactions racing for
 * the same lock in that harness all report "acquired" immediately, with no serialization.
 * `tests/plan-ops.test.mjs` documents this finding directly rather than asserting a
 * concurrency guarantee this test environment cannot actually exercise. The locking
 * pattern itself is the standard, correct one for real Postgres and is not new — this file
 * reuses exactly what `create_project`'s own equivalent read-then-write race already
 * depends on — but genuine multi-connection concurrent-write correctness for this function
 * has only been verified by chain-of-custody reasoning and by the primitive's established
 * use elsewhere, not by a passing test against real concurrent backends. Confirm against a
 * real Postgres instance before treating this as load-bearing for correctness under heavy
 * concurrent write load.
 */
export async function appendPlanOp(db: PgD1, input: AppendPlanOpInput): Promise<string | null> {
  const branch = input.branch ?? "canonical";
  const payload = canonicalize(input.payload) as Record<string, unknown>;

  return db.transaction(async (tx) => {
    await tx.lock(`planbraid:plan_ops:${input.projectId}:${branch}`);
    const ref = await tx.prepare("SELECT head FROM plan_refs WHERE project_id = ? AND name = ?").bind(input.projectId, branch).first<{ head: string[] }>();
    const parents = ref?.head ?? [];
    const hash = await hashOp(input.type, payload, parents);

    const inserted = await tx.prepare(
      "INSERT INTO plan_ops (hash, organization_id, project_id, type, payload, parents, author_kind, author_name, source_id, branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, hash) DO NOTHING RETURNING hash",
    ).bind(hash, input.organizationId, input.projectId, input.type, JSON.stringify(payload), parents, input.authorKind, input.authorName.slice(0, 200), input.sourceId ?? null, branch).first<{ hash: string }>();

    // An identical operation (same type, same canonical payload, same parent) was already
    // logged — most likely two branches of one command computing the same op twice (this
    // should not happen given the call sites are one-per-branch, but content addressing
    // makes it harmless either way) rather than something requiring a new head.
    if (!inserted) return null;

    await tx.prepare(
      "INSERT INTO plan_refs (project_id, name, head, updated_at) VALUES (?, ?, ?, now()) ON CONFLICT (project_id, name) DO UPDATE SET head = excluded.head, updated_at = excluded.updated_at",
    ).bind(input.projectId, branch, [hash]).run();

    return hash;
  });
}
