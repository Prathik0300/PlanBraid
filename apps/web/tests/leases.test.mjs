/**
 * F1 — work_claims, wired up.
 *
 * The table existed with the right lease columns since the schema was designed and
 * nothing ever wrote to it; collision avoidance instead relied on
 * `sources.current_task_ids`, which never expires. The defect that fix closes: a crashed
 * agent's claim on a task blocked every other session from picking it up forever, with no
 * scheduler and nobody able to clear it by hand. These tests are built around exactly that
 * scenario, plus the ordinary heartbeat/release paths ready-work.test.mjs already covers
 * from the outside.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand, getReadyWork, loadDashboard, registerSourceSession, startWork, updateSourceHeartbeat } from "@/lib/store.ts";

/** Actionable the way the product makes work actionable: proposed by an agent, then
 * accepted by a person. Readiness is derived from acceptance plus a clear graph, so there
 * is deliberately no transition to 'ready' here. */
async function readyItem(db, projectId, title, key = crypto.randomUUID()) {
  const id = await createItem(db, projectId, title, key);
  await executeCommand(db, principal, { action: "set_maturity", projectId, itemIds: [id], maturity: "accepted", statedBy: "Graph Tester", idempotencyKey: `accept-${key}` });
  return id;
}

test("a heartbeat with current task IDs writes a live claim", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const item = await readyItem(db, projectId, "Claim me");
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s1" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [item] });

  const claim = await db.prepare("SELECT * FROM work_claims WHERE work_item_id = ? AND source_id = ?").bind(item, source.sourceId).first();
  assert.ok(claim, "a claim row must exist");
  assert.equal(claim.mode, "exclusive");
  assert.ok(new Date(claim.lease_expires_at).getTime() > Date.now(), "a fresh claim's lease must not already be expired");
});

test("an expired lease does not exclude the item, with no cleanup job required", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const item = await readyItem(db, projectId, "Was claimed by a session that crashed");
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s2" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [item] });

  // Simulate a crash: no end_agent_session, no further heartbeat, just time passing. Force
  // it by backdating the lease directly rather than waiting 45 real minutes.
  await db.prepare("UPDATE work_claims SET lease_expires_at = now() - interval '1 minute' WHERE work_item_id = ?").bind(item).run();

  const result = await getReadyWork(db, principal, { projectId });
  assert.ok(result.workItems.some((entry) => entry.id === item), "an expired lease must free the item without anything having deleted the row");
});

test("a fresh heartbeat extends the lease rather than requiring a new claim", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const item = await readyItem(db, projectId, "Actively worked");
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s3" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [item] });
  const first = await db.prepare("SELECT lease_expires_at, version FROM work_claims WHERE work_item_id = ?").bind(item).first();

  await new Promise((resolve) => setTimeout(resolve, 5));
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [item] });
  const second = await db.prepare("SELECT lease_expires_at, version FROM work_claims WHERE work_item_id = ?").bind(item).first();

  assert.ok(new Date(second.lease_expires_at).getTime() >= new Date(first.lease_expires_at).getTime(), "a later heartbeat must not shorten the lease");
  assert.equal(Number(second.version), Number(first.version) + 1, "the same claim row is updated, not duplicated");
  const count = await db.prepare("SELECT COUNT(*) AS count FROM work_claims WHERE work_item_id = ?").bind(item).first();
  assert.equal(Number(count.count), 1);
});

test("dropping a task from current_task_ids releases its claim immediately, not on expiry", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemA = await readyItem(db, projectId, "Still held");
  const itemB = await readyItem(db, projectId, "Moved off of");
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s4" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [itemA, itemB] });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [itemA] });

  assert.ok(await db.prepare("SELECT 1 FROM work_claims WHERE work_item_id = ?").bind(itemA).first());
  assert.equal(await db.prepare("SELECT 1 FROM work_claims WHERE work_item_id = ?").bind(itemB).first(), null);
});

test("ending a session releases every claim it held, immediately", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemA = await readyItem(db, projectId, "Held one");
  const itemB = await readyItem(db, projectId, "Held two");
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s5" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [itemA, itemB] });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, end: true });

  const remaining = await db.prepare("SELECT COUNT(*) AS count FROM work_claims WHERE source_id = ?").bind(source.sourceId).first();
  assert.equal(Number(remaining.count), 0);
});

test("a heartbeat that only updates presence, with no currentTaskIds field at all, leaves existing claims untouched", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const item = await readyItem(db, projectId, "Held across a presence-only heartbeat");
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s6" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [item] });

  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, state: "active" });

  assert.ok(await db.prepare("SELECT 1 FROM work_claims WHERE work_item_id = ?").bind(item).first(), "a heartbeat that says nothing about current work must not silently release it");
});

test("a claim from one project's item is invisible to a collision check on another project", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, principal, { action: "create_project", name: "Other", idempotencyKey: "lp2" })).projectId;
  const itemInB = await readyItem(db, projectB, "Ready in the other project");
  const source = await registerSourceSession(db, principal, { projectId: projectB, provider: "claude", externalId: "s7" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [itemInB] });

  const resultForA = await getReadyWork(db, principal, { projectId: projectA });
  assert.deepEqual(resultForA.workItems, []);
  const resultForB = await getReadyWork(db, principal, { projectId: projectB });
  assert.deepEqual(resultForB.workItems.map((item) => item.id), []); // claimed by another session
});

test("the caller's own live claim never excludes its own request", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const item = await readyItem(db, projectId, "Held by the caller itself");
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s8" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [item] });

  const result = await getReadyWork(db, principal, { projectId, sourceId: source.sourceId });
  assert.ok(result.workItems.some((entry) => entry.id === item));
});

test("more than 100 reported task IDs are capped, matching sources.current_task_ids's own cap", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const items = [];
  for (let index = 0; index < 105; index += 1) items.push(await readyItem(db, projectId, `Bulk ${index}`, `bulk-${index}`));
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s9" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: items });

  const count = await db.prepare("SELECT COUNT(*) AS count FROM work_claims WHERE source_id = ?").bind(source.sourceId).first();
  assert.equal(Number(count.count), 100);
});

test("M14: start_work takes an exclusive lease, and a second live session's start_work on the same item is rejected", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Contested task");
  const holder = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "lease-a" });
  const challenger = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "lease-b" });

  const version = (await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first()).version;
  await startWork(db, principal, { projectId, itemId, expectedVersion: version, sourceId: holder.sourceId, idempotencyKey: "sw1" });

  const claim = await db.prepare("SELECT source_id FROM work_claims WHERE work_item_id = ?").bind(itemId).first();
  assert.equal(claim.source_id, holder.sourceId, "start_work must itself write the lease, not wait for a later heartbeat");

  await assert.rejects(
    startWork(db, principal, { projectId, itemId, expectedVersion: version + 1, sourceId: challenger.sourceId, idempotencyKey: "sw2" }),
    (error) => { assert.equal(error.code, "WORK_LEASED"); assert.equal(error.status, 409); assert.equal(error.details.holderSourceId, holder.sourceId); return true; },
  );
});

test("M14: force: true overrides another session's live lease and records the takeover", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Reassigned task");
  const holder = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "lease-c" });
  const challenger = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "lease-d" });
  const version = (await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first()).version;
  await startWork(db, principal, { projectId, itemId, expectedVersion: version, sourceId: holder.sourceId, idempotencyKey: "sw3" });

  await startWork(db, principal, { projectId, itemId, expectedVersion: version + 1, sourceId: challenger.sourceId, force: true, idempotencyKey: "sw4" });

  const claim = await db.prepare("SELECT source_id FROM work_claims WHERE work_item_id = ?").bind(itemId).first();
  assert.equal(claim.source_id, challenger.sourceId, "the lease must move to the forcing session");
  const event = await db.prepare("SELECT summary FROM work_events WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1").bind(itemId).first();
  assert.match(event.summary, /forced takeover/);
});

test("M14: start_work with no sourceId at all skips lease enforcement entirely, rather than crashing", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Anonymous start");
  const version = (await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first()).version;

  await startWork(db, principal, { projectId, itemId, expectedVersion: version, idempotencyKey: "sw5" });

  const row = await db.prepare("SELECT status FROM work_items WHERE id = ?").bind(itemId).first();
  assert.equal(row.status, "in_progress");
  assert.equal(await db.prepare("SELECT 1 FROM work_claims WHERE work_item_id = ?").bind(itemId).first(), null);
});

test("M14: re-starting an item you already hold the lease on is not treated as a conflict with yourself", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Restarted by the same session");
  const source = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "lease-e" });
  const version = (await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first()).version;
  await startWork(db, principal, { projectId, itemId, expectedVersion: version, sourceId: source.sourceId, idempotencyKey: "sw6" });
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId, expectedVersion: version + 1, status: "blocked", idempotencyKey: "sw6-block" });

  const blockedVersion = (await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first()).version;
  await startWork(db, principal, { projectId, itemId, expectedVersion: blockedVersion, sourceId: source.sourceId, idempotencyKey: "sw7" });

  const row = await db.prepare("SELECT status FROM work_items WHERE id = ?").bind(itemId).first();
  assert.equal(row.status, "in_progress");
});

test("M14: an expired lease does not block a different session's start_work", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Abandoned then reclaimed");
  const holder = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "lease-f" });
  const challenger = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "lease-g" });
  const version = (await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first()).version;
  await startWork(db, principal, { projectId, itemId, expectedVersion: version, sourceId: holder.sourceId, idempotencyKey: "sw8" });
  await db.prepare("UPDATE work_claims SET lease_expires_at = now() - interval '1 minute' WHERE work_item_id = ?").bind(itemId).run();

  await startWork(db, principal, { projectId, itemId, expectedVersion: version + 1, sourceId: challenger.sourceId, idempotencyKey: "sw9" });

  const claim = await db.prepare("SELECT source_id FROM work_claims WHERE work_item_id = ?").bind(itemId).first();
  assert.equal(claim.source_id, challenger.sourceId);
});

test("M14: the dashboard surfaces live claims for the Agents view, and only live ones", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const live = await readyItem(db, projectId, "Actively held");
  const expired = await readyItem(db, projectId, "Held by a session that crashed");
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s10" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [live, expired] });
  await db.prepare("UPDATE work_claims SET lease_expires_at = now() - interval '1 minute' WHERE work_item_id = ?").bind(expired).run();

  const dashboard = await loadDashboard(db, principal);
  const projectClaims = dashboard.claims.filter((claim) => claim.workItemId === live || claim.workItemId === expired);
  assert.equal(projectClaims.length, 1, "an expired lease must not appear in the dashboard's claims");
  assert.equal(projectClaims[0].workItemId, live);
  assert.equal(projectClaims[0].sourceId, source.sourceId);
});
