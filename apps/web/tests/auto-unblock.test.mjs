/**
 * Domain-logic tests for blocking_count propagation: the core payoff of the graph
 * work: a downstream item becomes ready by itself when its last blocker resolves, with
 * no write to the downstream row's asserted state. See GRAPH_ARCHITECTURE.md §4.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-d1.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand, organizationFor, recomputeBlockingCounts } from "@/lib/store.ts";

async function blockingCountOf(db, itemId) {
  const row = await db.prepare("SELECT blocking_count, version, status, unblocked_at FROM work_items WHERE id = ?").bind(itemId).first();
  return row;
}

async function link(db, projectId, fromWorkItemId, toWorkItemId, key) {
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId, toWorkItemId, type: "blocks", idempotencyKey: key });
}

async function transition(db, projectId, itemId, expectedVersion, status, key) {
  return executeCommand(db, principal, { action: "transition_item", projectId, itemId, expectedVersion, status, idempotencyKey: key });
}

test("add_dependency: increments blocking_count on the dependent when the prerequisite is unresolved", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Prerequisite A");
  const b = await createItem(db, projectId, "Dependent B");
  assert.equal((await blockingCountOf(db, b)).blocking_count, 0);
  await link(db, projectId, a, b, "l1");
  assert.equal((await blockingCountOf(db, b)).blocking_count, 1);
});

test("add_dependency: an edge from an already-resolved item does not increment blocking_count", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Already-finished prerequisite");
  const b = await createItem(db, projectId, "Dependent");
  await transition(db, projectId, a, 1, "planned", "t1");
  await transition(db, projectId, a, 2, "ready", "t2");
  await transition(db, projectId, a, 3, "in_progress", "t3");
  await transition(db, projectId, a, 4, "done", "t4");
  await link(db, projectId, a, b, "l1");
  assert.equal((await blockingCountOf(db, b)).blocking_count, 0);
});

test("add_dependency: an annotation edge (relates_to) never affects blocking_count", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Related item A");
  const b = await createItem(db, projectId, "Related item B");
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: a, toWorkItemId: b, type: "relates_to", idempotencyKey: "l1" });
  assert.equal((await blockingCountOf(db, b)).blocking_count, 0);
});

test("completing the only blocker frees the downstream item: blocking_count drops to 0, no version bump", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Blocker A");
  const b = await createItem(db, projectId, "Blocked B");
  await link(db, projectId, a, b, "l1");
  const before = await blockingCountOf(db, b);
  assert.equal(before.blocking_count, 1);
  assert.equal(before.version, 1);

  await transition(db, projectId, a, 1, "planned", "t1");
  await transition(db, projectId, a, 2, "ready", "t2");
  await transition(db, projectId, a, 3, "in_progress", "t3");
  const result = await transition(db, projectId, a, 4, "done", "t4");

  const after = await blockingCountOf(db, b);
  assert.equal(after.blocking_count, 0, "blocking_count must drop to 0");
  assert.ok(after.unblocked_at, "unblocked_at must be stamped");
  assert.equal(after.version, before.version, "downstream item's asserted version must never change");
  assert.equal(after.status, "proposed", "auto-unblock changes blocking_count only, never the stored status");
  assert.ok(result.projectRevision > 0);
});

test("cancelling a blocker counts as resolved, exactly like completing it", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Blocker A");
  const b = await createItem(db, projectId, "Blocked B");
  await link(db, projectId, a, b, "l1");
  assert.equal((await blockingCountOf(db, b)).blocking_count, 1);

  await transition(db, projectId, a, 1, "cancelled", "t1");
  const after = await blockingCountOf(db, b);
  assert.equal(after.blocking_count, 0, "cancelling the blocker must free the downstream item, or it deadlocks forever");
});

test("an aggregate work_item.downstream_unblocked event is emitted, on its own revision", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Blocker A");
  const b = await createItem(db, projectId, "Blocked B");
  await link(db, projectId, a, b, "l1");
  await transition(db, projectId, a, 1, "planned", "t1");
  await transition(db, projectId, a, 2, "ready", "t2");
  await transition(db, projectId, a, 3, "in_progress", "t3");
  const result = await transition(db, projectId, a, 4, "done", "t4");

  const org = await organizationFor(db, principal);
  const events = await db.prepare("SELECT event_type, project_revision, summary, metadata FROM work_events WHERE organization_id = ? AND event_type IN ('work_item.completion_verified', 'work_item.downstream_unblocked') ORDER BY project_revision")
    .bind(org).all();
  assert.equal(events.results.length, 2, "the transition event and the aggregate unblock event are two distinct revisions");
  const [transitionEvent, unblockEvent] = events.results;
  assert.ok(unblockEvent.project_revision > transitionEvent.project_revision);
  assert.equal(unblockEvent.project_revision, result.projectRevision, "the response reports the final revision after propagation");
  const metadata = JSON.parse(unblockEvent.metadata);
  assert.deepEqual(metadata.itemKeys, ["#2"]);
  assert.match(unblockEvent.summary, /unblocking 1 task/);
});

test("reopening a resolved blocker re-blocks the downstream item and emits work_item.downstream_reblocked", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Blocker A");
  const b = await createItem(db, projectId, "Blocked B");
  await link(db, projectId, a, b, "l1");
  await transition(db, projectId, a, 1, "planned", "t1");
  await transition(db, projectId, a, 2, "ready", "t2");
  await transition(db, projectId, a, 3, "in_progress", "t3");
  await transition(db, projectId, a, 4, "done", "t4");
  const freed = await blockingCountOf(db, b);
  assert.equal(freed.blocking_count, 0);
  assert.ok(freed.unblocked_at, "unblocked_at must be stamped once freed");

  await transition(db, projectId, a, 5, "ready", "reopen1");
  const after = await blockingCountOf(db, b);
  assert.equal(after.blocking_count, 1, "reopening the blocker must re-block the downstream item");
  assert.equal(after.unblocked_at, null, "a stale unblocked_at must be cleared once the item is blocked again");

  const org = await organizationFor(db, principal);
  const reblocked = await db.prepare("SELECT summary FROM work_events WHERE organization_id = ? AND event_type = 'work_item.downstream_reblocked'").bind(org).first();
  assert.match(reblocked.summary, /re-blocks 1 task/);
});

test("a downstream item with two blockers is freed only once both resolve", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Blocker A");
  const c = await createItem(db, projectId, "Blocker C");
  const b = await createItem(db, projectId, "Doubly-blocked B");
  await link(db, projectId, a, b, "l1");
  await link(db, projectId, c, b, "l2");
  assert.equal((await blockingCountOf(db, b)).blocking_count, 2);

  await transition(db, projectId, a, 1, "planned", "ta1");
  await transition(db, projectId, a, 2, "ready", "ta2");
  await transition(db, projectId, a, 3, "in_progress", "ta3");
  await transition(db, projectId, a, 4, "done", "ta4");
  const midway = await blockingCountOf(db, b);
  assert.equal(midway.blocking_count, 1, "one blocker resolved: still blocked on the other");

  const org = await organizationFor(db, principal);
  const noEventYet = await db.prepare("SELECT COUNT(*) AS count FROM work_events WHERE organization_id = ? AND event_type = 'work_item.downstream_unblocked'").bind(org).first();
  assert.equal(noEventYet.count, 0, "must not report unblocked until the item is actually free");

  await transition(db, projectId, c, 1, "planned", "tc1");
  await transition(db, projectId, c, 2, "ready", "tc2");
  await transition(db, projectId, c, 3, "in_progress", "tc3");
  await transition(db, projectId, c, 4, "done", "tc4");
  assert.equal((await blockingCountOf(db, b)).blocking_count, 0);
  const nowEvent = await db.prepare("SELECT COUNT(*) AS count FROM work_events WHERE organization_id = ? AND event_type = 'work_item.downstream_unblocked'").bind(org).first();
  assert.equal(nowEvent.count, 1);
});

test("completing an item with no downstream dependents does not emit an aggregate event", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Standalone task");
  await transition(db, projectId, a, 1, "planned", "t1");
  await transition(db, projectId, a, 2, "ready", "t2");
  await transition(db, projectId, a, 3, "in_progress", "t3");
  const result = await transition(db, projectId, a, 4, "done", "t4");

  const org = await organizationFor(db, principal);
  const events = await db.prepare("SELECT COUNT(*) AS count FROM work_events WHERE organization_id = ? AND event_type = 'work_item.downstream_unblocked'").bind(org).first();
  assert.equal(events.count, 0);
  // No propagation revision was consumed, so this is the plain single-revision case.
  const project = await db.prepare("SELECT revision FROM projects WHERE organization_id = ?").bind(org).first();
  assert.equal(project.revision, result.projectRevision);
});

test("recomputeBlockingCounts repairs drift back to the true count", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Blocker A");
  const b = await createItem(db, projectId, "Blocked B");
  await link(db, projectId, a, b, "l1");
  assert.equal((await blockingCountOf(db, b)).blocking_count, 1);

  // Simulate drift: corrupt the counter directly, bypassing the maintained path.
  await db.prepare("UPDATE work_items SET blocking_count = 99 WHERE id = ?").bind(b).run();
  assert.equal((await blockingCountOf(db, b)).blocking_count, 99);

  const org = await organizationFor(db, principal);
  await recomputeBlockingCounts(db, org, projectId);
  assert.equal((await blockingCountOf(db, b)).blocking_count, 1, "repair must restore the count derived from actual edges");
});

test("recomputeBlockingCounts treats a done or cancelled prerequisite as resolved", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Blocker A");
  const b = await createItem(db, projectId, "Blocked B");
  await link(db, projectId, a, b, "l1");
  await transition(db, projectId, a, 1, "planned", "t1");
  await transition(db, projectId, a, 2, "ready", "t2");
  await transition(db, projectId, a, 3, "in_progress", "t3");
  await transition(db, projectId, a, 4, "done", "t4");

  // Corrupt it back up, then confirm the repair correctly reads through to A's real status.
  await db.prepare("UPDATE work_items SET blocking_count = 5 WHERE id = ?").bind(b).run();
  const org = await organizationFor(db, principal);
  await recomputeBlockingCounts(db, org, projectId);
  assert.equal((await blockingCountOf(db, b)).blocking_count, 0);
});
