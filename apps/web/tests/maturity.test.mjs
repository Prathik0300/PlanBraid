/**
 * M8 — the maturity ladder and the resolution qualifier.
 *
 * The two axes this milestone adds are what keep AI brainstorming out of the plan
 * ("we could migrate to GraphQL" is a proposal, not a task) and what makes an unfinished
 * task explain itself ("cancelled" alone never distinguished rejected from deferred).
 *
 * The rules with teeth, all covered below: an agent may propose but not decide; an agent
 * may *report* a person's decision, and that is recorded as weaker evidence than a click;
 * existing rows keep working; and deferral expires without anything having to run.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { createWorkItemsDeduplicated, executeCommand, getReadyWork, organizationFor } from "@/lib/store.ts";
import { listWorkItems, loadProjectView } from "@/lib/read/project-view.ts";
import { AGENT_WRITABLE_MATURITIES, MATURITIES, RESOLUTIONS } from "@/lib/contracts.ts";

/** A token-authenticated agent: same owner, no browser session behind it. */
const agent = { ...principal, authentication: "personal_token", credentialId: "cred_1", agentAccountId: "cred_1", agentAccountLabel: "Claude work" };
const browser = { ...principal, authentication: "browser" };

async function itemById(db, itemId) {
  return db.prepare("SELECT * FROM work_items WHERE id = ?").bind(itemId).first();
}

async function transition(db, who, projectId, itemId, status, key, extra = {}) {
  const row = await itemById(db, itemId);
  return executeCommand(db, who, { action: "transition_item", projectId, itemId, expectedVersion: row.version, status, idempotencyKey: key, ...extra });
}

/** Created as a person would, so the item under test is accepted work unless a case
 * deliberately demotes it. Fixtures' shared `principal` carries no authentication, which
 * every production path does — see the Principal type. */
async function readyItem(db, projectId, title, key) {
  const created = await executeCommand(db, browser, { action: "create_item", projectId, title, idempotencyKey: `item-${key}` });
  await transition(db, browser, projectId, created.itemId, "planned", `${key}-p`);
  await transition(db, browser, projectId, created.itemId, "ready", `${key}-r`);
  return created.itemId;
}

// ── The ladder ───────────────────────────────────────────────────────────────────────

test("existing rows default to accepted so no board empties on deploy", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  // A row written the way every row was written before this column existed.
  await db.prepare("INSERT INTO work_items (id, organization_id, project_id, sequence, item_key, title, status) VALUES ('wi_legacy', ?, ?, 77, '#77', 'Work from before the ladder', 'ready')")
    .bind(organizationId, projectId).run();

  const [item] = await listWorkItems(db, organizationId, { projectId });
  assert.equal(item.maturity, "accepted");
});

test("a person's own entry is accepted; an agent's proposal is a proposal", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);

  const typed = await executeCommand(db, browser, { action: "create_item", projectId, title: "Typed by a person", idempotencyKey: "h1" });
  const proposed = await executeCommand(db, agent, { action: "create_item", projectId, title: "Suggested by an agent", idempotencyKey: "a1" });

  assert.equal(typed.maturity, "accepted");
  assert.equal(proposed.maturity, "proposal");
});

test("create_work_items records an agent batch as proposals, and says so in the result", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);

  const result = await createWorkItemsDeduplicated(db, agent, {
    projectId, idempotencyKey: "batch-1",
    proposals: [{ ref: "a", title: "Migrate the API from REST to GraphQL" }, { ref: "b", title: "Add a health check to /api/status" }],
  });

  assert.equal(result.summary.created, 2);
  assert.ok(result.results.every((entry) => entry.maturity === "proposal"));
  assert.ok(result.results.every((entry) => /awaiting acceptance/i.test(entry.note ?? "")), "the agent must be told these are not accepted work");
});

test("an agent cannot promote its own proposal without naming who decided", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const proposed = await executeCommand(db, agent, { action: "create_item", projectId, title: "Rewrite the scheduler", idempotencyKey: "a2" });

  await assert.rejects(
    () => executeCommand(db, agent, { action: "set_maturity", projectId, itemIds: [proposed.itemId], maturity: "accepted", idempotencyKey: "promote-1" }),
    (error) => error.code === "AUTHORITY_REQUIRED" && error.status === 403,
  );
  assert.equal((await itemById(db, proposed.itemId)).maturity, "proposal");
});

test("an agent reporting a person's acceptance records it as stated, not approved", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const proposed = await executeCommand(db, agent, { action: "create_item", projectId, title: "Rewrite the scheduler", idempotencyKey: "a3" });

  const result = await executeCommand(db, agent, { action: "set_maturity", projectId, itemIds: [proposed.itemId], maturity: "accepted", statedBy: "Prathik", idempotencyKey: "promote-2" });
  assert.equal(result.authority, "human_stated");
  assert.equal((await itemById(db, proposed.itemId)).maturity, "accepted");

  const event = await db.prepare("SELECT * FROM work_events WHERE event_type = 'work_item.maturity_changed'").first();
  assert.equal(JSON.parse(event.metadata).authority, "human_stated");
  assert.equal(JSON.parse(event.metadata).statedBy, "Prathik");
  assert.match(event.summary, /as decided by Prathik/);
});

test("a person clicking accept is recorded as approved, a stronger claim than an agent's report", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const proposed = await executeCommand(db, agent, { action: "create_item", projectId, title: "Rewrite the scheduler", idempotencyKey: "a4" });

  const result = await executeCommand(db, browser, { action: "set_maturity", projectId, itemIds: [proposed.itemId], maturity: "accepted", idempotencyKey: "promote-3" });
  assert.equal(result.authority, "human_approved");
});

test("an agent may still write the rungs below acceptance", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const proposed = await executeCommand(db, agent, { action: "create_item", projectId, title: "A thought", idempotencyKey: "a5" });

  const result = await executeCommand(db, agent, { action: "set_maturity", projectId, itemIds: [proposed.itemId], maturity: "idea", idempotencyKey: "demote-1" });
  assert.equal(result.maturity, "idea");
  assert.ok(AGENT_WRITABLE_MATURITIES.includes("idea"));
});

test("an agent asking to create accepted work is clamped to a proposal rather than refused", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const created = await executeCommand(db, agent, { action: "create_item", projectId, title: "Definitely do this", maturity: "committed", idempotencyKey: "a6" });
  assert.equal(created.maturity, "proposal", "the item is still recorded; only its standing is honest");
});

test("promoting several items is one event and one revision, and repeats are no-ops", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const ids = [];
  for (const index of [0, 1, 2]) ids.push((await executeCommand(db, agent, { action: "create_item", projectId, title: `Proposal ${index}`, idempotencyKey: `m${index}` })).itemId);

  const before = (await db.prepare("SELECT revision FROM projects WHERE id = ?").bind(projectId).first()).revision;
  const result = await executeCommand(db, browser, { action: "set_maturity", projectId, itemIds: ids, maturity: "accepted", idempotencyKey: "bulk-1" });
  assert.equal(result.changed.length, 3);
  assert.equal((await db.prepare("SELECT revision FROM projects WHERE id = ?").bind(projectId).first()).revision, before + 1, "one aggregate event, one revision");
  assert.equal(Number((await db.prepare("SELECT COUNT(*) AS count FROM work_events WHERE event_type = 'work_item.maturity_changed'").first()).count), 1);

  const versions = await db.prepare("SELECT version FROM work_items WHERE id = ANY(?::text[])").bind(ids).all();
  const again = await executeCommand(db, browser, { action: "set_maturity", projectId, itemIds: ids, maturity: "accepted", idempotencyKey: "bulk-2" });
  assert.equal(again.changed.length, 0, "already-accepted items are not rewritten");
  assert.equal(again.unchanged, 3);
  const after = await db.prepare("SELECT version FROM work_items WHERE id = ANY(?::text[])").bind(ids).all();
  assert.deepEqual(after.results.map((row) => row.version), versions.results.map((row) => row.version), "a no-op must not bump versions and invalidate every agent's expected_version");
});

test("an unknown maturity is rejected rather than stored", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Something", "x1");
  await assert.rejects(
    () => executeCommand(db, browser, { action: "set_maturity", projectId, itemIds: [itemId], maturity: "definitely", idempotencyKey: "bad-1" }),
    (error) => error.code === "VALIDATION_FAILED",
  );
});

// ── Gating ───────────────────────────────────────────────────────────────────────────

test("gating is off by default and can be turned on per project", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  assert.equal((await loadProjectView(db, organizationId, projectId)).project.gateProposals, false);

  await executeCommand(db, browser, { action: "update_project", projectId, gateProposals: true, idempotencyKey: "gate-on" });
  assert.equal((await loadProjectView(db, organizationId, projectId)).project.gateProposals, true);

  await executeCommand(db, browser, { action: "update_project", projectId, gateProposals: false, idempotencyKey: "gate-off" });
  assert.equal((await loadProjectView(db, organizationId, projectId)).project.gateProposals, false);
});

test("turning gating on does not wipe other project settings", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await db.prepare("UPDATE projects SET settings = '{\"somethingElse\":true}' WHERE id = ?").bind(projectId).run();
  await executeCommand(db, browser, { action: "update_project", projectId, gateProposals: true, idempotencyKey: "gate-merge" });
  const settings = JSON.parse((await db.prepare("SELECT settings FROM projects WHERE id = ?").bind(projectId).first()).settings);
  assert.equal(settings.somethingElse, true);
  assert.equal(settings.gateProposals, true);
});

test("with gating on, unaccepted work is not handed to an agent as ready", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const accepted = await readyItem(db, projectId, "Accepted and ready", "g1");
  const unaccepted = await readyItem(db, projectId, "Proposed and ready", "g2");
  await executeCommand(db, browser, { action: "set_maturity", projectId, itemIds: [unaccepted], maturity: "proposal", idempotencyKey: "g-demote" });

  const ungated = await getReadyWork(db, principal, { projectId });
  assert.equal(ungated.workItems.length, 2, "gating off keeps today's behaviour exactly");

  await executeCommand(db, browser, { action: "update_project", projectId, gateProposals: true, idempotencyKey: "g-on" });
  const gated = await getReadyWork(db, principal, { projectId });
  assert.deepEqual(gated.workItems.map((item) => item.id), [accepted]);
});

// ── Resolutions ──────────────────────────────────────────────────────────────────────

test("completing a task resolves it as completed", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Ship the thing", "r1");
  await transition(db, principal, projectId, itemId, "in_progress", "r1-s");
  await transition(db, principal, projectId, itemId, "done", "r1-d");
  const row = await itemById(db, itemId);
  assert.equal(row.resolution, "completed");
});

test("cancelling without a reason records that no reason was recorded, rather than inventing one", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Never explained", "r2");
  await transition(db, principal, projectId, itemId, "cancelled", "r2-c");
  const row = await itemById(db, itemId);
  assert.equal(row.resolution, "unspecified");
  assert.equal(row.resolution_reason, null);
});

test("each way of not being done is distinguishable", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  for (const resolution of ["rejected", "deferred", "superseded", "abandoned", "obsolete"]) {
    const itemId = await createItem(db, projectId, `Ends as ${resolution}`, `r-${resolution}`);
    await transition(db, principal, projectId, itemId, "cancelled", `c-${resolution}`, { resolution, resolutionReason: `because ${resolution}` });
    const row = await itemById(db, itemId);
    assert.equal(row.resolution, resolution);
    assert.equal(row.resolution_reason, `because ${resolution}`);
  }
});

test("a transition reason becomes the resolution reason when none is given separately", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Dropped", "r3");
  await transition(db, principal, projectId, itemId, "cancelled", "r3-c", { resolution: "rejected", reason: "The team chose Postgres instead" });
  assert.equal((await itemById(db, itemId)).resolution_reason, "The team chose Postgres instead");
});

test("reopening a terminal item clears its resolution", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Back in scope", "r4");
  await transition(db, principal, projectId, itemId, "cancelled", "r4-c", { resolution: "deferred", resolutionReason: "next quarter" });
  await transition(db, principal, projectId, itemId, "planned", "r4-p");
  const row = await itemById(db, itemId);
  assert.equal(row.resolution, null);
  assert.equal(row.resolution_reason, null);
});

test("an unknown resolution is rejected rather than stored", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Something", "r5");
  await assert.rejects(
    () => transition(db, principal, projectId, itemId, "cancelled", "r5-c", { resolution: "vibes" }),
    (error) => error.code === "VALIDATION_FAILED",
  );
});

test("merging records the loser as a duplicate, and restoring it clears that", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Add caching to /api/report", "mw");
  const loser = await createItem(db, projectId, "Cache /api/report responses", "ml");
  await executeCommand(db, principal, { action: "merge_items", projectId, winnerItemId: winner, loserItemId: loser, idempotencyKey: "mg" });
  assert.equal((await itemById(db, loser)).resolution, "duplicate");

  const alias = await db.prepare("SELECT id FROM work_item_aliases WHERE archived_work_item_id = ?").bind(loser).first();
  await executeCommand(db, principal, { action: "split_alias", projectId, aliasId: alias.id, idempotencyKey: "sp" });
  assert.equal((await itemById(db, loser)).resolution, null);
});

// ── Deferral ─────────────────────────────────────────────────────────────────────────

test("a deferred item leaves ready work and comes back on its date with nothing having to run", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Later, not never", "d1");

  const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  await transition(db, principal, projectId, itemId, "ready", "d1-defer", { deferredUntil: future });
  assert.equal((await getReadyWork(db, principal, { projectId })).workItems.length, 0);

  // No job, no write: the comparison is against now(), so the deferral simply expires.
  await db.prepare("UPDATE work_items SET deferred_until = now() - interval '1 minute' WHERE id = ?").bind(itemId).run();
  assert.equal((await getReadyWork(db, principal, { projectId })).workItems.length, 1);
});

test("starting deferred work clears the deferral rather than leaving a contradiction", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Actually starting now", "d2");
  await transition(db, principal, projectId, itemId, "ready", "d2-defer", { deferredUntil: new Date(Date.now() + 86400000).toISOString() });
  await transition(db, principal, projectId, itemId, "in_progress", "d2-start");
  assert.equal((await itemById(db, itemId)).deferred_until, null);
});

test("the enum sets are what the rest of the system compares against", () => {
  assert.deepEqual([...MATURITIES], ["idea", "proposal", "accepted", "committed"]);
  assert.ok(RESOLUTIONS.includes("unspecified"), "'nobody recorded why' has to be representable");
  assert.ok(!AGENT_WRITABLE_MATURITIES.includes("accepted"));
  assert.ok(!AGENT_WRITABLE_MATURITIES.includes("committed"));
});
