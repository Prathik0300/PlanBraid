/**
 * The order to work through everything open, computed by critical-path scheduling over
 * the dependency graph.
 *
 * Scheduling work across k agents subject to precedence is `P|prec|Cmax`, which is
 * NP-hard, so this uses the standard near-optimal heuristic: **list scheduling by
 * critical path**. Each item's *b-level* is the longest remaining chain from it to any
 * sink; always preferring the highest b-level is within (2 - 1/k) of optimal (Graham).
 *
 * This replaced ranking by immediate unlock count, which is myopic in a way that matters:
 * a task freeing five leaves outranked one starting a ten-deep chain, though only the
 * second moves the finish date. Unlock count survives as a tiebreak, since among items
 * with equal downstream depth the one freeing more parallel work is genuinely better.
 *
 * Everything here is one O(V+E) sweep: adjacency, a Kahn topological order, a backward
 * pass for b-level, a forward pass for earliest-start (which *is* the wave index, so the
 * layering falls out for free), and slack. The previous version re-filtered every open
 * item once per wave and rescanned sources and aliases once per item, which is O(W*V)
 * with an O(V*(S+A)) tail.
 *
 * Nothing here computes new facts about any one item: blocking_count and the dependency
 * graph already exist. This only simulates finishing work forward through them.
 */
import type { PgD1 } from "@/db/pg-d1";
import type { WorkItem } from "@/lib/contracts.ts";
import { loadProjectView } from "@/lib/read/project-view.ts";
import { organizationFor, type Principal } from "@/lib/store.ts";
import { DAG_EDGE_TYPES } from "@/lib/graph/edges.ts";
import { providerFamily } from "@/lib/providers.ts";

const PRIORITY_RANK: Record<WorkItem["priority"], number> = { urgent: 4, high: 3, normal: 2, low: 1, none: 0 };
const DAG_TYPES: readonly string[] = DAG_EDGE_TYPES;

export type PlanStep = WorkItem & {
  reason: string;
  corroboration: number;
  /** Longest remaining chain from here to a sink, counting this item. Drives the order. */
  depth: number;
  /** How long this can slip without moving the finish date. 0 means it is on the critical path. */
  slack: number;
  critical: boolean;
};
export type PlanWave = { wave: number; items: PlanStep[] };
export type StuckItem = WorkItem & { reason: string };
export type ExecutionPlan = {
  waves: PlanWave[];
  stuck: StuckItem[];
  /** The chain that determines the finish date: every item on it has zero slack. */
  criticalPath: Array<Pick<WorkItem, "id" | "itemKey" | "title">>;
};

export async function getExecutionPlan(db: PgD1, principal: Principal, projectId: string): Promise<ExecutionPlan> {
  const organizationId = await organizationFor(db, principal);
  const view = await loadProjectView(db, organizationId, projectId, { items: true, dependencies: true, sources: true, aliases: true });
  const open = view.workItems.filter((item) => item.status !== "done" && item.status !== "cancelled");
  const byId = new Map(open.map((item) => [item.id, item]));

  // A manual "blocked" status is an assertion no amount of finishing other tracked work
  // clears (see deriveColumn), so such items are excluded from scheduling up front rather
  // than left to stall the sweep implicitly. Their dependents stall with them, which is
  // true and is reported under `stuck`.
  const schedulable = open.filter((item) => item.status !== "blocked");

  // One pass over edges: prerequisite -> dependents, plus in-degree. Edges are kept for
  // every open item, including asserted-blocked ones: such an item can never be scheduled
  // itself, but it must still hold its dependents back. Dropping its edges here would
  // leave them with in-degree 0 and schedule them into wave 1 as though nothing were in
  // the way, which is the opposite of true.
  const dependents = new Map<string, string[]>();
  const prerequisites = new Map<string, string[]>();
  const indegree = new Map<string, number>(open.map((item) => [item.id, 0]));
  for (const edge of view.dependencies) {
    if (!DAG_TYPES.includes(edge.type)) continue;
    if (!byId.has(edge.fromWorkItemId) || !byId.has(edge.toWorkItemId)) continue;
    if (!dependents.has(edge.fromWorkItemId)) dependents.set(edge.fromWorkItemId, []);
    dependents.get(edge.fromWorkItemId)!.push(edge.toWorkItemId);
    if (!prerequisites.has(edge.toWorkItemId)) prerequisites.set(edge.toWorkItemId, []);
    prerequisites.get(edge.toWorkItemId)!.push(edge.fromWorkItemId);
    indegree.set(edge.toWorkItemId, (indegree.get(edge.toWorkItemId) ?? 0) + 1);
  }

  // Kahn's algorithm with a queue rather than a rescan per layer. Anything left unvisited
  // afterwards sits behind a cycle or behind an asserted block.
  const remaining = new Map(indegree);
  const queue: string[] = schedulable.filter((item) => (remaining.get(item.id) ?? 0) === 0).map((item) => item.id);
  const topo: string[] = [];
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    topo.push(id);
    for (const next of dependents.get(id) ?? []) {
      const left = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  const scheduled = new Set(topo);

  // Backward pass for b-level (longest chain to a sink) and forward pass for earliest
  // start. `earliest` is exactly the wave index: an item sits one layer after its latest
  // prerequisite, which is the same recurrence the old per-wave filtering computed.
  const depth = new Map<string, number>();
  for (let index = topo.length - 1; index >= 0; index -= 1) {
    const id = topo[index];
    let longest = 0;
    for (const next of dependents.get(id) ?? []) longest = Math.max(longest, depth.get(next) ?? 0);
    depth.set(id, longest + 1);
  }
  const earliest = new Map<string, number>();
  for (const id of topo) {
    let start = 0;
    for (const previous of prerequisites.get(id) ?? []) start = Math.max(start, (earliest.get(previous) ?? 0) + 1);
    earliest.set(id, start);
  }
  const criticalLength = Math.max(0, ...topo.map((id) => depth.get(id) ?? 0));

  // Provenance lookups precomputed once. These used to be a linear scan of sources plus a
  // full alias scan per item, inside the ranking loop.
  const sourceById = new Map(view.sources.map((source) => [source.id, source]));
  const familiesByItem = new Map<string, Set<string>>();
  const familyOf = (sourceId: string | null | undefined) => {
    const source = sourceId ? sourceById.get(sourceId) : undefined;
    return source ? providerFamily(source.provider) : null;
  };
  for (const item of schedulable) {
    const families = new Set<string>();
    const own = familyOf(item.sourceId);
    if (own) families.add(own);
    familiesByItem.set(item.id, families);
  }
  for (const alias of view.aliases) {
    const families = familiesByItem.get(alias.workItemId);
    if (!families) continue;
    const family = familyOf(alias.sourceId);
    if (family) families.add(family);
  }

  const byWave = new Map<number, PlanStep[]>();
  for (const id of topo) {
    const item = byId.get(id)!;
    const itemDepth = depth.get(id) ?? 1;
    const start = earliest.get(id) ?? 0;
    const slack = Math.max(0, criticalLength - start - itemDepth);
    // Immediate children this actually frees: those with exactly one prerequisite left.
    const unlockCount = (dependents.get(id) ?? []).filter((next) => (indegree.get(next) ?? 0) === 1).length;
    const corroboration = familiesByItem.get(id)?.size ?? 0;
    const step: PlanStep = {
      ...item, corroboration, depth: itemDepth, slack, critical: slack === 0,
      reason: slack === 0
        ? `On the critical path: ${itemDepth} step${itemDepth === 1 ? "" : "s"} of work depend on this finishing.`
        : unlockCount > 0
          ? `Unlocks ${unlockCount} other task${unlockCount === 1 ? "" : "s"}; can slip ${slack} step${slack === 1 ? "" : "s"} without costing time.`
          : `Can slip ${slack} step${slack === 1 ? "" : "s"} without costing time.`,
    };
    if (!byWave.has(start)) byWave.set(start, []);
    byWave.get(start)!.push(step);
  }

  const waves: PlanWave[] = [...byWave.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, items], index) => {
      // Critical path first, since that is what moves the finish date. Unlock count is
      // demoted to a tiebreak among equally deep work, where freeing more parallel tasks
      // genuinely is better; leading with it was the myopia this replaced.
      items.sort((a, b) =>
        b.depth - a.depth
        || PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
        || b.corroboration - a.corroboration
        || a.sequence - b.sequence);
      return { wave: index + 1, items };
    });

  // The critical path itself: start at a zero-slack source and always follow the deepest
  // zero-slack dependent. Every step of this chain has to finish in sequence, so its
  // length is the project's floor however many agents are working.
  const criticalPath: Array<Pick<WorkItem, "id" | "itemKey" | "title">> = [];
  let cursor: string | undefined = topo
    .filter((id) => (earliest.get(id) ?? 0) === 0 && (depth.get(id) ?? 0) === criticalLength)
    .sort((a, b) => (byId.get(a)!.sequence) - (byId.get(b)!.sequence))[0];
  while (cursor !== undefined) {
    const item = byId.get(cursor)!;
    criticalPath.push({ id: item.id, itemKey: item.itemKey, title: item.title });
    const nextDepth: number = (depth.get(cursor) ?? 1) - 1;
    const following: string[] = dependents.get(cursor) ?? [];
    cursor = nextDepth > 0 ? following.find((next) => (depth.get(next) ?? 0) === nextDepth) : undefined;
  }

  const stuck: StuckItem[] = open.filter((item) => !scheduled.has(item.id)).map((item) => {
    if (item.status === "blocked") return { ...item, reason: item.blockerReason || "Marked blocked, with no reason recorded." };
    // Prerequisites now include asserted-blocked items, so this one filter covers both
    // ways an item can fail to schedule: stuck behind a manual block, or inside a cycle.
    const blockers = [...new Set((prerequisites.get(item.id) ?? [])
      .filter((id) => !scheduled.has(id))
      .map((id) => byId.get(id)?.itemKey ?? id))];
    return {
      ...item,
      reason: blockers.length
        ? `Waiting on ${blockers.join(", ")}, which ${blockers.length === 1 ? "is" : "are"} itself stuck.`
        : "Sits behind a dependency cycle, so no order can satisfy it.",
    };
  });

  return { waves, stuck, criticalPath };
}
