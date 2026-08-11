/**
 * Domain-logic tests for get_ready_work: the tool that turns "what's unblocked" into
 * "what should an agent actually pick up next." Covers the two exclusions (blocked,
 * claimed-by-another-live-session) and the unlock-count-first ranking.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-d1.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand, getReadyWork, organizationFor, registerSourceSession, updateSourceHeartbeat } from "@/lib/store.ts";

async function readyItem(db, projectId, title, key = crypto.randomUUID()) {
  const id = await createItem(db, projectId, title, key);
  const record = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(id).first();
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId: id, expectedVersion: record.version, status: "ready", idempotencyKey: `ready-${key}` });
  return id;
}

async function link(db, projectId, fromWorkItemId, toWorkItemId, key) {
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId, toWorkItemId, type: "blocks", idempotencyKey: key });
}

test("only status=ready with blocking_count=0 is a candidate", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const ready = await readyItem(db, projectId, "Actionable now");
  const proposed = await createItem(db, projectId, "Not yet triaged");
  const blocker = await createItem(db, projectId, "Unresolved blocker");
  const blockedReady = await readyItem(db, projectId, "Marked ready but still blocked");
  await link(db, projectId, blocker, blockedReady, "l1");

  const result = await getReadyWork(db, principal, { projectId });
  const ids = result.workItems.map((item) => item.id);
  assert.ok(ids.includes(ready));
  assert.ok(!ids.includes(proposed), "proposed work has not been triaged into ready");
  assert.ok(!ids.includes(blockedReady), "graph-blocked items are never handed out even if status says ready");
  assert.ok(!ids.includes(blocker), "the blocker itself is still 'proposed', not a candidate");
});

test("excludes work claimed by another active session, but not the caller's own claims", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemA = await readyItem(db, projectId, "Claimed by someone else");
  const itemB = await readyItem(db, projectId, "Claimed by the caller itself");
  const itemC = await readyItem(db, projectId, "Unclaimed");

  const mine = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "session-mine" });
  const theirs = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "session-theirs" });
  await updateSourceHeartbeat(db, principal, { sourceId: theirs.sourceId, currentTaskIds: [itemA] });
  await updateSourceHeartbeat(db, principal, { sourceId: mine.sourceId, currentTaskIds: [itemB] });

  const result = await getReadyWork(db, principal, { projectId, sourceId: mine.sourceId });
  const ids = result.workItems.map((item) => item.id);
  assert.ok(!ids.includes(itemA), "another session's claim must exclude the item");
  assert.ok(ids.includes(itemB), "the calling session's own claim must not self-exclude");
  assert.ok(ids.includes(itemC));
  assert.equal(result.excludedByCollision, 1);
});

test("a claim from an ended session does not exclude the item", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const item = await readyItem(db, projectId, "Was claimed by a session that has since ended");
  const source = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "gone" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [item] });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, end: true });

  const result = await getReadyWork(db, principal, { projectId });
  assert.ok(result.workItems.some((entry) => entry.id === item));
});

test("avoidCollisions: false surfaces claimed work anyway", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const item = await readyItem(db, projectId, "Claimed elsewhere");
  const theirs = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "session-theirs" });
  await updateSourceHeartbeat(db, principal, { sourceId: theirs.sourceId, currentTaskIds: [item] });

  const excluding = await getReadyWork(db, principal, { projectId });
  assert.ok(!excluding.workItems.some((entry) => entry.id === item));
  const including = await getReadyWork(db, principal, { projectId, avoidCollisions: false });
  assert.ok(including.workItems.some((entry) => entry.id === item));
});

test("ranks by unlock count: finishing the item that frees the most work comes first", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const freesTwo = await readyItem(db, projectId, "Blocks two other tasks");
  const freesNone = await readyItem(db, projectId, "Blocks nothing");
  const downstreamA = await createItem(db, projectId, "Waits on freesTwo, A");
  const downstreamB = await createItem(db, projectId, "Waits on freesTwo, B");
  await link(db, projectId, freesTwo, downstreamA, "l1");
  await link(db, projectId, freesTwo, downstreamB, "l2");

  const result = await getReadyWork(db, principal, { projectId });
  const order = result.workItems.map((item) => item.id);
  assert.equal(order[0], freesTwo);
  assert.ok(order.includes(freesNone));
  assert.equal(result.workItems.find((item) => item.id === freesTwo).unlockCount, 2);
  assert.equal(result.workItems.find((item) => item.id === freesNone).unlockCount, 0);
});

test("unlock count only counts items that would reach zero, not items with other remaining blockers", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const target = await readyItem(db, projectId, "Would free one, not the other");
  const stillDoublyBlocked = await createItem(db, projectId, "Has two blockers");
  const otherBlocker = await createItem(db, projectId, "The other blocker, unresolved");
  await link(db, projectId, target, stillDoublyBlocked, "l1");
  await link(db, projectId, otherBlocker, stillDoublyBlocked, "l2");

  const result = await getReadyWork(db, principal, { projectId });
  assert.equal(result.workItems.find((item) => item.id === target).unlockCount, 0, "stillDoublyBlocked has blocking_count 2, so target finishing it does not free it");
});

test("priority breaks ties when unlock count is equal", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const low = await readyItem(db, projectId, "Low priority");
  const urgent = await readyItem(db, projectId, "Urgent priority");
  await executeCommand(db, principal, { action: "update_item", projectId, itemId: low, expectedVersion: 2, priority: "low", idempotencyKey: "p1" });
  await executeCommand(db, principal, { action: "update_item", projectId, itemId: urgent, expectedVersion: 2, priority: "urgent", idempotencyKey: "p2" });

  const result = await getReadyWork(db, principal, { projectId });
  const order = result.workItems.map((item) => item.id);
  assert.equal(order[0], urgent);
});

test("limit is respected and defaults to 5", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  for (let index = 0; index < 8; index++) await readyItem(db, projectId, `Ready task ${index}`, `k${index}`);

  const defaulted = await getReadyWork(db, principal, { projectId });
  assert.equal(defaulted.workItems.length, 5);
  const limited = await getReadyWork(db, principal, { projectId, limit: 2 });
  assert.equal(limited.workItems.length, 2);
});

test("each item carries a plain-language reason, not a bare score", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const solo = await readyItem(db, projectId, "Frees nothing downstream");
  const unlocker = await readyItem(db, projectId, "Frees one downstream item");
  const downstream = await createItem(db, projectId, "Waits on unlocker");
  await link(db, projectId, unlocker, downstream, "l1");

  const result = await getReadyWork(db, principal, { projectId });
  const soloEntry = result.workItems.find((item) => item.id === solo);
  const unlockerEntry = result.workItems.find((item) => item.id === unlocker);
  assert.equal(soloEntry.reason, "Unblocked and ready.");
  assert.equal(unlockerEntry.reason, "Finishing this frees 1 other task.");
});

test("corroboration (independently proposed by more agents) breaks remaining ties", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const org = await organizationFor(db, principal);
  const claude = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "c1" });
  const codex = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "c2" });

  const singlyProposed = await createItem(db, projectId, "Only Claude proposed this");
  await db.prepare("UPDATE work_items SET source_id = ?, status = 'ready', version = version + 1 WHERE id = ?").bind(claude.sourceId, singlyProposed).run();

  const corroborated = await createItem(db, projectId, "Both agents proposed this");
  await db.prepare("UPDATE work_items SET source_id = ?, status = 'ready', version = version + 1 WHERE id = ?").bind(claude.sourceId, corroborated).run();
  await db.prepare("INSERT INTO work_item_aliases (id, organization_id, project_id, work_item_id, title, source_id, match_method) VALUES (?, ?, ?, ?, ?, ?, 'fingerprint')")
    .bind("als_test", org, projectId, corroborated, "Both agents proposed this", codex.sourceId).run();

  const result = await getReadyWork(db, principal, { projectId });
  const order = result.workItems.map((item) => item.id);
  assert.equal(order.indexOf(corroborated) < order.indexOf(singlyProposed), true, "the item independently proposed by two agents should rank ahead at equal unlock count and priority");
});
