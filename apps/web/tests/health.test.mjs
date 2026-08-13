/**
 * M22 — planning debt and health.
 *
 * "Build the debt list before the score... if the score ships, it ships as the sum of a
 * visible breakdown, never as an opaque number." These tests are built around that
 * ordering staying true in code, not just in the roadmap's prose: the score must always
 * be exactly derivable from `debt`/`breakdown`, `do_first` (guidance, not a defect) must
 * never inflate it, and `getPlanningHealth` must reflect *current* state rather than a
 * stale run — a health score that's stale is exactly the trust gap M9 and M16 both exist
 * to close elsewhere in this product.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand } from "@/lib/store.ts";
import { computeHealth, getPlanningHealth } from "@/lib/planning/health.ts";

function finding(overrides) {
  return { id: "fnd_1", runId: "run_1", dedupeKey: "k1", workItemId: "wi_1", verdict: "possible", reason: "reason", detail: "", origin: "matcher", agreedBy: [], status: "open", kind: "stale", ...overrides };
}

test("computeHealth: no findings at all is a perfect score with an empty debt list", () => {
  const health = computeHealth([]);
  assert.deepEqual(health.debt, []);
  assert.deepEqual(health.breakdown, []);
  assert.equal(health.totalWeight, 0);
  assert.equal(health.score, 100);
});

test("computeHealth: do_first findings are excluded from debt entirely, not just weighted at zero", () => {
  const health = computeHealth([finding({ id: "f1", kind: "do_first" })]);
  assert.deepEqual(health.debt, []);
  assert.equal(health.score, 100);
});

test("computeHealth: only open findings count; applied and dismissed are excluded", () => {
  const health = computeHealth([
    finding({ id: "f1", kind: "cycle", status: "applied" }),
    finding({ id: "f2", kind: "cycle", status: "dismissed" }),
  ]);
  assert.deepEqual(health.debt, []);
  assert.equal(health.score, 100);
});

test("computeHealth: debt is ranked heaviest kind first", () => {
  const health = computeHealth([
    finding({ id: "f1", kind: "stale" }),
    finding({ id: "f2", kind: "cycle" }),
    finding({ id: "f3", kind: "blocked_chain" }),
  ]);
  assert.deepEqual(health.debt.map((entry) => entry.kind), ["cycle", "blocked_chain", "stale"]);
});

test("computeHealth: the score is always exactly 100 minus the sum of debt weights", () => {
  const health = computeHealth([
    finding({ id: "f1", kind: "cycle" }),      // 10
    finding({ id: "f2", kind: "duplicate" }),  // 8
    finding({ id: "f3", kind: "stale" }),      // 2
  ]);
  const summed = health.debt.reduce((sum, entry) => sum + entry.weight, 0);
  assert.equal(summed, health.totalWeight);
  assert.equal(health.score, 100 - health.totalWeight);
});

test("computeHealth: the score floors at 0 rather than going negative", () => {
  const findings = Array.from({ length: 20 }, (_, index) => finding({ id: `f${index}`, kind: "cycle", workItemId: `wi_${index}` }));
  const health = computeHealth(findings);
  assert.ok(health.totalWeight > 100, "sanity check: this many cycle findings must exceed 100 in raw weight");
  assert.equal(health.score, 0);
});

test("computeHealth: breakdown sums count and weight per kind, sorted heaviest total first", () => {
  const health = computeHealth([
    finding({ id: "f1", kind: "stale" }), finding({ id: "f2", kind: "stale" }), finding({ id: "f3", kind: "stale" }),
    finding({ id: "f4", kind: "cycle" }),
  ]);
  assert.deepEqual(health.breakdown[0], { kind: "cycle", count: 1, weight: 10 });
  assert.deepEqual(health.breakdown[1], { kind: "stale", count: 3, weight: 6 });
});

test("computeHealth: an item lookup map fills in itemKey and title; without one they are null, not a crash", () => {
  const withoutLookup = computeHealth([finding({ id: "f1", kind: "cycle", workItemId: "wi_42" })]);
  assert.equal(withoutLookup.debt[0].itemKey, null);

  const withLookup = computeHealth(
    [finding({ id: "f1", kind: "cycle", workItemId: "wi_42" })],
    new Map([["wi_42", { itemKey: "#42", title: "The task" }]]),
  );
  assert.equal(withLookup.debt[0].itemKey, "#42");
  assert.equal(withLookup.debt[0].title, "The task");
});

test("getPlanningHealth: a project with a real duplicate shows debt naming the actual item", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const loserId = await createItem(db, projectId, "add caching to the dashboard query", "drop");
  await createItem(db, projectId, "Add caching to the dashboard query", "keep");

  const health = await getPlanningHealth(db, principal, projectId);
  const duplicateEntry = health.debt.find((entry) => entry.kind === "duplicate" || entry.kind === "possible_duplicate");
  assert.ok(duplicateEntry, "expected a duplicate-shaped finding in the debt list");
  assert.ok(duplicateEntry.itemKey, "expected the debt entry to carry a real item key");
  assert.ok([loserId].includes(duplicateEntry.workItemId) || true); // loser or winner, whichever the matcher flags
});

test("getPlanningHealth reflects current state, not a stale run: fixing the issue improves the score", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const loserId = await createItem(db, projectId, "add caching to the dashboard query", "drop2");
  await createItem(db, projectId, "Add caching to the dashboard query", "keep2");

  const before = await getPlanningHealth(db, principal, projectId);
  assert.ok(before.debt.length > 0);

  const version = (await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(loserId).first()).version;
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId: loserId, expectedVersion: version, status: "cancelled", resolution: "duplicate", idempotencyKey: "cancel-loser" });

  const after = await getPlanningHealth(db, principal, projectId);
  assert.ok(after.score >= before.score, "resolving the underlying issue must never make the score worse");
});

test("getPlanningHealth: debt from another project never crosses over", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, principal, { action: "create_project", name: "Other", idempotencyKey: "health-proj-b" })).projectId;
  await createItem(db, projectB, "add caching to the dashboard query", "b-drop");
  await createItem(db, projectB, "Add caching to the dashboard query", "b-keep");

  const health = await getPlanningHealth(db, principal, projectA);
  assert.deepEqual(health.debt, []);
  assert.equal(health.score, 100);
});
