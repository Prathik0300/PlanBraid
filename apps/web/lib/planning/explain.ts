/**
 * M12 — why-not-done reasoning.
 *
 * The roadmap names nine distinguishable answers to "why hasn't this been implemented":
 * not started, blocked by a dependency, deferred, rejected, superseded, abandoned,
 * attempted and failed, being implemented right now, and implemented but unverified. This
 * module answers with exactly one of them (plus a couple more the shipped schema already
 * distinguishes — duplicate, obsolete, an unspecified cancellation), rather than a status
 * string that conflates all of them into "not done".
 *
 * The decision function is pure and total: every work item has exactly one cause, chosen
 * by walking the same precedence order a person would reason in — first ask whether it's
 * over (a resolution), then whether it's deliberately paused (deferred), then whether the
 * graph says it can't start yet, then whether an actor said it's blocked, then whether
 * someone is actually holding it, and only once all of that is ruled out is "nobody has
 * started this" the honest answer. Never guesses between two causes that could both apply
 * — the precedence order is the tie-break, applied consistently.
 */
import type { WorkItem } from "@/lib/contracts";
import { findBlockedChains } from "@/lib/simplify/analyze.ts";
import type { PgD1 } from "@/db/pg-d1";
import { loadProjectView, loadWorkItemDetail } from "@/lib/read/project-view.ts";
import { providerFamily } from "@/lib/providers.ts";

export type WhyNotDoneCause =
  | "completed"
  | "rejected" | "deferred" | "superseded" | "duplicate" | "abandoned" | "obsolete" | "unspecified_cancellation"
  | "deferred_until_date"
  | "blocked_by_dependency"
  | "blocked_externally"
  | "in_progress_active" | "in_progress_unattended"
  | "in_review"
  | "not_yet_accepted"
  | "not_started";

export type WhyNotDoneExplanation = {
  cause: WhyNotDoneCause;
  /** One sentence, plain language — this is the answer an agent or a person actually
   * reads; `cause` is the machine-stable key behind it. */
  summary: string;
  /** Everything the cause was decided from, so the answer can be checked rather than
   * taken on faith. */
  detail: {
    itemKey: string;
    resolution?: string | null;
    resolutionReason?: string | null;
    deferredUntil?: string | null;
    blockedByChain?: string[];
    /** The subset of blockedByChain nobody has accepted yet: those are waiting on a
     * decision rather than on work, which is a different thing to go and fix. */
    unacceptedBlockers?: string[];
    blockerReason?: string | null;
    heldBy?: string | null;
    heldSince?: string | null;
    lastEventSummary?: string | null;
    lastEventReason?: string | null;
  };
};

/** `unacceptedKeys` is the subset of the chain nobody has accepted yet. Optional so a
 * caller constructing a Chain by hand (tests) need not supply it. */
type Chain = { itemKeys: string[]; reason: string; unacceptedKeys?: string[] };
type Claim = { holderLabel: string; heartbeatAt: string } | null;
type LastEvent = { summary: string; reason: string | null } | null;

const RESOLUTION_CAUSE: Partial<Record<string, WhyNotDoneCause>> = {
  completed: "completed", rejected: "rejected", deferred: "deferred", superseded: "superseded",
  duplicate: "duplicate", abandoned: "abandoned", obsolete: "obsolete", unspecified: "unspecified_cancellation",
};

const RESOLUTION_SENTENCE: Partial<Record<string, (item: WorkItem, reason: string | null) => string>> = {
  completed: (item) => `${item.itemKey} is done.`,
  rejected: (item, reason) => `${item.itemKey} was rejected${reason ? `: ${reason}` : ", though no reason was recorded"}.`,
  deferred: (item, reason) => `${item.itemKey} was deferred${reason ? `: ${reason}` : ", though no reason was recorded"}.`,
  superseded: (item, reason) => `${item.itemKey} was superseded${reason ? `: ${reason}` : ", though no reason was recorded"}.`,
  duplicate: (item, reason) => `${item.itemKey} was archived as a duplicate${reason ? `: ${reason}` : ""}.`,
  abandoned: (item, reason) => `${item.itemKey} was abandoned${reason ? `: ${reason}` : ", though no reason was recorded"}.`,
  obsolete: (item, reason) => `${item.itemKey} is no longer relevant${reason ? `: ${reason}` : ""}.`,
  unspecified: (item) => `${item.itemKey} was cancelled, but nobody recorded why.`,
};

/**
 * The decision itself. No I/O — everything it needs is passed in, already resolved from
 * the database by `explainWorkItem` below, so this stays directly testable against every
 * branch without a database in the loop.
 */
export function explainCause(item: WorkItem, chain: Chain | null, claim: Claim, lastEvent: LastEvent): WhyNotDoneExplanation {
  const base = { itemKey: item.itemKey, lastEventSummary: lastEvent?.summary ?? null, lastEventReason: lastEvent?.reason ?? null };

  // 1. Over. A terminal resolution is the most specific true thing that can be said about
  // an item, and it outranks every other signal — a cancelled item's dependency chain or
  // stale lease is history, not the reason it isn't done today.
  if (item.status === "done" || item.status === "cancelled") {
    const resolutionKey = item.resolution ?? "unspecified";
    const cause = RESOLUTION_CAUSE[resolutionKey] ?? "unspecified_cancellation";
    const sentence = RESOLUTION_SENTENCE[resolutionKey] ?? RESOLUTION_SENTENCE.unspecified!;
    return { cause, summary: sentence(item, item.resolutionReason), detail: { ...base, resolution: item.resolution, resolutionReason: item.resolutionReason } };
  }

  // 2. Deliberately paused. Distinct from "blocked": nothing external is stopping this,
  // someone chose to come back to it later.
  if (item.deferredUntil) {
    return { cause: "deferred_until_date", summary: `${item.itemKey} was deferred until ${new Date(item.deferredUntil).toLocaleDateString()}.`, detail: { ...base, deferredUntil: item.deferredUntil } };
  }

  // 3. The graph says it can't start. Named down to the root of the chain, not just a
  // count — "waiting on #4" is actionable, "blocked by 1 thing" is not.
  // A blocker nobody has accepted is a different problem with a different remedy: the fix
  // is to decide on it, not to build it. Branch 7 below would say so, but only for items
  // that are themselves proposals, so an accepted item held down by a proposal used to
  // report a bare "waiting on #N" and never mention that #N is not even agreed work yet.
  if (item.blockingCount > 0 && chain) {
    const unaccepted = chain.unacceptedKeys ?? [];
    const note = unaccepted.length
      ? ` ${unaccepted.join(", ")} ${unaccepted.length === 1 ? "is" : "are"} still only a proposal, so this is waiting on a decision, not on work.`
      : "";
    return { cause: "blocked_by_dependency", summary: `${item.itemKey} ${chain.reason}.${note}`, detail: { ...base, blockedByChain: chain.itemKeys, unacceptedBlockers: unaccepted } };
  }

  // 4. An actor asserted a block that the graph doesn't know about — waiting on a person,
  // a credential, a decision. `deriveColumn`'s own rule: an assertion is never overridden
  // by topology, so this is checked independently of blockingCount.
  if (item.status === "blocked") {
    return { cause: "blocked_externally", summary: `${item.itemKey} is blocked: ${item.blockerReason ?? "no reason was recorded"}.`, detail: { ...base, blockerReason: item.blockerReason } };
  }

  // 5. Someone is actually holding it right now, versus a status that says "in progress"
  // with nobody's lease backing it — the exact "started while blocked" class of anomaly
  // this product exists to catch, generalized to "started while unattended".
  if (item.status === "in_progress") {
    if (claim) return { cause: "in_progress_active", summary: `${item.itemKey} is being implemented by ${claim.holderLabel}.`, detail: { ...base, heldBy: claim.holderLabel, heldSince: claim.heartbeatAt } };
    return { cause: "in_progress_unattended", summary: `${item.itemKey} is marked in progress, but no active session currently holds it.`, detail: { ...base, heldBy: null } };
  }

  // 6. Implemented, claimed complete, not yet verified.
  if (item.status === "in_review") {
    return { cause: "in_review", summary: `${item.itemKey} was reported complete and is awaiting verification.`, detail: base };
  }

  // 7. Real work, but nobody has decided it belongs on the plan yet.
  if (item.maturity === "proposal" || item.maturity === "idea") {
    return { cause: "not_yet_accepted", summary: `${item.itemKey} is still a proposal; nobody has accepted it.`, detail: base };
  }

  // 8. Everything above was ruled out: accepted, unblocked, untouched.
  return { cause: "not_started", summary: `${item.itemKey} is accepted and unblocked, but nobody has started it.`, detail: base };
}

/** Gathers exactly what `explainCause` needs from the database: the item and its recent
 * events from a single-item read, plus — only when the item is actually blocked or
 * in progress, since these are the two branches that need it — the two lookups that do. */
export async function explainWorkItem(db: PgD1, organizationId: string, workItemId: string): Promise<WhyNotDoneExplanation> {
  const detail = await loadWorkItemDetail(db, organizationId, workItemId);
  const item = detail.workItem;

  const chain = item.blockingCount > 0 ? await chainFor(db, organizationId, item) : null;
  const claim = item.status === "in_progress" ? await activeClaim(db, item.id) : null;
  const lastEvent = detail.events[0] ? { summary: detail.events[0].summary, reason: detail.events[0].reason } : null;

  return explainCause(item, chain, claim, lastEvent);
}

/**
 * `loadWorkItemDetail`'s own `dependencies` only carries edges touching this one item
 * directly — enough for "waiting on #4", not enough for "#4, which is itself waiting on
 * #3". A real multi-hop chain needs the same project-wide item and edge set Simplify's
 * own `findBlockedChains` pass already loads (`createSimplificationRun`), so this walks
 * the identical data rather than a narrower slice that would silently truncate the chain
 * at one hop.
 */
async function chainFor(db: PgD1, organizationId: string, item: WorkItem): Promise<Chain | null> {
  const view = await loadProjectView(db, organizationId, item.projectId, { items: true, dependencies: true });
  const [finding] = findBlockedChains(view.workItems, view.dependencies).filter((entry) => entry.workItemId === item.id);
  if (!finding) return null;
  const match = /waiting on (.+)$/.exec(finding.reason);
  const itemKeys = match ? match[1].split(", then ") : [];
  const byKey = new Map(view.workItems.map((entry) => [entry.itemKey, entry]));
  const unacceptedKeys = itemKeys.filter((key) => {
    const blocker = byKey.get(key);
    return blocker != null && (blocker.maturity === "proposal" || blocker.maturity === "idea");
  });
  return { itemKeys, reason: finding.reason, unacceptedKeys };
}

async function activeClaim(db: PgD1, workItemId: string): Promise<Claim> {
  const row = await db.prepare(
    "SELECT wc.source_id, wc.heartbeat_at, s.provider, s.agent_account_label FROM work_claims wc JOIN sources s ON s.id = wc.source_id WHERE wc.work_item_id = ? AND wc.lease_expires_at > now() ORDER BY wc.heartbeat_at DESC LIMIT 1",
  ).bind(workItemId).first<{ source_id: string; heartbeat_at: string; provider: string; agent_account_label: string | null }>();
  if (!row) return null;
  const holderLabel = row.agent_account_label ? `${providerFamily(row.provider)} · ${row.agent_account_label}` : providerFamily(row.provider);
  return { holderLabel, heartbeatAt: row.heartbeat_at };
}
