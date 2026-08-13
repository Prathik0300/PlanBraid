/**
 * E4 — DB-backed integration: a typed relation surfaced by `lib/dedup/relations.ts`
 * actually becomes a graph edge when a proposal is created through
 * `createWorkItemsDeduplicated`, and a CONFLICT relation actually raises a decision when
 * `raiseConflictDecisions` runs over the result — the two halves `app/mcp/route.ts`'s
 * `create_work_items` handler chains together, tested separately here since that route
 * file itself isn't imported by any test in this project (every other MCP tool is
 * exercised at this same lib/store layer).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { createWorkItemsDeduplicated } from "@/lib/store.ts";
import { raiseConflictDecisions } from "@/lib/planning/decisions.ts";

async function edgesFrom(db, workItemId) {
  const rows = await db.prepare("SELECT type, to_work_item_id, reason FROM dependencies WHERE from_work_item_id = ?").bind(workItemId).all();
  return rows.results;
}

test("SUBSET: a proposal whose artifacts are contained in an existing item's is created and linked with a subset_of edge", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const existingId = await createItem(db, projectId, "Add lib/dedup/relations.ts and lib/dedup/train.ts");

  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "subset-1",
    proposals: [{ title: "Add lib/dedup/relations.ts" }],
  });

  assert.equal(outcome.results.length, 1);
  const entry = outcome.results[0];
  assert.equal(entry.status, "created");
  assert.equal(entry.relation?.type, "SUBSET");
  assert.equal(entry.relation?.workItemId, existingId);

  const edges = await edgesFrom(db, entry.workItemId);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].type, "subset_of");
  assert.equal(edges[0].to_work_item_id, existingId);
});

test("OVERLAP: partial artifact overlap is created and linked with an overlaps_with edge", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const existingId = await createItem(db, projectId, "Update lib/dedup/blocking.ts and lib/dedup/train.ts and lib/dedup/relations.ts and lib/dedup/signature.ts");

  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "overlap-1",
    proposals: [{ title: "Update lib/dedup/blocking.ts and lib/dedup/features.ts" }],
  });

  const entry = outcome.results[0];
  assert.equal(entry.status, "created");
  assert.equal(entry.relation?.type, "OVERLAP");
  const edges = await edgesFrom(db, entry.workItemId);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].type, "overlaps_with");
  assert.equal(edges[0].to_work_item_id, existingId);
});

test("CONFLICT: opposite intent on the same artifact is created and linked with a direct conflicts_with edge (fixes F3)", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const existingId = await createItem(db, projectId, "Add lib/auth/middleware.ts");

  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "conflict-1",
    proposals: [{ title: "Remove lib/auth/middleware.ts" }],
  });

  const entry = outcome.results[0];
  assert.equal(entry.status, "created");
  assert.equal(entry.relation?.type, "CONFLICT");
  const edges = await edgesFrom(db, entry.workItemId);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].type, "conflicts_with");
  assert.equal(edges[0].to_work_item_id, existingId);
});

test("CONFLICT: raiseConflictDecisions turns the flagged entry into an open decision with both sides as options", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const existingId = await createItem(db, projectId, "Add lib/auth/middleware.ts");

  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "conflict-2",
    proposals: [{ title: "Remove lib/auth/middleware.ts" }],
  });
  const newItemId = outcome.results[0].workItemId;

  await raiseConflictDecisions(db, principal, { projectId, idempotencyKey: "conflict-2", results: outcome.results });

  const entry = outcome.results[0];
  assert.ok(entry.decision, "the result entry should be annotated with the raised decision");

  const decisionRow = await db.prepare("SELECT type, status FROM work_items WHERE id = ?").bind(entry.decision.workItemId).first();
  assert.equal(decisionRow.type, "decision");

  const options = await db.prepare("SELECT related_work_item_id FROM decision_options WHERE decision_work_item_id = ?").bind(entry.decision.workItemId).all();
  const relatedIds = options.results.map((row) => row.related_work_item_id).sort();
  assert.deepEqual(relatedIds, [existingId, newItemId].sort());
});

test("CONFLICT: raiseConflictDecisions is a no-op for entries without a CONFLICT relation", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Add lib/dedup/relations.ts and lib/dedup/train.ts");

  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "no-conflict-1",
    proposals: [{ title: "Add lib/dedup/relations.ts" }],
  });
  const before = JSON.stringify(outcome.results);
  await raiseConflictDecisions(db, principal, { projectId, idempotencyKey: "no-conflict-1", results: outcome.results });
  assert.equal(JSON.stringify(outcome.results), before);

  const decisionCount = await db.prepare("SELECT COUNT(*)::int AS count FROM work_items WHERE project_id = ? AND type = 'decision'").bind(projectId).first();
  assert.equal(Number(decisionCount.count), 0);
});

test("RELATED: strong lexical overlap with no shared artifact is created and linked with a relates_to edge", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const existingId = await createItem(db, projectId, "Add rate limiting for the API gateway");

  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "related-1",
    proposals: [{ title: "Add rate limiting to the API" }],
  });

  const entry = outcome.results[0];
  assert.equal(entry.status, "created");
  assert.equal(entry.relation?.type, "RELATED");
  const edges = await edgesFrom(db, entry.workItemId);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].type, "relates_to");
  assert.equal(edges[0].to_work_item_id, existingId);
});

test("NEW: nothing shared produces no relation and no edge", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Improve onboarding copy");

  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "new-1",
    proposals: [{ title: "Speed up the search index" }],
  });

  const entry = outcome.results[0];
  assert.equal(entry.status, "created");
  assert.equal(entry.relation, undefined);
  const edges = await edgesFrom(db, entry.workItemId);
  assert.equal(edges.length, 0);
});
