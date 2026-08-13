/**
 * M19 — decisions and conflicts.
 *
 * The one rule this feature exists to enforce: raising a conflict is cheap and open to
 * anyone, agent or person, but closing one is a human-only act with a permanent
 * consequence — the losing side's work item is cancelled as superseded, which is exactly
 * what later makes get_planning_context's rejected bucket refuse to let it come back as
 * a "new" proposal. These tests are built around that asymmetry and around the two
 * idempotency gaps that don't come for free from executeCommand alone: recordDecision's
 * option rows aren't behind its own idempotency record, and resolveDecision's second call
 * has to look like a replay, not an error, when it repeats the same winner.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand, organizationFor } from "@/lib/store.ts";
import { getPlanningContext } from "@/lib/planning/context.ts";
import { recordDecision, resolveDecision, listOpenDecisions } from "@/lib/planning/decisions.ts";

const browser = { ...principal, authentication: "browser" };
const agent = { ...principal, authentication: "personal_token" };

async function twoOptionDecision(db, projectId, principalToUse, key, extra = {}) {
  const optionA = await createItem(db, projectId, "REST for the public API", `${key}-a`);
  const optionB = await createItem(db, projectId, "GraphQL for the public API", `${key}-b`);
  const decision = await recordDecision(db, principalToUse, {
    projectId, question: "REST or GraphQL for the public API?",
    options: [{ label: "REST", relatedWorkItemId: optionA }, { label: "GraphQL", relatedWorkItemId: optionB }],
    idempotencyKey: key, ...extra,
  });
  return { decision, optionA, optionB };
}

test("recordDecision creates a type='decision' work item and both options", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision } = await twoOptionDecision(db, projectId, agent, "dec1");

  assert.equal(decision.question, "REST or GraphQL for the public API?");
  assert.equal(decision.options.length, 2);
  assert.deepEqual(decision.options.map((option) => option.label).sort(), ["GraphQL", "REST"]);
  assert.ok(decision.options.every((option) => option.status === "open"));

  const row = await db.prepare("SELECT type FROM work_items WHERE id = ?").bind(decision.workItemId).first();
  assert.equal(row.type, "decision");
});

test("an agent may raise a decision, but create_item's existing clamp still holds it to a proposal", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision } = await twoOptionDecision(db, projectId, agent, "dec2");
  const row = await db.prepare("SELECT maturity FROM work_items WHERE id = ?").bind(decision.workItemId).first();
  assert.equal(row.maturity, "proposal");
});

test("a person raising a decision gets it at full standing immediately", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision } = await twoOptionDecision(db, projectId, browser, "dec3");
  const row = await db.prepare("SELECT maturity FROM work_items WHERE id = ?").bind(decision.workItemId).first();
  assert.equal(row.maturity, "accepted");
});

test("a decision needs at least two options", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await assert.rejects(
    recordDecision(db, agent, { projectId, question: "Only one way?", options: [{ label: "The only way" }], idempotencyKey: "one-opt" }),
    /at least two options/,
  );
});

test("blank-label options are dropped before the minimum-two check, so two real plus one blank still fails", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await assert.rejects(
    recordDecision(db, agent, { projectId, question: "?", options: [{ label: "Real" }, { label: "   " }], idempotencyKey: "blank-opt" }),
    /at least two options/,
  );
});

test("options with a related_work_item_id get a conflicts_with edge from the decision to that item", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision, optionA, optionB } = await twoOptionDecision(db, projectId, agent, "dec4");

  const edges = await db.prepare("SELECT from_work_item_id, to_work_item_id, type FROM dependencies WHERE project_id = ? AND type = 'conflicts_with'").bind(projectId).all();
  const targets = edges.results.map((row) => row.to_work_item_id).sort();
  assert.deepEqual(targets, [optionA, optionB].sort());
  assert.ok(edges.results.every((row) => row.from_work_item_id === decision.workItemId));
});

test("an option with no related_work_item_id writes no edge, and recordDecision does not crash on it", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const decision = await recordDecision(db, agent, {
    projectId, question: "Naming scheme?", options: [{ label: "snake_case" }, { label: "camelCase" }], idempotencyKey: "dec5",
  });
  assert.equal(decision.options.length, 2);
  const edges = await db.prepare("SELECT id FROM dependencies WHERE project_id = ? AND type = 'conflicts_with'").bind(projectId).all();
  assert.equal(edges.results.length, 0);
});

test("recordDecision replayed with the same idempotency key does not duplicate options or edges", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const optionA = await createItem(db, projectId, "REST", "dup-a");
  const optionB = await createItem(db, projectId, "GraphQL", "dup-b");
  const input = { projectId, question: "REST or GraphQL?", options: [{ label: "REST", relatedWorkItemId: optionA }, { label: "GraphQL", relatedWorkItemId: optionB }], idempotencyKey: "dup-dec" };

  const first = await recordDecision(db, agent, input);
  const second = await recordDecision(db, agent, input);
  assert.equal(first.workItemId, second.workItemId);

  const optionRows = await db.prepare("SELECT id FROM decision_options WHERE decision_work_item_id = ?").bind(first.workItemId).all();
  assert.equal(optionRows.results.length, 2, "a retried recordDecision must not insert a second copy of each option");
  const edgeRows = await db.prepare("SELECT id FROM dependencies WHERE from_work_item_id = ? AND type = 'conflicts_with'").bind(first.workItemId).all();
  assert.equal(edgeRows.results.length, 2, "a retried recordDecision must not insert a second copy of each conflicts_with edge");
});

test("resolveDecision rejects a non-browser (agent) principal with AUTHORITY_REQUIRED", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision } = await twoOptionDecision(db, projectId, agent, "dec6");
  await assert.rejects(
    resolveDecision(db, agent, { projectId, decisionWorkItemId: decision.workItemId, winningOptionId: decision.options[0].id }),
    (error) => { assert.equal(error.code, "AUTHORITY_REQUIRED"); assert.equal(error.status, 403); return true; },
  );
});

test("resolveDecision sets the winning option accepted and every other option rejected", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision } = await twoOptionDecision(db, projectId, browser, "dec7");
  const winner = decision.options.find((option) => option.label === "REST");

  const resolved = await resolveDecision(db, browser, { projectId, decisionWorkItemId: decision.workItemId, winningOptionId: winner.id });
  const resolvedWinner = resolved.options.find((option) => option.id === winner.id);
  const loser = resolved.options.find((option) => option.id !== winner.id);
  assert.equal(resolvedWinner.status, "accepted");
  assert.equal(loser.status, "rejected");
});

test("resolveDecision cancels the losing option's related item as superseded", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision, optionA, optionB } = await twoOptionDecision(db, projectId, browser, "dec8");
  const winner = decision.options.find((option) => option.label === "REST");

  await resolveDecision(db, browser, { projectId, decisionWorkItemId: decision.workItemId, winningOptionId: winner.id, resolutionReason: "team already knows REST" });

  const winnerItemRow = await db.prepare("SELECT status FROM work_items WHERE id = ?").bind(optionA).first();
  assert.equal(winnerItemRow.status, "proposed", "the winning option's related item is left alone, not force-transitioned");

  const loserItemRow = await db.prepare("SELECT status, resolution, resolution_reason FROM work_items WHERE id = ?").bind(optionB).first();
  assert.equal(loserItemRow.status, "cancelled");
  assert.equal(loserItemRow.resolution, "superseded");
  assert.match(loserItemRow.resolution_reason, /team already knows REST/);
});

test("resolveDecision writes a supersedes edge from the decision to the losing related item", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision, optionB } = await twoOptionDecision(db, projectId, browser, "dec9");
  const winner = decision.options.find((option) => option.label === "REST");

  await resolveDecision(db, browser, { projectId, decisionWorkItemId: decision.workItemId, winningOptionId: winner.id });

  const edge = await db.prepare("SELECT from_work_item_id, to_work_item_id FROM dependencies WHERE project_id = ? AND type = 'supersedes'").bind(projectId).first();
  assert.ok(edge, "expected a supersedes edge");
  assert.equal(edge.from_work_item_id, decision.workItemId);
  assert.equal(edge.to_work_item_id, optionB);
});

test("resolveDecision closes the decision item itself as done/completed", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision } = await twoOptionDecision(db, projectId, browser, "dec10");
  const winner = decision.options.find((option) => option.label === "REST");

  await resolveDecision(db, browser, { projectId, decisionWorkItemId: decision.workItemId, winningOptionId: winner.id });

  const row = await db.prepare("SELECT status, resolution FROM work_items WHERE id = ?").bind(decision.workItemId).first();
  assert.equal(row.status, "done");
  assert.equal(row.resolution, "completed");
});

test("resolving twice with the same winner replays instead of erroring", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision } = await twoOptionDecision(db, projectId, browser, "dec11");
  const winner = decision.options.find((option) => option.label === "REST");

  const first = await resolveDecision(db, browser, { projectId, decisionWorkItemId: decision.workItemId, winningOptionId: winner.id });
  const second = await resolveDecision(db, browser, { projectId, decisionWorkItemId: decision.workItemId, winningOptionId: winner.id });
  assert.equal(first.options.find((option) => option.id === winner.id).status, "accepted");
  assert.equal(second.options.find((option) => option.id === winner.id).status, "accepted");
});

test("resolving again with a different option than the one already accepted is a genuine conflict, not a replay", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision } = await twoOptionDecision(db, projectId, browser, "dec12");
  const [first, second] = decision.options;

  await resolveDecision(db, browser, { projectId, decisionWorkItemId: decision.workItemId, winningOptionId: first.id });
  await assert.rejects(
    resolveDecision(db, browser, { projectId, decisionWorkItemId: decision.workItemId, winningOptionId: second.id }),
    (error) => { assert.equal(error.code, "VALIDATION_FAILED"); return true; },
  );
});

test("resolveDecision leaves an already-done related item alone rather than overwriting its resolution", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision, optionB } = await twoOptionDecision(db, projectId, browser, "dec13");
  const winner = decision.options.find((option) => option.label === "REST");

  for (const [status, key] of [["planned", "ad-p"], ["ready", "ad-r"], ["in_progress", "ad-i"], ["done", "ad-d"]]) {
    const version = (await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(optionB).first()).version;
    await executeCommand(db, browser, { action: "transition_item", projectId, itemId: optionB, expectedVersion: version, status, idempotencyKey: key });
  }

  await resolveDecision(db, browser, { projectId, decisionWorkItemId: decision.workItemId, winningOptionId: winner.id });

  const row = await db.prepare("SELECT status, resolution FROM work_items WHERE id = ?").bind(optionB).first();
  assert.equal(row.status, "done");
  assert.notEqual(row.resolution, "superseded");
});

test("resolveDecision rejects an option ID that does not belong to this decision", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision } = await twoOptionDecision(db, projectId, browser, "dec14");
  await assert.rejects(
    resolveDecision(db, browser, { projectId, decisionWorkItemId: decision.workItemId, winningOptionId: "opt_does_not_exist" }),
    (error) => { assert.equal(error.code, "NOT_FOUND"); return true; },
  );
});

test("a superseded item surfaces in get_planning_context's rejected bucket with its reason", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { decision, optionB } = await twoOptionDecision(db, projectId, browser, "dec15");
  const winner = decision.options.find((option) => option.label === "REST");
  await resolveDecision(db, browser, { projectId, decisionWorkItemId: decision.workItemId, winningOptionId: winner.id, resolutionReason: "team already knows REST" });

  const organizationId = await organizationFor(db, browser);
  // Objective text matches the rejected item's own title closely, so relevance scoring
  // is not the thing under test here — only whether a superseded item can reach the
  // rejected bucket at all once it clears that floor.
  const context = await getPlanningContext(db, organizationId, { projectId, objective: "GraphQL for the public API" });
  const rejected = context.rejected.find((entry) => entry.workItemId === optionB);
  assert.ok(rejected, "expected the superseded GraphQL option to appear in the rejected bucket");
});

test("listOpenDecisions returns only unresolved decisions, scoped to the project", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const otherProjectId = (await executeCommand(db, browser, { action: "create_project", name: "Other", idempotencyKey: "dec16-other" })).projectId;

  const { decision: open } = await twoOptionDecision(db, projectId, browser, "dec16-open");
  const { decision: resolved } = await twoOptionDecision(db, projectId, browser, "dec16-resolved");
  await resolveDecision(db, browser, { projectId, decisionWorkItemId: resolved.workItemId, winningOptionId: resolved.options[0].id });
  await twoOptionDecision(db, otherProjectId, browser, "dec16-other-proj");

  const organizationId = await organizationFor(db, browser);
  const openDecisions = await listOpenDecisions(db, organizationId, projectId);
  assert.equal(openDecisions.length, 1);
  assert.equal(openDecisions[0].workItemId, open.workItemId);
});
