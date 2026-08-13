/**
 * M13 — agent handoff packages.
 *
 * "Free once M11 exists" per the roadmap, and it is: this reuses M11's bucketing
 * primitives and M9's confidence derivation rather than a third implementation of either.
 * The one genuinely new idea is "Do NOT redo" — the roadmap's own name for it — which
 * needs a distinction M11 doesn't: not just *what* is done, but which of it is verified
 * versus merely claimed (`lib/trust/confidence.ts`). A handoff that tells the next agent
 * "AUTH-12 is done" when nobody has checked is worse than saying nothing, because it
 * invites trusting a claim as if it were a fact.
 *
 * Unlike `get_planning_context`, this is not filtered to one objective — a handoff is a
 * whole-project state transfer, the thing a cold agent reads before doing anything else.
 */
import type { WorkEvent } from "@/lib/contracts";
import type { PgD1 } from "@/db/pg-d1";
import { loadProjectView } from "@/lib/read/project-view.ts";
import { findBlockedChains } from "@/lib/simplify/analyze.ts";
import { confidenceOf } from "@/lib/trust/confidence.ts";
import { getReadyWork, organizationFor, type Principal } from "@/lib/store.ts";
import { providerFamily } from "@/lib/providers.ts";

const REJECTED_RESOLUTIONS = new Set(["rejected", "superseded", "duplicate", "abandoned", "obsolete"]);
const MAX_PER_SECTION = 10;

export type HandoffItem = { itemKey: string; workItemId: string; title: string; note?: string };

export type HandoffPackage = {
  projectId: string;
  projectName: string;
  generatedAt: string;
  verifiedComplete: HandoffItem[];
  /** Claims completion but nothing has checked it — the exact distinction M9 exists to
   * make representable, surfaced here because a handoff is precisely the moment an
   * unverified claim is most likely to be trusted as fact. */
  unverifiedComplete: HandoffItem[];
  active: HandoffItem[];
  blocked: HandoffItem[];
  recentlyRejected: HandoffItem[];
  nextActions: HandoffItem[];
  /** The plain-text form, ready to paste into any agent that isn't connected yet. */
  text: string;
};

export async function getHandoffPackage(db: PgD1, principal: Principal, projectId: string): Promise<HandoffPackage> {
  const organizationId = await organizationFor(db, principal);
  const view = await loadProjectView(db, organizationId, projectId, { items: true, sources: true, events: true, evidence: true, dependencies: true });
  const eventsByItem = groupEvents(view.events);
  const claims = await activeClaims(db, view.workItems.filter((item) => item.status === "in_progress").map((item) => item.id));
  const sourceById = new Map(view.sources.map((source) => [source.id, source]));
  const evidenceByItem = groupBy(view.evidence, (entry) => entry.workItemId);

  const verifiedComplete: HandoffItem[] = [];
  const unverifiedComplete: HandoffItem[] = [];
  const active: HandoffItem[] = [];
  const recentlyRejected: HandoffItem[] = [];

  for (const item of view.workItems) {
    if (item.status === "done") {
      const evidence = evidenceByItem.get(item.id) ?? [];
      const confidence = confidenceOf({
        item, events: eventsByItem.get(item.id) ?? [], corroboration: 1,
        evidenceCount: evidence.length, verifiedEvidenceCount: evidence.filter((entry) => entry.result === "verified").length,
        now: Date.now(),
      });
      (confidence.level === "high" ? verifiedComplete : unverifiedComplete).push({ itemKey: item.itemKey, workItemId: item.id, title: item.title });
    } else if (item.status === "in_progress") {
      const claim = claims.get(item.id);
      const holder = claim ? claimLabel(claim, sourceById) : null;
      active.push({ itemKey: item.itemKey, workItemId: item.id, title: item.title, note: holder ? `held by ${holder}` : "no active session currently holds it" });
    } else if (item.status === "cancelled" && item.resolution && REJECTED_RESOLUTIONS.has(item.resolution)) {
      recentlyRejected.push({ itemKey: item.itemKey, workItemId: item.id, title: item.title, note: item.resolutionReason ?? undefined });
    }
  }

  const dependencies = view.dependencies;
  const blocked: HandoffItem[] = findBlockedChains(view.workItems, dependencies)
    .slice(0, MAX_PER_SECTION)
    .map((finding) => {
      const item = view.workItems.find((entry) => entry.id === finding.workItemId)!;
      return { itemKey: item.itemKey, workItemId: item.id, title: item.title, note: finding.detail };
    });

  const ready = await getReadyWork(db, principal, { projectId, limit: 5, avoidCollisions: false });
  const nextActions: HandoffItem[] = ready.workItems.map((entry) => ({ itemKey: entry.itemKey, workItemId: entry.id, title: entry.title, note: entry.reason }));

  const cap = <T,>(list: T[]) => list.slice(0, MAX_PER_SECTION);
  const sections = {
    verifiedComplete: cap(verifiedComplete), unverifiedComplete: cap(unverifiedComplete),
    active: cap(active), blocked, recentlyRejected: cap(recentlyRejected), nextActions,
  };

  return {
    projectId, projectName: view.project.name, generatedAt: new Date().toISOString(),
    ...sections,
    text: renderText(view.project.name, sections),
  };
}

function groupEvents(events: WorkEvent[]) {
  const map = new Map<string, WorkEvent[]>();
  for (const event of events) {
    if (!event.workItemId) continue;
    map.set(event.workItemId, [...(map.get(event.workItemId) ?? []), event]);
  }
  return map;
}

function groupBy<T>(list: T[], key: (entry: T) => string) {
  const map = new Map<string, T[]>();
  for (const entry of list) { const k = key(entry); map.set(k, [...(map.get(k) ?? []), entry]); }
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

function claimLabel(claim: ActiveClaim, sourceById: Map<string, { provider: string; agentAccountLabel: string | null }>) {
  const source = sourceById.get(claim.sourceId);
  if (!source) return null;
  return source.agentAccountLabel ? `${providerFamily(source.provider)} · ${source.agentAccountLabel}` : providerFamily(source.provider);
}

type Sections = Pick<HandoffPackage, "verifiedComplete" | "unverifiedComplete" | "active" | "blocked" | "recentlyRejected" | "nextActions">;

/** The plain-text form. Headings match the roadmap's own worked example exactly, since
 * that shape is what "paste into any agent" is optimizing for — a format a model reads
 * as naturally as a person does, with no schema to explain. */
function renderText(projectName: string, sections: Sections): string {
  const lines: string[] = [`PROJECT HANDOFF — ${projectName}`, ""];
  const block = (title: string, items: HandoffItem[], empty: string) => {
    lines.push(title, "-".repeat(title.length));
    if (!items.length) lines.push(empty);
    else for (const item of items) lines.push(`${item.itemKey} ${item.title}${item.note ? ` — ${item.note}` : ""}`);
    lines.push("");
  };

  block("Do NOT redo (verified complete)", sections.verifiedComplete, "Nothing verified yet.");
  if (sections.unverifiedComplete.length) block("Claimed complete, unverified — check before trusting", sections.unverifiedComplete, "");
  block("Currently active", sections.active, "Nothing in progress.");
  block("Blocked", sections.blocked, "Nothing blocked.");
  if (sections.recentlyRejected.length) block("Rejected approaches — do not re-propose without a new argument", sections.recentlyRejected, "");
  block("Recommended next actions", sections.nextActions, "Nothing ready to start.");

  return lines.join("\n").trimEnd();
}
