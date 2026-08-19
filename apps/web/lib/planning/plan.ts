/**
 * A project-wide execution order: every open work item, grouped into waves by the
 * dependency graph (Kahn's algorithm over `blocks`/`requires` edges), each wave ranked by
 * the same heuristic get_ready_work already uses (most other work it unlocks, then
 * priority, then independent corroboration, then creation order). Wave 1 is what's
 * actionable right now; wave 2 is what becomes actionable once wave 1 is done, and so on.
 *
 * Nothing here computes new facts about any one item: blocking_count and the dependency
 * graph already exist. This only simulates finishing work forward through them, in the
 * same order get_ready_work would rank each step if you called it again after every wave.
 *
 * An item that never joins a wave is genuinely stuck: either it, or something it
 * transitively depends on, is manually marked blocked, which no amount of finishing other
 * *tracked* work resolves. A person needs to look at those before the rest of the order
 * can actually run to completion.
 */
import type { PgD1 } from "@/db/pg-d1";
import type { WorkItem } from "@/lib/contracts.ts";
import { loadProjectView } from "@/lib/read/project-view.ts";
import { organizationFor, type Principal } from "@/lib/store.ts";
import { DAG_EDGE_TYPES } from "@/lib/graph/edges.ts";
import { providerFamily } from "@/lib/providers.ts";

const PRIORITY_RANK: Record<WorkItem["priority"], number> = { urgent: 4, high: 3, normal: 2, low: 1, none: 0 };
const DAG_TYPES: readonly string[] = DAG_EDGE_TYPES;

export type PlanStep = WorkItem & { reason: string; corroboration: number };
export type PlanWave = { wave: number; items: PlanStep[] };
export type StuckItem = WorkItem & { reason: string };
export type ExecutionPlan = { waves: PlanWave[]; stuck: StuckItem[] };

export async function getExecutionPlan(db: PgD1, principal: Principal, projectId: string): Promise<ExecutionPlan> {
  const organizationId = await organizationFor(db, principal);
  const view = await loadProjectView(db, organizationId, projectId, { items: true, dependencies: true, sources: true, aliases: true });
  const open = view.workItems.filter((item) => item.status !== "done" && item.status !== "cancelled");
  const openIds = new Set(open.map((item) => item.id));
  const byId = new Map(open.map((item) => [item.id, item]));

  // prerequisiteId -> its direct dependents, restricted to hard (DAG) edges between two
  // still-open items; a done/cancelled prerequisite already left blocking_count, and an
  // edge to something outside this project's open set can't be simulated here.
  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>(open.map((item) => [item.id, 0]));
  for (const edge of view.dependencies) {
    if (!DAG_TYPES.includes(edge.type) || !openIds.has(edge.fromWorkItemId) || !openIds.has(edge.toWorkItemId)) continue;
    (dependents.get(edge.fromWorkItemId) ?? dependents.set(edge.fromWorkItemId, []).get(edge.fromWorkItemId)!).push(edge.toWorkItemId);
    remaining.set(edge.toWorkItemId, (remaining.get(edge.toWorkItemId) ?? 0) + 1);
  }

  const scheduled = new Set<string>();
  const waves: PlanWave[] = [];
  // A manual "blocked" status is an assertion nothing in the dependency graph can clear by
  // itself (see deriveColumn in lib/graph/column.ts); finishing other tracked work never
  // makes remaining reach 0 for it, so it's excluded from ever entering a wave up front
  // rather than relying on that to happen implicitly.
  while (scheduled.size < open.length) {
    const ready = open.filter((item) => !scheduled.has(item.id) && item.status !== "blocked" && (remaining.get(item.id) ?? 0) === 0);
    if (!ready.length) break;

    const ranked = ready.map((item) => {
      const unlockCount = (dependents.get(item.id) ?? []).filter((dependentId) => (remaining.get(dependentId) ?? 0) === 1).length;
      const providers = new Set<string>();
      const ownSource = view.sources.find((source) => source.id === item.sourceId);
      if (ownSource) providers.add(providerFamily(ownSource.provider));
      for (const alias of view.aliases) {
        if (alias.workItemId !== item.id) continue;
        const aliasSource = view.sources.find((source) => source.id === alias.sourceId);
        if (aliasSource) providers.add(providerFamily(aliasSource.provider));
      }
      return { item, unlockCount, corroboration: providers.size, priorityRank: PRIORITY_RANK[item.priority] };
    });
    ranked.sort((a, b) => b.unlockCount - a.unlockCount || b.priorityRank - a.priorityRank || b.corroboration - a.corroboration || a.item.sequence - b.item.sequence);

    waves.push({
      wave: waves.length + 1,
      items: ranked.map(({ item, unlockCount, corroboration }) => ({
        ...item, corroboration,
        reason: unlockCount > 0 ? `Unlocks ${unlockCount} other task${unlockCount === 1 ? "" : "s"} once done.` : "Ready to start.",
      })),
    });
    for (const { item } of ranked) {
      scheduled.add(item.id);
      for (const dependentId of dependents.get(item.id) ?? []) remaining.set(dependentId, (remaining.get(dependentId) ?? 0) - 1);
    }
  }

  const stuck: StuckItem[] = open.filter((item) => !scheduled.has(item.id)).map((item) => {
    if (item.status === "blocked") return { ...item, reason: item.blockerReason || "Marked blocked, with no reason recorded." };
    const waitingOnKeys = view.dependencies
      .filter((edge) => edge.toWorkItemId === item.id && DAG_TYPES.includes(edge.type) && openIds.has(edge.fromWorkItemId) && !scheduled.has(edge.fromWorkItemId))
      .map((edge) => byId.get(edge.fromWorkItemId)?.itemKey ?? edge.fromWorkItemId);
    return { ...item, reason: waitingOnKeys.length ? `Waiting on ${waitingOnKeys.join(", ")}, which ${waitingOnKeys.length === 1 ? "is" : "are"} itself stuck.` : "Could not be sequenced." };
  });

  return { waves, stuck };
}
