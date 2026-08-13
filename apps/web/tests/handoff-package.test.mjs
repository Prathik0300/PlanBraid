/**
 * M13 — agent handoff packages.
 *
 * The one genuinely new idea beyond M11's bucketing is "Do NOT redo": a completion claim
 * is only trustworthy once M9's confidence derivation says so, so these tests are built
 * around the exact split — verified work goes in the "must not redo" section, an
 * unverified claim goes in its own, separately labelled section, and the two must never
 * be conflated, because a handoff is precisely the moment an unverified claim is most
 * likely to be trusted as fact by whoever reads it next.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand, registerSourceSession, updateSourceHeartbeat } from "@/lib/store.ts";
import { getHandoffPackage } from "@/lib/planning/handoff.ts";

const browser = { ...principal, authentication: "browser" };

async function transition(db, projectId, itemId, status, key, extra = {}) {
  const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first();
  return executeCommand(db, browser, { action: "transition_item", projectId, itemId, expectedVersion: row.version, status, idempotencyKey: key, ...extra });
}

async function readyItem(db, projectId, title, key) {
  const created = await executeCommand(db, browser, { action: "create_item", projectId, title, idempotencyKey: `item-${key}` });
  await transition(db, projectId, created.itemId, "planned", `${key}-p`);
  await transition(db, projectId, created.itemId, "ready", `${key}-r`);
  return created.itemId;
}

test("a done item with verified evidence lands in verifiedComplete, not unverifiedComplete", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Migrate JWT signing to RS256", "rs1");
  await transition(db, projectId, itemId, "in_progress", "s1");
  await executeCommand(db, browser, { action: "add_evidence", projectId, itemId, type: "pr", label: "PR #4", result: "verified", idempotencyKey: "ev1" });
  await transition(db, projectId, itemId, "done", "d1");

  const handoff = await getHandoffPackage(db, browser, projectId);
  assert.equal(handoff.verifiedComplete.length, 1);
  assert.equal(handoff.verifiedComplete[0].itemKey, "#1");
  assert.deepEqual(handoff.unverifiedComplete, []);
  assert.match(handoff.text, /Do NOT redo/);
  assert.match(handoff.text, /#1/);
});

test("a done item with no evidence at all lands in unverifiedComplete, and the text warns about it", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Add rate limiting", "rl1");
  await transition(db, projectId, itemId, "in_progress", "s2");
  await transition(db, projectId, itemId, "done", "d2");

  const handoff = await getHandoffPackage(db, browser, projectId);
  assert.deepEqual(handoff.verifiedComplete, []);
  assert.equal(handoff.unverifiedComplete.length, 1);
  assert.match(handoff.text, /Claimed complete, unverified/);
});

test("an unverified claim never appears in the verifiedComplete section — the exact conflation this feature exists to prevent", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Ship without proof", "sp1");
  await transition(db, projectId, itemId, "in_progress", "s3");
  await transition(db, projectId, itemId, "done", "d3");

  const handoff = await getHandoffPackage(db, browser, projectId);
  const verifiedSection = handoff.text.split("Claimed complete")[0];
  assert.ok(!verifiedSection.includes("#1"), "an unverified item must not appear ahead of the unverified-claims heading in the text form");
});

test("active work names the live lease holder", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Add refresh-token rotation", "rot1");
  await transition(db, projectId, itemId, "in_progress", "s4");
  const source = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "sess-1" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [itemId] });

  const handoff = await getHandoffPackage(db, browser, projectId);
  assert.equal(handoff.active.length, 1);
  assert.match(handoff.active[0].note, /codex/);
});

test("active work with no live lease says so honestly rather than guessing a holder", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Add refresh-token rotation", "rot2");
  await transition(db, projectId, itemId, "in_progress", "s5");

  const handoff = await getHandoffPackage(db, browser, projectId);
  assert.equal(handoff.active.length, 1);
  assert.match(handoff.active[0].note, /no active session/);
});

test("blocked work carries the chain, reusing Simplify's own pass", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const blocker = await createItem(db, projectId, "Add the schema", "sch1");
  const blocked = await createItem(db, projectId, "Add rotation", "rot3");
  await executeCommand(db, browser, { action: "add_dependency", projectId, fromWorkItemId: blocker, toWorkItemId: blocked, type: "blocks", idempotencyKey: "dep1" });

  const handoff = await getHandoffPackage(db, browser, projectId);
  assert.equal(handoff.blocked.length, 1);
  assert.equal(handoff.blocked[0].workItemId, blocked);
});

test("recently rejected approaches carry their reason", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Share one HS256 secret", "hs1");
  await transition(db, projectId, itemId, "cancelled", "c1", { resolution: "rejected", resolutionReason: "breaks service isolation" });

  const handoff = await getHandoffPackage(db, browser, projectId);
  assert.equal(handoff.recentlyRejected.length, 1);
  assert.equal(handoff.recentlyRejected[0].note, "breaks service isolation");
  assert.match(handoff.text, /breaks service isolation/);
});

test("next actions agree with get_ready_work rather than a second, drifting ranking", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const freesTwo = await readyItem(db, projectId, "Unlocks two other tasks", "f2");
  const freesNone = await readyItem(db, projectId, "Unlocks nothing", "f0");
  for (const suffix of ["a", "b"]) {
    const dependent = await createItem(db, projectId, `Depends on freesTwo ${suffix}`, `dep-${suffix}`);
    await executeCommand(db, browser, { action: "add_dependency", projectId, fromWorkItemId: freesTwo, toWorkItemId: dependent, type: "blocks", idempotencyKey: `nl-${suffix}` });
  }

  const handoff = await getHandoffPackage(db, browser, projectId);
  assert.equal(handoff.nextActions[0].workItemId, freesTwo);
  assert.ok(handoff.nextActions.some((entry) => entry.workItemId === freesNone));
});

test("a project with nothing at all still produces a coherent, non-crashing package", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const handoff = await getHandoffPackage(db, browser, projectId);
  assert.deepEqual(handoff.verifiedComplete, []);
  assert.match(handoff.text, /Nothing verified yet/);
  assert.match(handoff.text, /Nothing in progress/);
  assert.match(handoff.text, /Nothing blocked/);
  assert.match(handoff.text, /Nothing ready to start/);
});

test("the text form includes the project name and is stable in section order", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const handoff = await getHandoffPackage(db, browser, projectId);
  assert.match(handoff.text, /^PROJECT HANDOFF/);
  assert.ok(handoff.text.includes("Graph Project"), `expected the project name in the text, got: ${handoff.text.slice(0, 80)}`);
  const doNotRedoIndex = handoff.text.indexOf("Do NOT redo");
  const activeIndex = handoff.text.indexOf("Currently active");
  const nextActionsIndex = handoff.text.indexOf("Recommended next actions");
  assert.ok(doNotRedoIndex < activeIndex && activeIndex < nextActionsIndex, "sections must appear in a stable, predictable order");
});

test("work from a different project never appears in the handoff", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, browser, { action: "create_project", name: "Other", idempotencyKey: "hp-p2" })).projectId;
  await createItem(db, projectB, "In project B", "b1");

  const handoff = await getHandoffPackage(db, browser, projectA);
  assert.ok(!handoff.text.includes("In project B"));
});

test("each section is capped so the package stays a briefing, not a full project dump", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  for (let index = 0; index < 15; index += 1) {
    const itemId = await readyItem(db, projectId, `Task ${index}`, `cap${index}`);
    await transition(db, projectId, itemId, "in_progress", `cap-s${index}`);
    await transition(db, projectId, itemId, "done", `cap-d${index}`);
  }
  const handoff = await getHandoffPackage(db, browser, projectId);
  assert.ok(handoff.unverifiedComplete.length <= 10, `expected the section capped, got ${handoff.unverifiedComplete.length}`);
});
