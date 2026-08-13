/**
 * Pre-planning intelligence (M11) — the highest-return item in
 * `PLANNING_INTELLIGENCE_ROADMAP.md`, and the direct answer to the roadmap's core
 * question: what does the *next* agent need to know before it plans, so it improves on
 * what the project already knows instead of rediscovering it.
 *
 * Deliberately not a new retrieval engine. The full multi-signal reconciliation pipeline
 * (`RECONCILIATION_ARCHITECTURE.md`, E1–E7) doesn't exist yet; this reuses exactly the
 * signature and thresholds the shipped dedup matcher already trusts
 * (`lib/dedup/signature.ts`, `lib/dedup/match.ts`'s `THRESHOLDS.lexicalFloor`), so
 * "relevant to this objective" means the same thing here as it means when two proposals
 * are compared for being the same task. When the reconciliation engine's real retrieval
 * (blocking, RRF, embeddings) ships, this module is the natural place to swap the scoring
 * function without touching the bucketing or guidance logic below it.
 */
import type { DashboardState, Source, WorkItem } from "@/lib/contracts";
import { buildSignature, jaccard, type TaskSignature } from "@/lib/dedup/signature.ts";
import { THRESHOLDS } from "@/lib/dedup/match.ts";
import { findBlockedChains } from "@/lib/simplify/analyze.ts";
import { providerFamily } from "@/lib/providers.ts";
import type { PgD1 } from "@/db/pg-d1";
import { loadProjectView } from "@/lib/read/project-view.ts";
import { checkCollisions } from "@/lib/planning/collision.ts";

type Aliases = DashboardState["aliases"];
type Sources = DashboardState["sources"];

const RESOLVED_STATUSES = new Set(["done", "cancelled"]);
const PROPOSAL_MATURITIES = new Set(["idea", "proposal"]);
const REJECTED_RESOLUTIONS = new Set(["rejected", "superseded", "duplicate", "abandoned", "obsolete"]);

/** How many relevant items to return per bucket. This is a briefing, not a dump — an
 * agent that gets forty items back will skim past the guidance that actually matters. */
const MAX_PER_BUCKET = 6;

export type PlanningContextInput = { projectId: string; objective: string; sourceId?: string };

type Ranked = { item: WorkItem; score: number };

/**
 * Relevance between the agent's stated objective and one existing item, on the same
 * scale the matcher itself uses: a shared concrete artifact is decisive, and otherwise
 * lexical overlap has to clear the floor the matcher already uses to decide something is
 * even worth mentioning as a "possible" resemblance. Reusing that floor rather than
 * picking a new number means this tool and `create_work_items`'s own `resembles` note can
 * never quietly disagree about what counts as related.
 */
function relevance(objective: TaskSignature, item: TaskSignature): number {
  const sharedArtifacts = objective.artifacts.filter((artifact) => item.artifacts.includes(artifact));
  if (sharedArtifacts.length) return 1;
  return jaccard(objective.objectTokens, item.objectTokens);
}

function isRelevant(score: number) {
  return score >= THRESHOLDS.lexicalFloor;
}

// `reason` (why this is blocked) and `resolutionReason` (why this was rejected) are kept
// as distinctly named fields rather than both called `reason` on an intersected base
// type: TypeScript intersects same-named properties across `&`, and `(string | undefined)
// & (string | null)` collapses to plain `string` — silently dropping the null case a
// naive shared `reason` field would need. Different concepts, different names.
export type PlanningContextItem = { itemKey: string; workItemId: string; title: string; reason?: string };
export type PlanningContextInProgressItem = PlanningContextItem & { heldBy: string | null; since: string | null };
export type PlanningContextRejectedItem = PlanningContextItem & { resolution: string; resolutionReason: string | null };
export type PlanningContextProposalItem = PlanningContextItem & { proposedBy: string[]; timesProposed: number };
export type PlanningContextCollision = PlanningContextItem & { heldBy: string | null; sharedArtifacts: string[] };

export type PlanningContext = {
  objective: string;
  alreadyDone: PlanningContextItem[];
  inProgress: PlanningContextInProgressItem[];
  planned: PlanningContextItem[];
  blocked: PlanningContextItem[];
  rejected: PlanningContextRejectedItem[];
  openProposals: PlanningContextProposalItem[];
  /** M14/feature 13: work under a live lease that shares a concrete artifact (file or
   * symbol) with the objective, regardless of whether its title reads as related at all.
   * Distinct from `inProgress`, which is relevance-ranked by wording. */
  collisions: PlanningContextCollision[];
  /** Plain sentences generated from the buckets above — never a template that fires when
   * a bucket happens to be empty. The part of this response an agent that reads three
   * lines and moves on will actually see, so every line here has to be literally true. */
  guidance: string[];
  consideredCount: number;
};

export async function getPlanningContext(db: PgD1, organizationId: string, input: PlanningContextInput): Promise<PlanningContext> {
  const view = await loadProjectView(db, organizationId, input.projectId, { items: true, sources: true, aliases: true, dependencies: true });
  const objectiveSignature = buildSignature(input.objective, "");

  const ranked: Ranked[] = [];
  for (const item of view.workItems) {
    const score = relevance(objectiveSignature, buildSignature(item.title, item.description));
    // Every open proposal is worth surfacing regardless of relevance score — a low-scoring
    // proposal is exactly the kind of thing a planning loop is made of (M21), and this
    // tool is one of the places that pattern should become visible before it repeats a
    // seventh time. Everything else has to clear the relevance floor.
    if (isRelevant(score) || (PROPOSAL_MATURITIES.has(item.maturity) && score > 0)) ranked.push({ item, score });
  }
  ranked.sort((a, b) => b.score - a.score);

  const claims = await activeClaims(db, ranked.filter(({ item }) => item.status === "in_progress").map(({ item }) => item.id));
  const sourceById = new Map(view.sources.map((source) => [source.id, source]));

  const alreadyDone: PlanningContextItem[] = [];
  const inProgress: PlanningContextInProgressItem[] = [];
  const planned: PlanningContextItem[] = [];
  const rejected: PlanningContextRejectedItem[] = [];
  const openProposals: PlanningContextProposalItem[] = [];

  for (const { item } of ranked) {
    if (item.status === "done") {
      if (alreadyDone.length < MAX_PER_BUCKET) alreadyDone.push({ itemKey: item.itemKey, workItemId: item.id, title: item.title });
    } else if (item.status === "in_progress") {
      if (inProgress.length < MAX_PER_BUCKET) {
        const claim = claims.get(item.id);
        inProgress.push({ itemKey: item.itemKey, workItemId: item.id, title: item.title, heldBy: claim ? claimLabel(claim, sourceById) : null, since: claim?.heartbeatAt ?? item.startedAt });
      }
    } else if (item.status === "cancelled" && item.resolution !== null && REJECTED_RESOLUTIONS.has(item.resolution)) {
      if (rejected.length < MAX_PER_BUCKET) rejected.push({ itemKey: item.itemKey, workItemId: item.id, title: item.title, resolution: item.resolution, resolutionReason: item.resolutionReason });
    } else if (PROPOSAL_MATURITIES.has(item.maturity)) {
      if (openProposals.length < MAX_PER_BUCKET) {
        const providers = corroboratingProviders(item, view.aliases, view.sources);
        openProposals.push({ itemKey: item.itemKey, workItemId: item.id, title: item.title, proposedBy: providers, timesProposed: 1 + view.aliases.filter((alias) => alias.workItemId === item.id).length });
      }
    } else if (RESOLVED_STATUSES.has(item.status)) {
      // Resolved but not 'done' or a recognized rejection resolution (e.g. an
      // unspecified cancellation) — worth neither "already done" nor "rejected", so it
      // is left out rather than misfiled into either.
      continue;
    } else if (planned.length < MAX_PER_BUCKET) {
      planned.push({ itemKey: item.itemKey, workItemId: item.id, title: item.title });
    }
  }

  // Blocked items and their chains: reuses the exact same pass Simplify already runs, so
  // "why is this blocked" never has two different answers depending on which surface
  // asked. Filtered to the relevant set computed above rather than the whole project.
  const relevantIds = new Set(ranked.map(({ item }) => item.id));
  const dependencies = view.dependencies.filter((edge) => relevantIds.has(edge.fromWorkItemId) || relevantIds.has(edge.toWorkItemId));
  const chains = findBlockedChains(view.workItems, dependencies).filter((finding) => relevantIds.has(finding.workItemId));
  const blocked: PlanningContextItem[] = chains.slice(0, MAX_PER_BUCKET).map((finding) => {
    const item = view.workItems.find((entry) => entry.id === finding.workItemId)!;
    return { itemKey: item.itemKey, workItemId: item.id, title: item.title, reason: finding.detail };
  });

  const collisionMatches = await checkCollisions(db, organizationId, input.projectId, { title: input.objective }, { excludeSourceId: input.sourceId });
  const collisions: PlanningContextCollision[] = collisionMatches.slice(0, MAX_PER_BUCKET).map((match) => ({
    itemKey: match.itemKey, workItemId: match.workItemId, title: match.title,
    heldBy: claimLabel({ sourceId: match.sourceId, heartbeatAt: match.heartbeatAt }, sourceById),
    sharedArtifacts: match.sharedArtifacts,
  }));

  return {
    objective: input.objective,
    alreadyDone, inProgress, planned, blocked, rejected, openProposals, collisions,
    guidance: buildGuidance({ alreadyDone, inProgress, blocked, rejected, openProposals, collisions }),
    consideredCount: ranked.length,
  };
}

type ActiveClaim = { sourceId: string; heartbeatAt: string };

/** Live leases on the candidate in-progress items (F1's work_claims), so "who is holding
 * this right now" is an answer grounded in the same lease the collision-avoidance logic
 * already trusts, not a guess from `sourceId` (which only says who created the item). */
async function activeClaims(db: PgD1, itemIds: string[]): Promise<Map<string, ActiveClaim>> {
  const claims = new Map<string, ActiveClaim>();
  if (!itemIds.length) return claims;
  const rows = await db.prepare("SELECT work_item_id, source_id, heartbeat_at FROM work_claims WHERE lease_expires_at > now() AND work_item_id = ANY(?::text[])").bind(itemIds).all<{ work_item_id: string; source_id: string; heartbeat_at: string }>();
  for (const row of rows.results) claims.set(row.work_item_id, { sourceId: row.source_id, heartbeatAt: row.heartbeat_at });
  return claims;
}

function claimLabel(claim: ActiveClaim, sourceById: Map<string, Source>) {
  const source = sourceById.get(claim.sourceId);
  if (!source) return null;
  return source.agentAccountLabel ? `${providerFamily(source.provider)} · ${source.agentAccountLabel}` : providerFamily(source.provider);
}

/** Model families that independently proposed this item — the original creator plus
 * every alias, deduped by family so two logins for one model count once. Mirrors
 * `lib/store.ts`'s `getReadyWork` corroboration counting exactly, so this tool and the
 * board never disagree about how many models actually proposed something. */
function corroboratingProviders(item: WorkItem, aliases: Aliases, sources: Sources) {
  const families = new Set<string>();
  const ownSource = sources.find((source) => source.id === item.sourceId);
  if (ownSource) families.add(providerFamily(ownSource.provider));
  for (const alias of aliases) {
    if (alias.workItemId !== item.id) continue;
    const aliasSource = sources.find((source) => source.id === alias.sourceId);
    if (aliasSource) families.add(providerFamily(aliasSource.provider));
  }
  return [...families];
}

/**
 * The guidance lines. Every branch here is conditioned on a bucket actually having
 * content — an empty bucket produces no line, ever. A guidance system that speaks when it
 * has nothing to say is worse than one that stays quiet, because the agent reading it has
 * no way to tell a true "nothing found" from a template firing on empty data.
 */
function buildGuidance(buckets: Pick<PlanningContext, "alreadyDone" | "inProgress" | "blocked" | "rejected" | "openProposals" | "collisions">): string[] {
  const lines: string[] = [];
  if (buckets.alreadyDone.length) {
    lines.push(`Do not re-propose: ${buckets.alreadyDone.map((entry) => entry.itemKey).join(", ")} already covers this.`);
  }
  for (const entry of buckets.inProgress) {
    lines.push(entry.heldBy
      ? `${entry.itemKey} is already in progress, held by ${entry.heldBy}. Coordinate before starting overlapping work.`
      : `${entry.itemKey} is already in progress. Coordinate before starting overlapping work.`);
  }
  for (const entry of buckets.collisions) {
    lines.push(`${entry.itemKey} shares ${entry.sharedArtifacts.join(", ")} with what you're about to do${entry.heldBy ? `, and ${entry.heldBy} is actively holding it` : ""}. Check before touching the same scope.`);
  }
  for (const entry of buckets.rejected) {
    lines.push(entry.resolutionReason
      ? `${entry.itemKey} was ${entry.resolution}: ${entry.resolutionReason}. Do not re-propose it without a new argument.`
      : `${entry.itemKey} was ${entry.resolution}, though no reason was recorded. Check with the team before re-proposing it.`);
  }
  for (const entry of buckets.blocked) {
    lines.push(`${entry.itemKey} ${entry.reason ?? "is blocked"}.`);
  }
  if (buckets.openProposals.length >= 3) {
    lines.push(`${buckets.openProposals.length} related proposals already exist here with nothing implemented yet — check whether this is a recurring idea worth resolving instead of proposing again.`);
  }
  return lines;
}
