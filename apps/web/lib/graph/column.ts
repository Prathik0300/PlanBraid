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

export type ColumnInput = Pick<WorkItem, "status" | "blockingCount">;

export function deriveColumn(item: ColumnInput): WorkStatus {
  if (ASSERTION_WINS.has(item.status)) return item.status;
  // Not yet started, and topology says something upstream still isn't resolved.
  if (item.blockingCount > 0) return "blocked";
  return item.status;
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
