/**
 * M23 — query surfaces (feature 19, per D3).
 *
 * "Saved views over the structured state: what's active, what's blocking release, what
 * keeps getting proposed, what has no proof, what needs a decision. No prose parsing."
 * That last line is the whole design: this is five fixed, named queries over data every
 * one of M9, M12, M19, and M21 already computes, not a natural-language interface — see
 * RECONCILIATION_ARCHITECTURE.md §9 and D3 for why a hosted model deliberately never sits
 * on this critical path. Nothing here is a new signal; it is retrieval, not inference.
 */
import { findBlockedChains, findPlanningLoops } from "@/lib/simplify/analyze.ts";
import { confidenceOf } from "@/lib/trust/confidence.ts";
import { listOpenDecisions } from "@/lib/planning/decisions.ts";
import { loadProjectView } from "@/lib/read/project-view.ts";
import { organizationFor, type Principal } from "@/lib/store.ts";
import { providerFamily } from "@/lib/providers.ts";
import type { WorkEvent } from "@/lib/contracts";
import type { PgD1 } from "@/db/pg-d1";

export const SAVED_VIEWS = ["active", "blocking_release", "keeps_getting_proposed", "no_proof", "needs_decision"] as const;
export type SavedViewName = (typeof SAVED_VIEWS)[number];

export type SavedViewItem = { itemKey: string; workItemId: string; title: string; detail: string };
export type SavedView = { view: SavedViewName; items: SavedViewItem[] };

function domainError(code: string, message: string, status = 422) {
  return Object.assign(new Error(message), { code, status });
}

function groupEvents(events: WorkEvent[]) {
  const map = new Map<string, WorkEvent[]>();
  for (const event of events) {
    if (!event.workItemId) continue;
    map.set(event.workItemId, [...(map.get(event.workItemId) ?? []), event]);
  }
  return map;
}

type ActiveClaim = { sourceId: string; heartbeatAt: string };

async function activeClaims(db: PgD1, itemIds: string[]): Promise<Map<string, ActiveClaim>> {
  const claims = new Map<string, ActiveClaim>();
  if (!itemIds.length) return claims;
  const rows = await db.prepare("SELECT work_item_id, source_id, heartbeat_at FROM work_claims WHERE lease_expires_at > now() AND work_item_id = ANY(?::text[])").bind(itemIds).all<{ work_item_id: string; source_id: string; heartbeat_at: string }>();
  for (const row of rows.results) claims.set(row.work_item_id, { sourceId: row.source_id, heartbeatAt: row.heartbeat_at });
  return claims;
}

export async function getSavedView(db: PgD1, principal: Principal, projectId: string, view: SavedViewName): Promise<SavedView> {
  const organizationId = await organizationFor(db, principal);
  const viewData = await loadProjectView(db, organizationId, projectId, { items: true, sources: true, events: true, evidence: true, aliases: true, dependencies: true });
  const byId = new Map(viewData.workItems.map((item) => [item.id, item]));

  if (view === "active") {
    const activeItems = viewData.workItems.filter((item) => item.status === "in_progress");
    const claims = await activeClaims(db, activeItems.map((item) => item.id));
    const sourceById = new Map(viewData.sources.map((source) => [source.id, source]));
    const items = activeItems.map((item) => {
      const claim = claims.get(item.id);
      const source = claim ? sourceById.get(claim.sourceId) : null;
      const holder = source ? (source.agentAccountLabel ? `${providerFamily(source.provider)} · ${source.agentAccountLabel}` : providerFamily(source.provider)) : null;
      return { itemKey: item.itemKey, workItemId: item.id, title: item.title, detail: holder ? `held by ${holder}` : "no active session currently holds it" };
    });
    return { view, items };
  }

  if (view === "blocking_release") {
    const chains = findBlockedChains(viewData.workItems, viewData.dependencies);
    // Grouped by root, not reported per blocked item: five items all waiting on the same
    // missing prerequisite is one thing to fix, not five, and this view exists precisely
    // to say "fix this one thing" rather than restate the board's blocked column.
    const byRoot = new Map<string, number>();
    for (const chain of chains) {
      const rootId = chain.relatedWorkItemId ?? chain.workItemId;
      byRoot.set(rootId, (byRoot.get(rootId) ?? 0) + 1);
    }
    const items = [...byRoot.entries()]
      .map(([rootId, blockedCount]) => {
        const item = byId.get(rootId);
        if (!item) return null;
        return { itemKey: item.itemKey, workItemId: item.id, title: item.title, blockedCount };
      })
      .filter((entry): entry is { itemKey: string; workItemId: string; title: string; blockedCount: number } => entry != null)
      .sort((a, b) => b.blockedCount - a.blockedCount)
      .map(({ blockedCount, ...rest }) => ({ ...rest, detail: `blocking ${blockedCount} other item${blockedCount === 1 ? "" : "s"} from proceeding` }));
    return { view, items };
  }

  if (view === "keeps_getting_proposed") {
    const loops = findPlanningLoops(viewData.workItems, viewData.aliases, viewData.sources, viewData.events, viewData.evidence, Date.now());
    const items = loops.map((finding) => {
      const item = byId.get(finding.workItemId)!;
      return { itemKey: item.itemKey, workItemId: item.id, title: item.title, detail: finding.reason };
    });
    return { view, items };
  }

  if (view === "no_proof") {
    const eventsByItem = groupEvents(viewData.events);
    const evidenceByItem = new Map<string, typeof viewData.evidence>();
    for (const entry of viewData.evidence) evidenceByItem.set(entry.workItemId, [...(evidenceByItem.get(entry.workItemId) ?? []), entry]);
    const items: SavedViewItem[] = [];
    for (const item of viewData.workItems) {
      if (item.status !== "done") continue;
      const evidence = evidenceByItem.get(item.id) ?? [];
      const confidence = confidenceOf({
        item, events: eventsByItem.get(item.id) ?? [], corroboration: 1,
        evidenceCount: evidence.length, verifiedEvidenceCount: evidence.filter((entry) => entry.result === "verified").length,
        now: Date.now(),
      });
      if (confidence.level === "high") continue;
      items.push({ itemKey: item.itemKey, workItemId: item.id, title: item.title, detail: confidence.reasons[0] ?? "Marked done with nothing confirming it" });
    }
    return { view, items };
  }

  // view === "needs_decision"
  const decisions = await listOpenDecisions(db, organizationId, projectId);
  const items = decisions.map((decision) => ({
    itemKey: decision.itemKey, workItemId: decision.workItemId, title: decision.question,
    detail: `${decision.options.length} option${decision.options.length === 1 ? "" : "s"} open: ${decision.options.map((option) => option.label).join(" vs. ")}`,
  }));
  return { view: "needs_decision", items };
}

export function assertSavedViewName(value: string): asserts value is SavedViewName {
  if (!(SAVED_VIEWS as readonly string[]).includes(value)) throw domainError("VALIDATION_FAILED", `Unknown saved view: ${value}. Expected one of ${SAVED_VIEWS.join(", ")}`);
}
