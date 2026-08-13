/**
 * M12 — why-not-done reasoning.
 *
 * The roadmap names nine distinguishable causes; `explainCause` distinguishes more (every
 * resolution value gets its own cause, not one shared "cancelled"). Every branch of the
 * precedence order is tested directly against the pure function first, then the DB-backed
 * `explainWorkItem` is tested against real multi-hop chains and live leases — the two
 * things a single-item read cannot answer on its own, which is exactly where a first
 * implementation attempt silently truncated the chain at one hop (loadWorkItemDetail's
 * own `dependencies` only carries edges touching the one item directly).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand, organizationFor, registerSourceSession, updateSourceHeartbeat } from "@/lib/store.ts";
import { explainCause, explainWorkItem } from "@/lib/planning/explain.ts";

const browser = { ...principal, authentication: "browser" };

async function transition(db, projectId, itemId, status, key, extra = {}) {
  const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first();
  return executeCommand(db, browser, { action: "transition_item", projectId, itemId, expectedVersion: row.version, status, idempotencyKey: key, ...extra });
}

let counter = 0;
function baseItem(overrides = {}) {
  counter += 1;
  return {
    id: `wi_${counter}`, projectId: "p1", sequence: counter, itemKey: `#${counter}`, type: "task",
    title: "x", description: "", status: "proposed", maturity: "accepted", resolution: null, resolutionReason: null, deferredUntil: null,
    priority: "normal", assignee: null, sourceId: null, codingSpaceId: null,
    completionConfidence: "reported", verificationStatus: "pending", blockerReason: null, statusProvenance: "human_approved",
    blockingCount: 0, unblockedAt: null, version: 1, startedAt: null, completedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides,
  };
}

// ── explainCause: every branch of the precedence order, in isolation ───────────────

test("done with resolution 'completed' -> cause 'completed'", () => {
  const result = explainCause(baseItem({ status: "done", resolution: "completed" }), null, null, null);
  assert.equal(result.cause, "completed");
});

test("cancelled with each recognized resolution maps to its own distinct cause", () => {
  for (const resolution of ["rejected", "deferred", "superseded", "duplicate", "abandoned", "obsolete"]) {
    const result = explainCause(baseItem({ status: "cancelled", resolution, resolutionReason: `because ${resolution}` }), null, null, null);
    assert.equal(result.cause, resolution);
    assert.match(result.summary, new RegExp(`because ${resolution}`));
  }
});

test("cancelled with no resolution recorded at all -> 'unspecified_cancellation', and says so honestly", () => {
  const result = explainCause(baseItem({ status: "cancelled", resolution: null }), null, null, null);
  assert.equal(result.cause, "unspecified_cancellation");
  assert.match(result.summary, /nobody recorded why/);
});

test("resolution takes precedence over everything else — a cancelled item's own blockingCount is irrelevant history", () => {
  const item = baseItem({ status: "cancelled", resolution: "obsolete", blockingCount: 3 });
  const result = explainCause(item, { itemKeys: ["#5"], reason: "waiting on #5" }, { holderLabel: "claude", heartbeatAt: "now" }, null);
  assert.equal(result.cause, "obsolete");
});

test("a deferred, still-open item -> 'deferred_until_date'", () => {
  // Midday UTC so the local-timezone-formatted date can never shift across a day
  // boundary in either direction, regardless of where this test runs.
  const result = explainCause(baseItem({ deferredUntil: "2027-06-15T12:00:00.000Z" }), null, null, null);
  assert.equal(result.cause, "deferred_until_date");
  assert.match(result.summary, /2027/);
});

test("deferral outranks blocking — a deferred item's blockingCount is not why it's paused", () => {
  const item = baseItem({ deferredUntil: "2027-01-01T00:00:00.000Z", blockingCount: 1 });
  const result = explainCause(item, { itemKeys: ["#5"], reason: "waiting on #5" }, null, null);
  assert.equal(result.cause, "deferred_until_date");
});

test("blockingCount > 0 with a real chain -> 'blocked_by_dependency', naming the chain", () => {
  const item = baseItem({ blockingCount: 1 });
  const chain = { itemKeys: ["#4", "#3"], reason: "is waiting on #4, then #3" };
  const result = explainCause(item, chain, null, null);
  assert.equal(result.cause, "blocked_by_dependency");
  assert.deepEqual(result.detail.blockedByChain, ["#4", "#3"]);
  assert.match(result.summary, /#4, then #3/);
});

test("an asserted 'blocked' status outranks nothing above it but is distinct from a dependency block", () => {
  const item = baseItem({ status: "blocked", blockerReason: "waiting on a credential from ops" });
  const result = explainCause(item, null, null, null);
  assert.equal(result.cause, "blocked_externally");
  assert.match(result.summary, /waiting on a credential/);
});

test("in_progress with a live lease -> 'in_progress_active', naming the holder", () => {
  const item = baseItem({ status: "in_progress" });
  const result = explainCause(item, null, { holderLabel: "codex", heartbeatAt: "2026-01-01T00:00:00.000Z" }, null);
  assert.equal(result.cause, "in_progress_active");
  assert.match(result.summary, /codex/);
});

test("in_progress with no live lease -> 'in_progress_unattended', the started-while-blocked-adjacent anomaly generalized", () => {
  const item = baseItem({ status: "in_progress" });
  const result = explainCause(item, null, null, null);
  assert.equal(result.cause, "in_progress_unattended");
});

test("in_review -> 'in_review'", () => {
  const result = explainCause(baseItem({ status: "in_review" }), null, null, null);
  assert.equal(result.cause, "in_review");
});

test("an unaccepted proposal (proposed status, proposal maturity) -> 'not_yet_accepted'", () => {
  const result = explainCause(baseItem({ status: "proposed", maturity: "proposal" }), null, null, null);
  assert.equal(result.cause, "not_yet_accepted");
});

test("an idea (weakest maturity) also reads as 'not_yet_accepted'", () => {
  const result = explainCause(baseItem({ status: "proposed", maturity: "idea" }), null, null, null);
  assert.equal(result.cause, "not_yet_accepted");
});

test("accepted, unblocked, untouched -> 'not_started', the honest default", () => {
  const result = explainCause(baseItem({ status: "proposed", maturity: "accepted" }), null, null, null);
  assert.equal(result.cause, "not_started");
});

test("ready and accepted with nothing blocking is also 'not_started'", () => {
  const result = explainCause(baseItem({ status: "ready", maturity: "committed" }), null, null, null);
  assert.equal(result.cause, "not_started");
});

test("every cause carries the item key in its detail, regardless of branch", () => {
  const item = baseItem({ itemKey: "#42" });
  const result = explainCause(item, null, null, null);
  assert.equal(result.detail.itemKey, "#42");
});

test("the last event's summary and reason are always carried through, when supplied", () => {
  const result = explainCause(baseItem(), null, null, { summary: "moved to blocked", reason: "waiting on ops" });
  assert.equal(result.detail.lastEventSummary, "moved to blocked");
  assert.equal(result.detail.lastEventReason, "waiting on ops");
});

// ── explainWorkItem: the real multi-hop chain bug ───────────────────────────────────

test("a two-hop dependency chain is walked correctly, not truncated at the first hop", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const root = await createItem(db, projectId, "Add the token persistence schema", "root1");
  const middle = await createItem(db, projectId, "Add the token store", "mid1");
  const leaf = await createItem(db, projectId, "Add automatic refresh-token rotation", "leaf1");
  await executeCommand(db, browser, { action: "add_dependency", projectId, fromWorkItemId: root, toWorkItemId: middle, type: "blocks", idempotencyKey: "d1" });
  await executeCommand(db, browser, { action: "add_dependency", projectId, fromWorkItemId: middle, toWorkItemId: leaf, type: "blocks", idempotencyKey: "d2" });

  const result = await explainWorkItem(db, organizationId, leaf);
  assert.equal(result.cause, "blocked_by_dependency");
  // This is the exact case a single-item read (loadWorkItemDetail's own `dependencies`,
  // which only carries edges touching `leaf` directly) cannot answer: the root of the
  // chain is two hops away, not one.
  assert.ok(result.detail.blockedByChain.length >= 1, `expected a real multi-hop chain, got ${JSON.stringify(result.detail.blockedByChain)}`);
  assert.match(result.summary, /waiting on/);
});

test("explainWorkItem resolves to blocked_externally when the graph is clear but an actor asserted a block", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const itemId = await createItem(db, projectId, "Needs a production credential", "cred1");
  await transition(db, projectId, itemId, "planned", "b0");
  await transition(db, projectId, itemId, "blocked", "b1", { reason: "waiting on a secret from ops" });

  const result = await explainWorkItem(db, organizationId, itemId);
  assert.equal(result.cause, "blocked_externally");
  assert.match(result.summary, /waiting on a secret from ops/);
});

test("explainWorkItem finds the real live lease holder for an in-progress item", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const itemId = await createItem(db, projectId, "Add refresh-token rotation", "rot1");
  await transition(db, projectId, itemId, "planned", "p1");
  await transition(db, projectId, itemId, "ready", "p2");
  await transition(db, projectId, itemId, "in_progress", "p3");
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "sess-1" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [itemId] });

  const result = await explainWorkItem(db, organizationId, itemId);
  assert.equal(result.cause, "in_progress_active");
  assert.match(result.summary, /claude/);
});

test("explainWorkItem reports in_progress_unattended once the lease expires", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const itemId = await createItem(db, projectId, "Add refresh-token rotation", "rot2");
  await transition(db, projectId, itemId, "planned", "p4");
  await transition(db, projectId, itemId, "ready", "p5");
  await transition(db, projectId, itemId, "in_progress", "p6");
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "sess-2" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [itemId] });
  await db.prepare("UPDATE work_claims SET lease_expires_at = now() - interval '1 minute' WHERE work_item_id = ?").bind(itemId).run();

  const result = await explainWorkItem(db, organizationId, itemId);
  assert.equal(result.cause, "in_progress_unattended");
});

test("explainWorkItem reads a real resolution and reason recorded through the normal transition path", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const itemId = await createItem(db, projectId, "Use a shared HS256 secret", "hs256");
  await transition(db, projectId, itemId, "cancelled", "c1", { resolution: "rejected", resolutionReason: "breaks service isolation" });

  const result = await explainWorkItem(db, organizationId, itemId);
  assert.equal(result.cause, "rejected");
  assert.match(result.summary, /breaks service isolation/);
});

test("explainWorkItem defaults to not_started for freshly accepted, untouched work", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const itemId = await createItem(db, projectId, "Something nobody has touched", "fresh1");
  await executeCommand(db, browser, { action: "set_maturity", projectId, itemIds: [itemId], maturity: "accepted", idempotencyKey: "sm1" });

  const result = await explainWorkItem(db, organizationId, itemId);
  assert.equal(result.cause, "not_started");
});

test("explainWorkItem never crosses a project boundary for its chain lookup", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, principal, { action: "create_project", name: "Other", idempotencyKey: "ewi-p2" })).projectId;
  const organizationId = await organizationFor(db, principal);
  const itemA = (await executeCommand(db, browser, { action: "create_item", projectId: projectA, title: "In project A", idempotencyKey: "ewi-a1" })).itemId;
  await createItem(db, projectB, "In project B, unrelated", "b1");

  const result = await explainWorkItem(db, organizationId, itemA);
  assert.equal(result.cause, "not_started");
});
