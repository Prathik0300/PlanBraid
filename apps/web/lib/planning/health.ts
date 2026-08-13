/**
 * M22 — planning debt and health (features 16, 18).
 *
 * "Both are rollups of open Simplify findings, weighted by kind. Build the debt list
 * before the score. A single number invites gaming and hides the actionable part; the
 * list is what a person acts on. If the score ships, it ships as the sum of a visible
 * breakdown, never as an opaque 82." That ordering is load-bearing here: `computeHealth`
 * always returns the ranked debt list and the per-kind breakdown alongside the score, and
 * nothing in this module (or its callers) is allowed to show the score without them.
 *
 * Nothing here computes anything new — every finding kind already exists (M17 shipped
 * the newest two), so this is purely a weighted rollup over what Simplify already found.
 */
import type { FindingKind } from "@/lib/simplify/analyze.ts";
import { createSimplificationRun, type StoredFinding } from "@/lib/simplify/runs.ts";
import { loadProjectView } from "@/lib/read/project-view.ts";
import { organizationFor, type Principal } from "@/lib/store.ts";
import type { PgD1 } from "@/db/pg-d1";

/**
 * Higher means more urgent. Rough shape: a false completion claim or a structural cycle
 * (both actively mislead) outweigh a stale proposal (inert, but not wrong). `do_first` is
 * guidance about what to do next, not a defect in the plan, so it carries no weight at all
 * and is excluded from debt entirely — it would otherwise inflate every healthy project's
 * "debt" by the size of its ready queue, the opposite of what a health score should mean.
 */
export const DEBT_WEIGHTS: Partial<Record<FindingKind, number>> = {
  cycle: 10,
  evidence_removed: 9,
  duplicate: 8,
  planning_loop: 7,
  redundant_done: 6,
  started_while_blocked: 5,
  possible_duplicate: 4,
  blocked_chain: 3,
  possibly_implemented: 3,
  stale: 2,
  agent_flagged: 2,
  do_first: 0,
};

function weightFor(kind: FindingKind) {
  return DEBT_WEIGHTS[kind] ?? 1;
}

export type DebtEntry = {
  findingId: string;
  kind: FindingKind;
  weight: number;
  workItemId: string;
  itemKey: string | null;
  title: string | null;
  reason: string;
};

export type PlanningHealth = {
  /** Ranked heaviest first — what a person should look at, in order. */
  debt: DebtEntry[];
  totalWeight: number;
  /** 100 minus total weight, floored at 0. Never shown without `debt` and `breakdown`
   * alongside it — see the module note on why. */
  score: number;
  breakdown: Array<{ kind: FindingKind; count: number; weight: number }>;
};

export function computeHealth(findings: StoredFinding[], items?: Map<string, { itemKey: string; title: string }>): PlanningHealth {
  const open = findings.filter((finding) => finding.status === "open" && weightFor(finding.kind) > 0);
  const debt: DebtEntry[] = open
    .map((finding) => ({
      findingId: finding.id, kind: finding.kind, weight: weightFor(finding.kind), workItemId: finding.workItemId,
      itemKey: items?.get(finding.workItemId)?.itemKey ?? null, title: items?.get(finding.workItemId)?.title ?? null,
      reason: finding.reason,
    }))
    .sort((a, b) => b.weight - a.weight);

  const totalWeight = debt.reduce((sum, entry) => sum + entry.weight, 0);
  const breakdownByKind = new Map<FindingKind, { count: number; weight: number }>();
  for (const entry of debt) {
    const existing = breakdownByKind.get(entry.kind) ?? { count: 0, weight: 0 };
    breakdownByKind.set(entry.kind, { count: existing.count + 1, weight: existing.weight + entry.weight });
  }
  const breakdown = [...breakdownByKind.entries()]
    .map(([kind, entry]) => ({ kind, ...entry }))
    .sort((a, b) => b.weight - a.weight);

  return { debt, totalWeight, score: Math.max(0, Math.round(100 - totalWeight)), breakdown };
}

/**
 * Always runs a fresh Simplify pass rather than reading whatever run happens to be
 * newest: a health score computed from a stale run is exactly the kind of trust gap M9
 * and M16 both exist to close elsewhere in this product, and Simplify's own pass is cheap
 * — a set of pure computations plus one batch insert, not a network call.
 */
export async function getPlanningHealth(db: PgD1, principal: Principal, projectId: string): Promise<PlanningHealth> {
  const organizationId = await organizationFor(db, principal);
  const run = await createSimplificationRun(db, principal, { projectId });
  const view = await loadProjectView(db, organizationId, projectId, { items: true });
  const items = new Map(view.workItems.map((item) => [item.id, { itemKey: item.itemKey, title: item.title }]));
  return computeHealth(run?.findings ?? [], items);
}
