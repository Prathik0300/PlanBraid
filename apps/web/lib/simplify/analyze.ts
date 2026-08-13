/**
 * The structural half of "Simplify the plan".
 *
 * Pure functions over a project's items and dependency edges: no database, no clock
 * passed implicitly, no network, so every rule here is directly testable — the same
 * reason lib/dedup/match.ts is written this way, and for the same stakes, since these
 * findings propose archiving work somebody typed.
 *
 * Nothing here decides anything on its own. Each finding carries the exact Command that
 * would apply it, and a person (or a corroborating agent) decides whether it runs.
 */

import type { Command, WorkItem, DashboardState } from "@/lib/contracts";
import { adjudicate, explain, type Candidate } from "@/lib/dedup/match.ts";
import { buildSignature, type TaskSignature } from "@/lib/dedup/signature.ts";
import { DAG_EDGE_TYPES } from "@/lib/graph/edges.ts";
import { isStartedWhileBlocked } from "@/lib/graph/column.ts";
import { providerFamily } from "@/lib/providers.ts";

export type FindingKind =
  | "duplicate" | "possible_duplicate" | "redundant_done"
  // E4, fixes F3: opposite intent on the same concrete artifact ("add auth middleware" /
  // "remove auth middleware" on the same file) used to fall through to `distinct` here,
  // which was safe — never a false merge — but silent. Informational only: `merge_items`
  // would be actively wrong for a conflict, and there is no `Command` variant for
  // "raise a decision" for this pass to propose one-click, so the fix is naming what was
  // found and pointing at `record_decision` rather than staying quiet about it.
  | "conflicting_work"
  | "blocked_chain" | "cycle" | "started_while_blocked" | "stale" | "do_first" | "planning_loop"
  // M17: divergence between the plan and the repository. Both carry a proposedCommand
  // (a transition) despite being informational — "propose a transition the user applies,
  // never automatic" (roadmap M17) is a different rule from "no command at all", which is
  // what plain informational findings like blocked_chain/stale mean elsewhere in this file.
  | "possibly_implemented" | "evidence_removed"
  // Reported by a connected agent rather than found by the structural pass — something it
  // noticed that doesn't fit an existing category. See lib/simplify/runs.ts's
  // reportSimplificationFinding. Always informational: only the structural matcher may
  // propose an actionable command (DEDUPLICATION_ARCHITECTURE.md's asymmetric-error
  // discipline applies to what an agent can get a person to click, not only to the matcher).
  | "agent_flagged";

export type Finding = {
  kind: FindingKind;
  /** Stable within a run, so the same finding reported twice is one row with two
   * agreeing authors rather than two rows. */
  dedupeKey: string;
  workItemId: string;
  relatedWorkItemId?: string;
  verdict: "certain" | "possible" | "informational";
  /** One line naming what was found. */
  reason: string;
  /** Supporting text: the chain, the other title, the age. */
  detail: string;
  /** Present only when there is something to apply; informational findings have none. */
  proposedCommand?: Command;
};

type Dependencies = DashboardState["dependencies"];
type Aliases = DashboardState["aliases"];
type Sources = DashboardState["sources"];
type Events = DashboardState["events"];
type Evidence = DashboardState["evidence"];

/** Items a merge may target: still open, and not already archived. */
const OPEN_STATUSES = new Set(["proposed", "planned", "ready", "blocked"]);
const RESOLVED_STATUSES = new Set(["done", "cancelled"]);

/** Days after which an untouched proposal is worth a second look. */
const STALE_DAYS = 21;

function signatureOf(item: WorkItem): TaskSignature {
  return buildSignature(item.title, item.description);
}

function toCandidate(item: WorkItem, signature: TaskSignature): Candidate {
  // fingerprintValue is null on purpose: fingerprint() is async (WebCrypto) and the
  // identical-signature case is already covered by comparing `normalized` directly
  // below, which keeps this whole module synchronous and trivially testable.
  return { id: item.id, itemKey: item.itemKey, title: item.title, status: item.status, updatedAt: item.updatedAt, signature, fingerprintValue: null };
}

/** Deterministic ordering so the same project always yields the same winner. Older
 * items win: they are the ones history, dependencies, and agents already reference. */
function mergeOrder(a: WorkItem, b: WorkItem) {
  return a.sequence - b.sequence;
}

/** Exported so a caller reporting a finding from outside this module (an agent
 * corroborating or flagging one — see reportSimplificationFinding) builds the exact same
 * key the structural pass would, rather than a second implementation free to drift from
 * this one. Order-independent, matching every paired finding kind below. */
export function pairKey(kind: string, a: string, b: string) {
  return [kind, ...[a, b].sort()].join(":");
}

/** "#1, #2 and #3" rather than "#1 and #2 and #3". */
function listOf(values: string[]) {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

/**
 * Pairwise duplicate detection across open work, reusing the adjudication cascade the
 * write path already trusts — including its vetoes, which is the point: "rate limit
 * /api/login" and "rate limit /api/signup" must keep coming back distinct here too.
 */
export function findDuplicates(items: WorkItem[]): Finding[] {
  const open = items.filter((item) => !RESOLVED_STATUSES.has(item.status)).sort(mergeOrder);
  const signatures = new Map(items.map((item) => [item.id, signatureOf(item)]));
  const findings: Finding[] = [];
  const merged = new Set<string>();

  for (let i = 0; i < open.length; i += 1) {
    for (let j = i + 1; j < open.length; j += 1) {
      const winner = open[i];
      const loser = open[j];
      // A task already slated to merge away must not also anchor another merge, or
      // applying both would target an archived item.
      if (merged.has(loser.id) || merged.has(winner.id)) continue;
      const left = signatures.get(loser.id)!;
      const right = signatures.get(winner.id)!;
      const identical = left.normalized === right.normalized;
      const decision = identical
        ? { verdict: "duplicate" as const, score: 1, method: "fingerprint" as const, reason: "Identical normalized task signature" }
        : adjudicate({ signature: left, fingerprintValue: "" }, toCandidate(winner, right));
      if (decision.verdict === "distinct") continue;

      // A conflict is emphatically not a duplicate — proposing `merge_items` for opposite
      // intent on the same artifact would be actively wrong, not merely imprecise, so
      // this gets its own informational finding instead of falling into the
      // duplicate/possible_duplicate branch below.
      if (decision.verdict === "conflict") {
        findings.push({
          kind: "conflicting_work",
          dedupeKey: pairKey("conflicting_work", winner.id, loser.id),
          workItemId: loser.id,
          relatedWorkItemId: winner.id,
          verdict: "informational",
          reason: `${loser.itemKey} conflicts with ${winner.itemKey}`,
          detail: explain({ ...decision, candidate: toCandidate(winner, right) }),
        });
        continue;
      }

      const certain = decision.verdict === "duplicate";
      if (certain) merged.add(loser.id);
      findings.push({
        kind: certain ? "duplicate" : "possible_duplicate",
        dedupeKey: pairKey(certain ? "duplicate" : "possible_duplicate", winner.id, loser.id),
        workItemId: loser.id,
        relatedWorkItemId: winner.id,
        verdict: certain ? "certain" : "possible",
        reason: certain
          ? `${loser.itemKey} restates ${winner.itemKey}`
          : `${loser.itemKey} may restate ${winner.itemKey}`,
        detail: explain({ ...decision, candidate: toCandidate(winner, right) }),
        proposedCommand: {
          action: "merge_items", projectId: loser.projectId, winnerItemId: winner.id, loserItemId: loser.id,
          reason: `${decision.reason} as ${winner.itemKey}`, idempotencyKey: `simplify-merge-${loser.id}`,
        },
      });
    }
  }
  return findings;
}

/**
 * Open work that restates something already finished. Never proposed as a merge: the
 * finished item is not where new work belongs, and reopening it is a different decision
 * than collapsing a duplicate, so this reports and lets a person choose.
 */
export function findRedundantAgainstDone(items: WorkItem[]): Finding[] {
  const open = items.filter((item) => OPEN_STATUSES.has(item.status));
  const resolved = items.filter((item) => RESOLVED_STATUSES.has(item.status));
  const signatures = new Map(items.map((item) => [item.id, signatureOf(item)]));
  const findings: Finding[] = [];

  for (const item of open) {
    for (const finished of resolved) {
      const left = signatures.get(item.id)!;
      const right = signatures.get(finished.id)!;
      const decision = left.normalized === right.normalized
        ? { verdict: "duplicate" as const, score: 1, method: "fingerprint" as const, reason: "Identical normalized task signature" }
        : adjudicate({ signature: left, fingerprintValue: "" }, toCandidate(finished, right));
      if (decision.verdict !== "duplicate") continue;
      findings.push({
        kind: "redundant_done",
        dedupeKey: pairKey("redundant_done", item.id, finished.id),
        workItemId: item.id,
        relatedWorkItemId: finished.id,
        verdict: "possible",
        reason: `${item.itemKey} repeats ${finished.itemKey}, which is already ${finished.status}`,
        detail: explain({ ...decision, candidate: toCandidate(finished, right) }),
        proposedCommand: {
          action: "transition_item", projectId: item.projectId, itemId: item.id, expectedVersion: item.version,
          status: "cancelled", reason: `Already covered by ${finished.itemKey}`, idempotencyKey: `simplify-cancel-${item.id}`,
        },
      });
      break;
    }
  }
  return findings;
}

/** Prerequisite edges only, as an adjacency map. Annotation edges never imply order. */
function prerequisiteMap(dependencies: Dependencies) {
  const dagTypes: readonly string[] = DAG_EDGE_TYPES;
  const map = new Map<string, string[]>();
  for (const edge of dependencies) {
    if (!dagTypes.includes(edge.type)) continue;
    map.set(edge.toWorkItemId, [...(map.get(edge.toWorkItemId) ?? []), edge.fromWorkItemId]);
  }
  return map;
}

/**
 * Names every hop a blocked item is waiting on, not just the count the board already
 * shows. "#20 waits on #19, which waits on #18" is what tells you where to actually
 * start; "blocked by 1" does not.
 */
export function findBlockedChains(items: WorkItem[], dependencies: Dependencies): Finding[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const prerequisites = prerequisiteMap(dependencies);
  const findings: Finding[] = [];

  for (const item of items) {
    if (RESOLVED_STATUSES.has(item.status) || item.blockingCount === 0) continue;
    const chain: string[] = [];
    const seen = new Set<string>([item.id]);
    let cursor = item.id;
    // Follow the first unresolved prerequisite down to the root. Cycles are reported
    // separately; `seen` only stops this walk from running forever.
    for (let depth = 0; depth < 20; depth += 1) {
      const next = (prerequisites.get(cursor) ?? [])
        .map((id) => byId.get(id))
        .find((entry) => entry && !RESOLVED_STATUSES.has(entry.status) && !seen.has(entry.id));
      if (!next) break;
      chain.push(next.itemKey);
      seen.add(next.id);
      cursor = next.id;
    }
    if (!chain.length) continue;
    const root = chain[chain.length - 1];
    findings.push({
      kind: "blocked_chain",
      dedupeKey: `blocked_chain:${item.id}`,
      workItemId: item.id,
      // The chain array above only ever collected itemKeys (for the prose below), never
      // the id needed to look the root item up structurally — cursor holds it, since the
      // walk's last successful step left it pointed at exactly that node. M23's
      // "blocking release" view is what actually needs this rather than parsing `detail`.
      relatedWorkItemId: cursor,
      verdict: "informational",
      reason: `${item.itemKey} is waiting on ${chain.join(", then ")}`,
      detail: chain.length > 1
        ? `Start with ${root}: nothing above it can move until it does.`
        : `${root} is the only thing in the way.`,
    });
  }
  return findings;
}

/**
 * Ordering cycles among stored edges. add_dependency refuses to create one, but edges
 * predating that check, or created either side of a merge, can still form one - and a
 * cycle means every item in it is permanently blocked with no root to start from.
 */
export function findCycles(items: WorkItem[], dependencies: Dependencies): Finding[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const prerequisites = prerequisiteMap(dependencies);
  const findings: Finding[] = [];
  const reported = new Set<string>();

  for (const item of items) {
    const path: string[] = [];
    const onPath = new Set<string>();
    const walk = (id: string): string[] | null => {
      if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
      if (path.length > 40) return null;
      onPath.add(id);
      path.push(id);
      for (const prerequisite of prerequisites.get(id) ?? []) {
        const found = walk(prerequisite);
        if (found) return found;
      }
      path.pop();
      onPath.delete(id);
      return null;
    };
    const cycle = walk(item.id);
    if (!cycle) continue;
    const key = [...new Set(cycle)].sort().join("|");
    if (reported.has(key)) continue;
    reported.add(key);
    const keys = cycle.map((id) => byId.get(id)?.itemKey ?? id);
    findings.push({
      kind: "cycle",
      dedupeKey: `cycle:${key}`,
      workItemId: item.id,
      verdict: "certain",
      reason: `${listOf(keys.slice(0, -1))} block each other`,
      detail: `${keys.join(" needs ")}. Remove one of these dependencies or none of them can start.`,
    });
  }
  return findings;
}

/** In progress while the graph still says a prerequisite is unresolved. */
export function findAnomalies(items: WorkItem[]): Finding[] {
  return items.filter((item) => isStartedWhileBlocked(item)).map((item) => ({
    kind: "started_while_blocked" as const,
    dedupeKey: `started_while_blocked:${item.id}`,
    workItemId: item.id,
    verdict: "informational" as const,
    reason: `${item.itemKey} is in progress with an unresolved prerequisite`,
    detail: "Either a dependency was added after work started, or a prerequisite was reopened.",
  }));
}

/** Proposals nobody has touched in weeks. `now` is a parameter so this stays pure. */
export function findStale(items: WorkItem[], now: number): Finding[] {
  const cutoff = now - STALE_DAYS * 24 * 60 * 60 * 1000;
  return items
    .filter((item) => item.status === "proposed" && new Date(item.updatedAt).getTime() < cutoff)
    .map((item) => ({
      kind: "stale" as const,
      dedupeKey: `stale:${item.id}`,
      workItemId: item.id,
      verdict: "informational" as const,
      reason: `${item.itemKey} has sat untriaged for over ${STALE_DAYS} days`,
      detail: `Last updated ${new Date(item.updatedAt).toLocaleDateString()}. Plan it, or cancel it so it stops counting as work.`,
    }));
}

/**
 * M17: a planned item whose known files a commit actually touched after it was proposed —
 * built entirely from `commit`-type evidence (M15), which only ever exists on an item
 * when a real repository observation's artifacts intersected it, so this needs nothing
 * beyond the same items+evidence every other pass here already has. Never claims the work
 * is *done*: a commit touching a file is not proof of anything (lib/planning/completion.ts
 * draws that same line for the same reason), only that the plan is stale enough that
 * someone should look before proposing it again or resuming from scratch.
 */
export function findPossiblyImplemented(items: WorkItem[], evidence: Evidence): Finding[] {
  const commitsByItem = new Map<string, Evidence>();
  for (const entry of evidence) {
    if (entry.type !== "commit") continue;
    commitsByItem.set(entry.workItemId, [...(commitsByItem.get(entry.workItemId) ?? []), entry]);
  }

  const findings: Finding[] = [];
  for (const item of items) {
    if (item.status !== "planned") continue;
    const proposedAt = new Date(item.createdAt).getTime();
    const commits = (commitsByItem.get(item.id) ?? []).filter((entry) => new Date(entry.createdAt).getTime() > proposedAt);
    if (!commits.length) continue;
    findings.push({
      kind: "possibly_implemented",
      dedupeKey: `possibly_implemented:${item.id}`,
      workItemId: item.id,
      verdict: "informational",
      reason: `${item.itemKey} may already be implemented: a commit touched its known files after it was proposed`,
      detail: commits.map((entry) => entry.label).join("; "),
      proposedCommand: {
        action: "transition_item", projectId: item.projectId, itemId: item.id, expectedVersion: item.version,
        status: "ready", reason: "Repository activity suggests this may already be substantially implemented; moved to ready for someone to verify and close out.",
        idempotencyKey: `simplify-possibly-implemented-${item.id}`,
      },
    });
  }
  return findings;
}

/** How many distinct times a work item has been proposed before it counts as a loop. Set
 * by counting the original creation plus every alias restating it, so "3 times" reads the
 * way a person would count it — not "2 aliases on top of the original". */
const LOOP_MIN_PROPOSALS = 3;
/** Fewer than two independent models proposing something the same way is just one agent
 * being repetitive across sessions, not a planning loop several agents keep hitting. */
const LOOP_MIN_PROVIDER_FAMILIES = 2;
/** How long a repeatedly-proposed item must have sat with zero progress before this is a
 * pattern rather than a task that was simply proposed twice in the same week. */
const LOOP_MIN_SPAN_DAYS = 3;

/**
 * Work repeatedly proposed or discussed without meaningful execution.
 *
 * The data already exists: every restatement collapsed by the dedup matcher is stored as
 * an alias with its source and timestamp (`work_item_aliases`), specifically so this kind
 * of pattern could be read back later without agents needing to report it themselves. This
 * is that read.
 *
 * "No execution" is checked two ways: no `work_item.started` event ever fired, and no
 * evidence was ever attached. Either one on its own could be a false negative — a task
 * briefly started and abandoned still generated a started event; evidence-free progress
 * notes exist — so both together are the bar, and it is a deliberately low bar: false
 * positives here just mean a person sees an accurate but unsurprising finding, while a
 * missed loop is invisible forever, which is the more expensive failure.
 */
export function findPlanningLoops(items: WorkItem[], aliases: Aliases, sources: Sources, events: Events, evidence: Evidence, now: number): Finding[] {
  const findings: Finding[] = [];
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const startedItemIds = new Set(events.filter((event) => event.eventType === "work_item.started").map((event) => event.workItemId).filter((id): id is string => Boolean(id)));
  const evidencedItemIds = new Set(evidence.map((entry) => entry.workItemId));

  for (const item of items) {
    if (RESOLVED_STATUSES.has(item.status) || startedItemIds.has(item.id) || evidencedItemIds.has(item.id)) continue;
    const restatements = aliases.filter((alias) => alias.workItemId === item.id);
    const proposalCount = restatements.length + 1; // the item's own original creation
    if (proposalCount < LOOP_MIN_PROPOSALS) continue;

    const families = new Map<string, number>();
    const originalFamily = item.sourceId ? providerFamily((sourceById.get(item.sourceId)?.provider) ?? "") : null;
    if (originalFamily) families.set(originalFamily, (families.get(originalFamily) ?? 0) + 1);
    for (const alias of restatements) {
      const family = alias.sourceId ? providerFamily((sourceById.get(alias.sourceId)?.provider) ?? "") : null;
      if (family) families.set(family, (families.get(family) ?? 0) + 1);
    }
    if (families.size < LOOP_MIN_PROVIDER_FAMILIES) continue;

    // Measured from the first proposal to now, not merely to the latest restatement: a
    // loop that has sat untouched since its last proposal is still an open loop today, and
    // this is the number that should grow every day nobody resolves it.
    const firstProposedAt = new Date(item.createdAt).getTime();
    const spanDays = Number.isFinite(firstProposedAt) ? Math.floor((now - firstProposedAt) / 86_400_000) : 0;
    if (spanDays < LOOP_MIN_SPAN_DAYS) continue;

    const byModel = [...families.entries()].sort((a, b) => b[1] - a[1]).map(([family, count]) => `${family}×${count}`).join(", ");
    findings.push({
      kind: "planning_loop",
      dedupeKey: `planning_loop:${item.id}`,
      workItemId: item.id,
      verdict: "informational",
      reason: `${item.itemKey} has been independently proposed ${proposalCount} times over ${spanDays} day${spanDays === 1 ? "" : "s"} with no implementation attempt`,
      detail: `Proposed by ${byModel}. Zero work_item.started events and no evidence attached. Resolve, reject, or schedule it rather than leaving it to keep resurfacing.`,
    });
  }
  return findings;
}

/**
 * The whole structural pass. "Do first" is deliberately absent: getReadyWork already
 * ranks actionable work and needs the database, so lib/store.ts folds its result in
 * rather than this module growing a second, drifting ranking.
 */
export function analyzeProject(input: { items: WorkItem[]; dependencies: Dependencies; aliases?: Aliases; sources?: Sources; events?: Events; evidence?: Evidence; now?: number }): Finding[] {
  // Finished work is passed through rather than filtered out: findRedundantAgainstDone
  // exists precisely to compare open work against it.
  const items = input.items;
  const now = input.now ?? Date.now();
  return [
    ...findDuplicates(items),
    ...findRedundantAgainstDone(items),
    ...findCycles(items, input.dependencies),
    ...findBlockedChains(items, input.dependencies),
    ...findAnomalies(items),
    ...findStale(items, now),
    ...findPossiblyImplemented(items, input.evidence ?? []),
    ...findPlanningLoops(items, input.aliases ?? [], input.sources ?? [], input.events ?? [], input.evidence ?? [], now),
  ];
}
