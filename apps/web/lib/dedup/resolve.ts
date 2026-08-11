/**
 * Turns a batch of agent-proposed tasks into create/match decisions against the work a
 * project already has.
 *
 * Runs synchronously inside the write, before IDs are handed out. Asynchronous
 * reconciliation is too late: by the time it ran, the agent would already hold fresh
 * IDs and have started work on one of them, and unifying it would then mean merging
 * canonical items with live claims.
 */

import type { WorkItem } from "@/lib/contracts";
import { buildSignature, fingerprint } from "./signature.ts";
import { bestMatch, explain, type Candidate, type Proposal } from "./match.ts";

export type Outcome = {
  ref?: string;
  title: string;
  description: string;
  status?: string;
  priority?: string;
  dependsOn?: string[];
  /** False only when the proposal collapsed into existing or earlier-in-batch work. */
  create: boolean;
  fingerprintValue: string;
  /** Index in this same batch that this proposal collapsed into, if any. */
  batchIndex?: number;
  match?: {
    workItemId: string;
    itemKey: string;
    status: string;
    score: number;
    method: string;
    explanation: string;
    /** Conclusive enough to collapse, or only close enough to mention. */
    certain: boolean;
  };
  /** Content the proposal carried that the matched item does not already say. */
  delta: string[];
};

async function toCandidate(item: WorkItem): Promise<Candidate> {
  const signature = buildSignature(item.title, item.description);
  return {
    id: item.id, itemKey: item.itemKey, title: item.title, status: item.status,
    updatedAt: item.updatedAt, signature, fingerprintValue: await fingerprint(signature),
  };
}

/** Sentences the proposal adds that the canonical item does not already contain. */
export function describeDelta(proposalDescription: string, canonicalDescription: string) {
  const canonical = new Set(
    canonicalDescription.toLowerCase().split(/(?<=[.!?])\s+|\n+/).map((line) => line.trim().replace(/\s+/g, " ")).filter(Boolean),
  );
  return proposalDescription
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 12 && !canonical.has(line.toLowerCase().replace(/\s+/g, " ")))
    .slice(0, 4);
}

export async function resolveProposals(
  input: { proposals: Proposal[]; existingItems: WorkItem[] },
): Promise<Outcome[]> {
  const candidates: Candidate[] = [];
  for (const item of input.existingItems) candidates.push(await toCandidate(item));

  const outcomes: Outcome[] = [];
  // Tracks proposals accepted earlier in this same batch, so an agent that repeats
  // itself inside one call is deduplicated too.
  const batchIndexById = new Map<string, number>();

  for (const [index, proposal] of input.proposals.entries()) {
    const description = proposal.description ?? "";
    const signature = buildSignature(proposal.title, description);
    const fingerprintValue = await fingerprint(signature);
    const match = bestMatch({ signature, fingerprintValue }, candidates);

    const outcome: Outcome = {
      ref: proposal.ref, title: proposal.title, description, status: proposal.status, priority: proposal.priority, dependsOn: proposal.dependsOn,
      create: true, fingerprintValue, delta: [],
    };

    if (match) {
      const canonical = input.existingItems.find((item) => item.id === match.candidate.id);
      outcome.match = {
        workItemId: match.candidate.id, itemKey: match.candidate.itemKey, status: match.candidate.status,
        score: Number(match.score.toFixed(3)), method: match.method,
        explanation: explain(match), certain: match.verdict === "duplicate",
      };
      // Only a conclusive match suppresses creation. Anything less still creates,
      // because the cheap error (one extra card) is always preferable to the expensive
      // one (an agent pointed at the wrong task).
      outcome.create = match.verdict !== "duplicate";
      if (match.verdict === "duplicate") {
        outcome.delta = describeDelta(description, canonical?.description ?? "");
        outcome.batchIndex = batchIndexById.get(match.candidate.id);
      }
    }

    if (outcome.create) {
      // A provisional candidate so later proposals in this batch can match against it.
      // The placeholder id is rewritten to the real one once the item is created.
      const placeholderId = `batch:${index}`;
      candidates.push({
        id: placeholderId, itemKey: `batch #${index + 1}`, title: proposal.title,
        status: "proposed", signature, fingerprintValue,
      });
      batchIndexById.set(placeholderId, index);
    }
    outcomes.push(outcome);
  }

  return outcomes;
}

export function aliasStatement(
  db: D1Database,
  input: {
    organizationId: string; projectId: string; workItemId: string; title: string; description: string;
    sourceId?: string | null; score: number; method: string; reason: string;
  },
) {
  return db.prepare(
    "INSERT INTO work_item_aliases (id, organization_id, project_id, work_item_id, title, description, source_id, match_score, match_method, match_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    `als_${crypto.randomUUID().replaceAll("-", "")}`, input.organizationId, input.projectId, input.workItemId,
    input.title.slice(0, 240), input.description.slice(0, 2000), input.sourceId ?? null,
    input.score, input.method, input.reason.slice(0, 500),
  );
}
