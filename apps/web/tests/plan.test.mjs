/**
 * Critical-path scheduling for the Plan view. The property that matters is that ordering
 * follows the longest downstream chain (b-level), not the count of immediate children:
 * only the former moves the finish date.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand } from "@/lib/store.ts";
import { getExecutionPlan } from "@/lib/planning/plan.ts";

async function link(db, projectId, fromWorkItemId, toWorkItemId, key) {
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId, toWorkItemId, type: "blocks", idempotencyKey: key });
}

/** A chain root -> a -> b -> c, and separately a root freeing three leaves at once. */
async function deepVersusWide(db, projectId) {
  const deepRoot = await createItem(db, projectId, "Starts a long chain", "deep-root");
  let previous = deepRoot;
  for (let step = 0; step < 3; step += 1) {
    const next = await createItem(db, projectId, `Chain step ${step}`, `chain-${step}`);
    await link(db, projectId, previous, next, `chain-edge-${step}`);
    previous = next;
  }
  const wideRoot = await createItem(db, projectId, "Frees three leaves", "wide-root");
  for (let leaf = 0; leaf < 3; leaf += 1) {
    const id = await createItem(db, projectId, `Leaf ${leaf}`, `leaf-${leaf}`);
    await link(db, projectId, wideRoot, id, `leaf-edge-${leaf}`);
  }
  return { deepRoot, wideRoot };
}

test("ranks the deeper chain first, even though the wider one frees more work immediately", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { deepRoot, wideRoot } = await deepVersusWide(db, projectId);

  const plan = await getExecutionPlan(db, principal, projectId);
  const firstWave = plan.waves[0].items.map((item) => item.id);
  assert.ok(firstWave.includes(deepRoot) && firstWave.includes(wideRoot), "both roots are unblocked, so both are actionable now");
  assert.ok(
    firstWave.indexOf(deepRoot) < firstWave.indexOf(wideRoot),
    "unlock count alone would put the wide root first (3 immediate children vs 1); the chain is what sets the finish date",
  );
});

test("the critical path is exactly the zero-slack chain, and everything else reports real float", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { deepRoot, wideRoot } = await deepVersusWide(db, projectId);

  const plan = await getExecutionPlan(db, principal, projectId);
  assert.equal(plan.criticalPath.length, 4, "root plus three chain steps");
  assert.equal(plan.criticalPath[0].id, deepRoot);

  const steps = plan.waves.flatMap((wave) => wave.items);
  const onPath = new Set(plan.criticalPath.map((entry) => entry.id));
  for (const step of steps) {
    assert.equal(step.critical, onPath.has(step.id), `${step.itemKey} critical flag must match membership of the critical path`);
    assert.equal(step.slack === 0, step.critical, `${step.itemKey} zero slack and critical are the same statement`);
  }
  const wide = steps.find((step) => step.id === wideRoot);
  assert.ok(wide.slack > 0, "the wide root can slip without moving the finish date, which is exactly why it ranks second");
});

test("waves are dependency tiers: an item lands one wave after its latest prerequisite", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const first = await createItem(db, projectId, "First", "w1");
  const second = await createItem(db, projectId, "Second", "w2");
  const third = await createItem(db, projectId, "Third", "w3");
  const alsoFirst = await createItem(db, projectId, "Independent", "w4");
  await link(db, projectId, first, second, "w-e1");
  await link(db, projectId, second, third, "w-e2");

  const plan = await getExecutionPlan(db, principal, projectId);
  const waveOf = new Map(plan.waves.flatMap((wave) => wave.items.map((item) => [item.id, wave.wave])));
  assert.equal(waveOf.get(first), 1);
  assert.equal(waveOf.get(alsoFirst), 1, "nothing blocks it, so it is actionable immediately");
  assert.equal(waveOf.get(second), 2);
  assert.equal(waveOf.get(third), 3);
  assert.equal(plan.stuck.length, 0);
});

test("an asserted block stalls its dependents, and both are reported rather than dropped", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const blocked = await createItem(db, projectId, "Blocked on something external", "s1");
  const downstream = await createItem(db, projectId, "Waits on the blocked item", "s2");
  await link(db, projectId, blocked, downstream, "s-e1");
  // An asserted block is only reachable from 'planned', not straight from 'proposed'.
  for (const [status, reason] of [["planned", undefined], ["blocked", "Waiting on a vendor key"]]) {
    const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(blocked).first();
    await executeCommand(db, principal, { action: "transition_item", projectId, itemId: blocked, expectedVersion: row.version, status, reason, idempotencyKey: `s-${status}` });
  }

  const plan = await getExecutionPlan(db, principal, projectId);
  const stuckIds = plan.stuck.map((item) => item.id);
  assert.ok(stuckIds.includes(blocked), "finishing other tracked work cannot clear an asserted block");
  assert.ok(stuckIds.includes(downstream), "and its dependent stalls with it rather than silently vanishing");
  assert.match(plan.stuck.find((item) => item.id === blocked).reason, /vendor key/, "the recorded reason is surfaced, not replaced by a generic one");
  assert.ok(plan.waves.every((wave) => !wave.items.some((item) => item.id === blocked)));
});

test("done and cancelled work is not scheduled, and stops constraining what follows it", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const finished = await createItem(db, projectId, "Already done", "d1");
  const next = await createItem(db, projectId, "Was waiting on it", "d2");
  await link(db, projectId, finished, next, "d-e1");
  for (const status of ["in_progress", "done"]) {
    const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(finished).first();
    await executeCommand(db, principal, { action: "transition_item", projectId, itemId: finished, expectedVersion: row.version, status, idempotencyKey: `d-${status}` });
  }

  const plan = await getExecutionPlan(db, principal, projectId);
  const ids = plan.waves.flatMap((wave) => wave.items.map((item) => item.id));
  assert.ok(!ids.includes(finished), "finished work is not part of the remaining plan");
  assert.deepEqual(ids, [next], "and the item it used to block is now wave 1");
});
