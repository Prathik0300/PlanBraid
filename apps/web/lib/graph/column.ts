/**
 * The board column a work item belongs in: a pure function of its asserted status and
 * its blocking_count, never stored. See GRAPH_ARCHITECTURE.md §2.
 *
 * status conflates two different kinds of fact. in_progress/in_review/done/cancelled
 * are assertions: an actor did something, and nothing overrides that. proposed/planned/
 * ready/blocked-by-a-dependency are derivable: the graph's topology is the source of
 * truth for whether work is actually actionable. Storing "blocked" for a dependency
 * that has since resolved is exactly how blocked items go stale. This function is what
 * makes that impossible, since the column is recomputed from current data every time.
 */
import type { WorkItem, WorkStatus } from "@/lib/contracts.ts";

/** An actor's own claim about its status always wins over topology. */
const ASSERTION_WINS: ReadonlySet<WorkStatus> = new Set(["cancelled", "done", "in_review", "in_progress", "blocked"]);

/** Work a person has actually agreed to. Only this is ever handed to an agent to start. */
const RATIFIED: ReadonlySet<WorkItem["maturity"]> = new Set(["accepted", "committed"]);

export type ColumnInput = Pick<WorkItem, "status" | "blockingCount" | "maturity" | "deferredUntil">;

export function deriveColumn(item: ColumnInput, now = Date.now()): WorkStatus {
  if (ASSERTION_WINS.has(item.status)) return item.status;

  // "Blocked" is an exception state, not the resting state of unscheduled work. Only an
  // item somebody had already scheduled (stored 'ready') and then lost a prerequisite
  // under belongs in the Blocked column; a proposed item that simply has upstream work
  // is proposed. Reporting the latter as blocked made it 54 of 58 items on a real
  // project, which is a column that conveys nothing and reads as a false alarm.
  if (item.blockingCount > 0) return item.status === "ready" ? "blocked" : item.status;

  // Ready is derived, not stored, for the same reason blocked is: it is a fact about
  // current topology plus acceptance, and storing it goes stale. This is also what makes
  // accepting work mean something mechanically. set_maturity only ever writes `maturity`,
  // so before this every column was computed from inputs acceptance never touched, and
  // accepting 56 items provably could not move one card.
  //
  // "Not now, revisit later" is not actionable, whatever the graph says, and neither is
  // work nobody has ratified. getReadyWork's SQL excludes both on the exact same two
  // conditions, and the two must never disagree about what an agent may pick up — so
  // when either holds, the column must never assert "ready" even if that happens to be
  // the stored status (a hand-set value predating a deferral, or predating this
  // maturity gate entirely): downgrade to "planned" rather than echo a claim
  // getReadyWork would refuse.
  const deferred = Boolean(item.deferredUntil) && Date.parse(item.deferredUntil!) > now;
  if (deferred || !RATIFIED.has(item.maturity)) return item.status === "ready" ? "planned" : item.status;
  return "ready";
}

/**
 * True when an actor claims to be actively working an item the graph currently shows
 * as blocked, e.g. a prerequisite got reopened after work started on its dependent.
 * This is the actual multi-agent collision this whole mechanism exists to surface: an
 * actor's claim is never silently overridden by topology, but it is flagged.
 */
export function isStartedWhileBlocked(item: ColumnInput): boolean {
  return item.status === "in_progress" && item.blockingCount > 0;
}
