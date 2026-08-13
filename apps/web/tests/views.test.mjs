/**
 * M23 — query surfaces.
 *
 * "Saved views over the structured state... No prose parsing." These tests are built
 * around each view answering exactly the question its name asks, using nothing but
 * primitives M9, M12, M19, and M21 already shipped and already have their own dedicated
 * test coverage for — this file is about the retrieval/grouping layer on top, not about
 * re-proving those signals from scratch.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand, createWorkItemsDeduplicated, organizationFor, registerSourceSession, updateSourceHeartbeat } from "@/lib/store.ts";
import { recordDecision } from "@/lib/planning/decisions.ts";
import { getSavedView, assertSavedViewName } from "@/lib/planning/views.ts";

const browser = { ...principal, authentication: "browser" };

async function readyItem(db, projectId, title, key) {
  const itemId = await createItem(db, projectId, title, key);
  const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first();
  await executeCommand(db, browser, { action: "transition_item", projectId, itemId, expectedVersion: row.version, status: "planned", idempotencyKey: `${key}-p` });
  return itemId;
}

async function inProgress(db, projectId, itemId, key) {
  for (const [index, status] of ["ready", "in_progress"].entries()) {
    const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first();
    await executeCommand(db, browser, { action: "transition_item", projectId, itemId, expectedVersion: row.version, status, idempotencyKey: `${key}-${index}` });
  }
}

async function done(db, projectId, itemId, key) {
  await inProgress(db, projectId, itemId, key);
  const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first();
  await executeCommand(db, browser, { action: "transition_item", projectId, itemId, expectedVersion: row.version, status: "done", idempotencyKey: `${key}-done` });
}

test("assertSavedViewName rejects an unknown view name", () => {
  assert.throws(() => assertSavedViewName("not_a_real_view"), (error) => { assert.equal(error.code, "VALIDATION_FAILED"); return true; });
});

test("active: an in-progress item held by a live session names its holder", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Ship the release notes", "v1");
  await inProgress(db, projectId, itemId, "v1");
  const source = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "views-src-1" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [itemId] });

  const result = await getSavedView(db, principal, projectId, "active");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].workItemId, itemId);
  assert.match(result.items[0].detail, /held by codex/);
});

test("active: an in-progress item with nobody holding it says so honestly", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Ship the release notes", "v2");
  await inProgress(db, projectId, itemId, "v2");

  const result = await getSavedView(db, principal, projectId, "active");
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].detail, /no active session/);
});

test("blocking_release: the root blocker is named, ranked by how many items it holds up", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const rootId = await createItem(db, projectId, "Add the shared auth schema", "v3-root");
  const blockedA = await createItem(db, projectId, "Build login with the new schema", "v3-a");
  const blockedB = await createItem(db, projectId, "Build signup with the new schema", "v3-b");
  await executeCommand(db, browser, { action: "add_dependency", projectId, fromWorkItemId: rootId, toWorkItemId: blockedA, type: "blocks", idempotencyKey: "v3-dep-a" });
  await executeCommand(db, browser, { action: "add_dependency", projectId, fromWorkItemId: rootId, toWorkItemId: blockedB, type: "blocks", idempotencyKey: "v3-dep-b" });

  const result = await getSavedView(db, principal, projectId, "blocking_release");
  assert.equal(result.items.length, 1, "both blocked items share one root, so this must be one entry, not two");
  assert.equal(result.items[0].workItemId, rootId);
  assert.match(result.items[0].detail, /blocking 2 other items/);
});

test("blocking_release: an item with no blockers is invisible", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Unblocked work", "v4");
  const result = await getSavedView(db, principal, projectId, "blocking_release");
  assert.deepEqual(result.items, []);
});

test("keeps_getting_proposed: a task independently proposed three times by two agents surfaces", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const claude = await db.prepare("INSERT INTO sources (id, organization_id, project_id, provider, external_id, title) VALUES ('src_v5c', ?, ?, 'claude', 'v5c', 'Claude') RETURNING id").bind(organizationId, projectId).first();
  const codex = await db.prepare("INSERT INTO sources (id, organization_id, project_id, provider, external_id, title) VALUES ('src_v5x', ?, ?, 'codex', 'v5x', 'Codex') RETURNING id").bind(organizationId, projectId).first();

  const title = "Refactor the authentication middleware";
  const first = await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: claude.id, idempotencyKey: "v5-1", proposals: [{ title }] });
  await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: codex.id, idempotencyKey: "v5-2", proposals: [{ title }] });
  await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: codex.id, idempotencyKey: "v5-3", proposals: [{ title }] });
  const itemId = first.results[0].workItemId;
  await db.prepare("UPDATE work_items SET created_at = now() - interval '20 days' WHERE id = ?").bind(itemId).run();
  await db.prepare("UPDATE work_item_aliases SET created_at = now() - interval '10 days' WHERE work_item_id = ?").bind(itemId).run();

  const result = await getSavedView(db, principal, projectId, "keeps_getting_proposed");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].workItemId, itemId);
});

test("no_proof: a done item with no evidence at all appears; one with verified evidence does not", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const unproven = await readyItem(db, projectId, "Ship without proof", "v6a");
  await done(db, projectId, unproven, "v6a");
  const proven = await readyItem(db, projectId, "Ship with proof", "v6b");
  await inProgress(db, projectId, proven, "v6b");
  await executeCommand(db, browser, { action: "add_evidence", projectId, itemId: proven, type: "commit", label: "verified commit", result: "verified", idempotencyKey: "v6b-ev" });
  const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(proven).first();
  await executeCommand(db, browser, { action: "transition_item", projectId, itemId: proven, expectedVersion: row.version, status: "done", idempotencyKey: "v6b-done" });

  const result = await getSavedView(db, principal, projectId, "no_proof");
  const ids = result.items.map((item) => item.workItemId);
  assert.ok(ids.includes(unproven), "an unproven completion must appear");
  assert.ok(!ids.includes(proven), "a verified completion must never appear as unproven");
});

test("no_proof: work that is not done at all never appears, proven or not", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await readyItem(db, projectId, "Still planned", "v7");
  const result = await getSavedView(db, principal, projectId, "no_proof");
  assert.deepEqual(result.items.map((item) => item.workItemId).includes(itemId), false);
});

test("needs_decision: an open decision surfaces with its options in the detail", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const decision = await recordDecision(db, browser, {
    projectId, question: "REST or GraphQL for the public API?",
    options: [{ label: "REST" }, { label: "GraphQL" }], idempotencyKey: "v8",
  });

  const result = await getSavedView(db, principal, projectId, "needs_decision");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].workItemId, decision.workItemId);
  assert.match(result.items[0].detail, /REST/);
  assert.match(result.items[0].detail, /GraphQL/);
});

test("needs_decision: a resolved decision no longer appears", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const decision = await recordDecision(db, browser, {
    projectId, question: "Redis or Postgres for sessions?",
    options: [{ label: "Redis" }, { label: "Postgres" }], idempotencyKey: "v9",
  });
  const { resolveDecision } = await import("@/lib/planning/decisions.ts");
  await resolveDecision(db, browser, { projectId, decisionWorkItemId: decision.workItemId, winningOptionId: decision.options[0].id });

  const result = await getSavedView(db, principal, projectId, "needs_decision");
  assert.deepEqual(result.items, []);
});

test("every view is scoped to its own project", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, browser, { action: "create_project", name: "Other", idempotencyKey: "v10-proj" })).projectId;
  const itemId = await readyItem(db, projectB, "Work in the other project", "v10");
  await inProgress(db, projectB, itemId, "v10");

  const result = await getSavedView(db, principal, projectA, "active");
  assert.deepEqual(result.items, []);
});
