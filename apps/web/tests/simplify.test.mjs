/**
 * Simplify: the review pass over a project's todos.
 *
 * Two things are being protected here. One is that the pass finds what it should. The
 * other, and the reason the assertions lean negative, is that it must not collapse work
 * that only looks similar - a wrong merge archives something a person typed, so the
 * vetoes that make automatic matching safe have to survive this new caller too.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand, getReadyWork, loadDashboard } from "@/lib/store.ts";
import { analyzeProject, findBlockedChains, findCycles, findDuplicates } from "@/lib/simplify/analyze.ts";
import { applySimplificationFinding, createSimplificationRun, dismissSimplificationFinding, readSimplificationRun } from "@/lib/simplify/runs.ts";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";

let counter = 0;
/** A work item shaped like the dashboard's, for the pure-function tests. */
function item(over = {}) {
  counter += 1;
  return {
    id: `wi_${counter}`, projectId: "p1", sequence: counter, itemKey: `#${counter}`, parentId: null, type: "task",
    title: "", description: "", status: "proposed", priority: "normal", assignee: null, sourceId: null,
    codingSpaceId: null, completionConfidence: "reported", verificationStatus: "pending", blockerReason: null,
    blockingCount: 0, unblockedAt: null, version: 1, startedAt: null, completedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
  };
}
function edge(from, to, type = "blocks") {
  return { id: `d_${from}_${to}`, fromWorkItemId: from, toWorkItemId: to, type, reason: "" };
}

async function openItems(db, projectId) {
  return (await loadDashboard(db, principal)).workItems.filter((entry) => entry.projectId === projectId);
}

test("the same task typed twice is one duplicate finding, oldest kept", () => {
  const first = item({ title: "Add caching to the dashboard query" });
  const second = item({ title: "add caching to the dashboard query" });
  const findings = findDuplicates([second, first]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "duplicate");
  assert.equal(findings[0].verdict, "certain");
  // Order of the input must not decide the survivor: the earlier sequence wins, because
  // that is the one history and dependencies already point at.
  assert.equal(findings[0].relatedWorkItemId, first.id);
  assert.equal(findings[0].workItemId, second.id);
  assert.equal(findings[0].proposedCommand.action, "merge_items");
});

test("similar wording about different things is left alone", () => {
  // The artifact veto. This is the single rule that makes merging safe to offer, so it
  // is asserted here as well as in the dedup tests.
  assert.equal(findDuplicates([item({ title: "Rate limit /api/login" }), item({ title: "Rate limit /api/signup" })]).length, 0);
  // Opposite intent on the same subject.
  assert.equal(findDuplicates([item({ title: "Add the export endpoint" }), item({ title: "Remove the export endpoint" })]).length, 0);
  // Same subject, genuinely different work.
  assert.equal(findDuplicates([item({ title: "Add rate limiting" }), item({ title: "Test rate limiting" })]).length, 0);
});

test("a three-way pile-up merges into one survivor, never into an item being archived", () => {
  const a = item({ title: "Write onboarding docs" });
  const b = item({ title: "write onboarding docs" });
  const c = item({ title: "Write  onboarding  docs" });
  const findings = findDuplicates([a, b, c]).filter((finding) => finding.verdict === "certain");

  assert.equal(findings.length, 2);
  assert.deepEqual([...new Set(findings.map((finding) => finding.relatedWorkItemId))], [a.id],
    "applying every finding must leave one item, so they all have to target the same winner");
});

test("a blocked item names every hop it is waiting on", () => {
  const root = item({ title: "Run the migration" });
  const middle = item({ title: "Deploy the service", blockingCount: 1 });
  const leaf = item({ title: "Announce the release", blockingCount: 1 });
  const findings = findBlockedChains([root, middle, leaf], [edge(root.id, middle.id), edge(middle.id, leaf.id)]);

  const chain = findings.find((finding) => finding.workItemId === leaf.id);
  assert.equal(chain.reason, `${leaf.itemKey} is waiting on ${middle.itemKey}, then ${root.itemKey}`);
  assert.match(chain.detail, new RegExp(`Start with ${root.itemKey}`));
  // Informational: there is no safe automatic fix for "this is blocked".
  assert.equal(chain.proposedCommand, undefined);
});

test("a stale blocking_count with no surviving edge reports nothing", () => {
  // Guards against the panel inventing a chain for an item whose blocker was resolved
  // or merged away, which would read as a bug in the board.
  assert.equal(findBlockedChains([item({ blockingCount: 1, title: "Orphaned" })], []).length, 0);
});

test("a dependency cycle is reported once, and annotation edges are not cycles", () => {
  const a = item({ title: "A", blockingCount: 1 });
  const b = item({ title: "B", blockingCount: 1 });
  const c = item({ title: "C", blockingCount: 1 });
  const cycles = findCycles([a, b, c], [edge(b.id, a.id), edge(c.id, b.id), edge(a.id, c.id)]);
  assert.equal(cycles.length, 1, "one cycle, not one per entry point");
  assert.match(cycles[0].detail, /Remove one of these dependencies/);

  // "A relates_to B" and "B relates_to A" are two true facts, not a cycle. See
  // lib/graph/edges.ts - every traversal has to filter on the DAG edge types.
  const d = item({ title: "D" });
  const e = item({ title: "E" });
  assert.equal(findCycles([d, e], [edge(d.id, e.id, "relates_to"), edge(e.id, d.id, "relates_to")]).length, 0);
});

test("open work repeating a finished task is reported, not merged into it", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const doneId = await createItem(db, projectId, "Add caching to the dashboard query", "done-one");
  const record = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(doneId).first();
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId: doneId, expectedVersion: record.version, status: "ready", idempotencyKey: "r" });
  const ready = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(doneId).first();
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId: doneId, expectedVersion: ready.version, status: "in_progress", idempotencyKey: "p" });
  const started = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(doneId).first();
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId: doneId, expectedVersion: started.version, status: "done", idempotencyKey: "d" });
  await createItem(db, projectId, "add caching to the dashboard query", "open-one");

  const run = await createSimplificationRun(db, principal, { projectId });
  const finding = run.findings.find((entry) => entry.kind === "redundant_done");
  assert.ok(finding, "repeating finished work is worth surfacing");
  // Cancelling, not merging: new work does not belong filed under a closed task, and
  // reopening the old one is a different decision than collapsing a duplicate.
  assert.equal(finding.proposedCommand.action, "transition_item");
  assert.equal(finding.proposedCommand.status, "cancelled");
});

test("applying a merge archives the loser, keeps one item, and stays reversible", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Add caching to the dashboard query", "keep");
  await createItem(db, projectId, "add caching to the dashboard query", "drop");

  const run = await createSimplificationRun(db, principal, { projectId });
  const duplicate = run.findings.find((entry) => entry.kind === "duplicate");
  assert.ok(duplicate);

  await applySimplificationFinding(db, principal, { findingId: duplicate.id });
  const afterMerge = await openItems(db, projectId);
  assert.equal(afterMerge.length, 1, "the archived item leaves the board");
  assert.equal(afterMerge[0].itemKey, "#1");

  const state = await loadDashboard(db, principal);
  const alias = state.aliases.find((entry) => entry.workItemId === afterMerge[0].id);
  assert.ok(alias, "the merged wording survives as an alias rather than being deleted");
  assert.equal(alias.matchMethod, "merge");

  // Undo restores the original item and its key, so history that references #2 still
  // resolves instead of pointing at a renumbered copy.
  const restored = await executeCommand(db, principal, { action: "split_alias", projectId, aliasId: alias.id, idempotencyKey: "undo" });
  assert.equal(restored.itemKey, "#2");
  assert.equal((await openItems(db, projectId)).length, 2);

  const reread = await readSimplificationRun(db, principal, { projectId });
  assert.equal(reread.findings.find((entry) => entry.id === duplicate.id).status, "applied");
});

test("merging refuses work somebody already started", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Add caching to the dashboard query", "w");
  const loser = await createItem(db, projectId, "add caching to the dashboard query", "l");
  const record = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(loser).first();
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId: loser, expectedVersion: record.version, status: "ready", idempotencyKey: "r" });
  const ready = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(loser).first();
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId: loser, expectedVersion: ready.version, status: "in_progress", idempotencyKey: "p" });

  // Collapsing it would hide real progress behind another task's status.
  await assert.rejects(
    () => executeCommand(db, principal, { action: "merge_items", projectId, winnerItemId: winner, loserItemId: loser, idempotencyKey: "m" }),
    (error) => error.code === "VALIDATION_FAILED",
  );
  assert.equal((await openItems(db, projectId)).length, 2);
});

test("a merge moves the loser's dependencies instead of stranding them", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Add caching to the dashboard query", "w");
  const loser = await createItem(db, projectId, "add caching to the dashboard query", "l");
  const dependent = await createItem(db, projectId, "Ship the release notes", "d");
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: loser, toWorkItemId: dependent, type: "blocks", idempotencyKey: "dep" });

  const blockedBefore = (await openItems(db, projectId)).find((entry) => entry.id === dependent);
  assert.equal(blockedBefore.blockingCount, 1);

  await executeCommand(db, principal, { action: "merge_items", projectId, winnerItemId: winner, loserItemId: loser, idempotencyKey: "m" });

  const after = await openItems(db, projectId);
  const blockedAfter = after.find((entry) => entry.id === dependent);
  // Still blocked, but by the surviving task. Archiving the blocker without moving the
  // edge would leave this waiting on a ghost forever.
  assert.equal(blockedAfter.blockingCount, 1);
  const edges = (await loadDashboard(db, principal)).dependencies.filter((entry) => entry.toWorkItemId === dependent);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].fromWorkItemId, winner);
});

test("do-first findings agree with get_ready_work rather than ranking separately", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const blocker = await createItem(db, projectId, "Run the migration", "blocker");
  const dependent = await createItem(db, projectId, "Deploy the service", "dependent");
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: blocker, toWorkItemId: dependent, type: "blocks", idempotencyKey: "dep" });
  const record = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(blocker).first();
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId: blocker, expectedVersion: record.version, status: "ready", idempotencyKey: "ready" });

  const run = await createSimplificationRun(db, principal, { projectId });
  const doFirst = run.findings.filter((entry) => entry.kind === "do_first");
  const ranked = await getReadyWork(db, principal, { projectId, avoidCollisions: false });
  const unlocking = ranked.workItems.filter((entry) => entry.unlockCount > 0).map((entry) => entry.id);
  assert.deepEqual(doFirst.map((entry) => entry.workItemId), unlocking);
});

test("informational findings cannot be applied, and dismissing hides one", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const blocker = await createItem(db, projectId, "Run the migration", "b");
  const dependent = await createItem(db, projectId, "Deploy the service", "d");
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: blocker, toWorkItemId: dependent, type: "blocks", idempotencyKey: "dep" });

  const run = await createSimplificationRun(db, principal, { projectId });
  const chain = run.findings.find((entry) => entry.kind === "blocked_chain");
  assert.ok(chain);
  await assert.rejects(
    () => applySimplificationFinding(db, principal, { findingId: chain.id }),
    (error) => error.code === "VALIDATION_FAILED",
  );

  await dismissSimplificationFinding(db, principal, { findingId: chain.id });
  const reread = await readSimplificationRun(db, principal, { projectId });
  assert.equal(reread.findings.find((entry) => entry.id === chain.id).status, "dismissed");
});

test("a clean project produces nothing to do", () => {
  const findings = analyzeProject({
    items: [item({ title: "Add rate limiting to /api/login" }), item({ title: "Document the deploy runbook" })],
    dependencies: [],
  });
  assert.deepEqual(findings, []);
});
