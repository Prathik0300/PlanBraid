/**
 * Domain-logic tests for dependency edges, run against a real (in-memory) database via
 * the local-pg harness (see tests/support/local-pg.mjs). Covers the two live bugs
 * fixed in M2 (unfiltered cycle check, duplicate edge misreported as a conflict) and
 * the new depends_on resolution path in create_work_items.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { createWorkItemsDeduplicated, executeCommand, organizationFor } from "@/lib/store.ts";

test("add_dependency: a direct cycle is rejected", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Task A");
  const b = await createItem(db, projectId, "Task B");

  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: a, toWorkItemId: b, type: "blocks", idempotencyKey: "d1" });

  await assert.rejects(
    executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: b, toWorkItemId: a, type: "blocks", idempotencyKey: "d2" }),
    (error) => { assert.equal(error.code, "BLOCKING_CYCLE"); return true; },
  );
});

test("add_dependency: a longer transitive cycle is rejected", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const [a, b, c, d] = await Promise.all(["A", "B", "C", "D"].map((label) => createItem(db, projectId, `Task ${label}`)));

  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: a, toWorkItemId: b, idempotencyKey: "e1" });
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: b, toWorkItemId: c, idempotencyKey: "e2" });
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: c, toWorkItemId: d, idempotencyKey: "e3" });

  // D -> A would close the loop A -> B -> C -> D -> A.
  await assert.rejects(
    executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: d, toWorkItemId: a, idempotencyKey: "e4" }),
    (error) => { assert.equal(error.code, "BLOCKING_CYCLE"); assert.ok(Array.isArray(error.details)); return true; },
  );
});

test("add_dependency: unrelated edges among the same items are not falsely flagged", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Task A");
  const b = await createItem(db, projectId, "Task B");
  const c = await createItem(db, projectId, "Task C");
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: a, toWorkItemId: b, idempotencyKey: "f1" });
  // C -> B does not create a cycle (no path from B back to C).
  const result = await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: c, toWorkItemId: b, idempotencyKey: "f2" });
  assert.ok(result.dependencyId);
});

test("add_dependency: symmetric annotation edges in both directions are not a cycle", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Task A");
  const b = await createItem(db, projectId, "Task B");

  const first = await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: a, toWorkItemId: b, type: "relates_to", idempotencyKey: "r1" });
  assert.ok(first.dependencyId);
  // The literal reverse of a symmetric edge must succeed, not be rejected as a cycle.
  const second = await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: b, toWorkItemId: a, type: "relates_to", idempotencyKey: "r2" });
  assert.ok(second.dependencyId);
  assert.notEqual(first.dependencyId, second.dependencyId);
});

test("add_dependency: a hard edge is still blocked by an existing annotation-edge cycle path being irrelevant", async () => {
  // A relates_to B (annotation, ignored by cycle check) should not prevent A blocks B.
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Task A");
  const b = await createItem(db, projectId, "Task B");
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: a, toWorkItemId: b, type: "relates_to", idempotencyKey: "g1" });
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: b, toWorkItemId: a, type: "relates_to", idempotencyKey: "g2" });
  const blocks = await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: a, toWorkItemId: b, type: "blocks", idempotencyKey: "g3" });
  assert.ok(blocks.dependencyId);
});

test("add_dependency: a duplicate edge is an idempotent no-op, not a conflict", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Task A");
  const b = await createItem(db, projectId, "Task B");
  const first = await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: a, toWorkItemId: b, type: "blocks", idempotencyKey: "h1" });
  // A different idempotency key, same edge: must not throw CONCURRENT_MODIFICATION.
  const second = await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: a, toWorkItemId: b, type: "blocks", idempotencyKey: "h2-different-key" });
  assert.equal(second.dependencyId, first.dependencyId);
  assert.equal(second.idempotentReplay, true);
});

test("add_dependency: the same pair with a different type is a distinct edge, not a duplicate", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Task A");
  const b = await createItem(db, projectId, "Task B");
  const blocks = await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: a, toWorkItemId: b, type: "blocks", idempotencyKey: "i1" });
  const relates = await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: a, toWorkItemId: b, type: "relates_to", idempotencyKey: "i2" });
  assert.notEqual(blocks.dependencyId, relates.dependencyId);
});

test("add_dependency: a task cannot block itself", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Task A");
  await assert.rejects(
    executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: a, toWorkItemId: a, idempotencyKey: "j1" }),
    (error) => { assert.equal(error.code, "BLOCKING_CYCLE"); return true; },
  );
});

test("create_work_items: depends_on resolves refs within the same batch", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "batch-1",
    proposals: [
      { ref: "schema", title: "Add blocking_count column" },
      { ref: "api", title: "Derive columns in the worker", dependsOn: ["schema"] },
    ],
  });
  const [schema, api] = outcome.results;
  assert.equal(schema.status, "created");
  assert.equal(api.status, "created");
  assert.deepEqual(api.linkedDependencies, [schema.itemKey]);

  const org = await organizationFor(db, principal);
  const edges = await db.prepare("SELECT from_work_item_id, to_work_item_id, type FROM dependencies WHERE organization_id = ?").bind(org).all();
  assert.equal(edges.results.length, 1);
  assert.equal(edges.results[0].from_work_item_id, schema.workItemId);
  assert.equal(edges.results[0].to_work_item_id, api.workItemId);
  assert.equal(edges.results[0].type, "blocks");
});

test("create_work_items: depends_on resolves through a merge, onto the canonical item", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  // Claude already proposed and created the prerequisite.
  const claudeBatch = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "claude-batch",
    proposals: [{ ref: "schema", title: "Add blocking_count column" }],
  });
  const canonicalSchemaId = claudeBatch.results[0].workItemId;
  const canonicalSchemaKey = claudeBatch.results[0].itemKey;

  // Codex proposes the exact same prerequisite again (by title) inside a batch that
  // also depends on it. The ref must resolve to the canonical (Claude's) item, not to
  // a dead reference or a second duplicate item.
  const codexBatch = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "codex-batch",
    proposals: [
      { ref: "schema", title: "Add blocking_count column" },
      { ref: "api", title: "Derive columns in the worker", dependsOn: ["schema"] },
    ],
  });
  const [schemaOutcome, apiOutcome] = codexBatch.results;
  assert.equal(schemaOutcome.status, "matched");
  assert.equal(schemaOutcome.workItemId, canonicalSchemaId, "the depends_on ref's target must be the canonical pre-existing item");
  assert.deepEqual(apiOutcome.linkedDependencies, [canonicalSchemaKey]);

  const org = await organizationFor(db, principal);
  const edges = await db.prepare("SELECT from_work_item_id, to_work_item_id FROM dependencies WHERE organization_id = ?").bind(org).all();
  assert.equal(edges.results.length, 1);
  assert.equal(edges.results[0].from_work_item_id, canonicalSchemaId);
  assert.equal(edges.results[0].to_work_item_id, apiOutcome.workItemId);
});

test("create_work_items: depends_on also accepts a literal existing work_item_id, not just a batch ref", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const existing = await createItem(db, projectId, "Provision the database");
  const batch = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "batch-2",
    proposals: [{ ref: "migrate", title: "Run migrations", dependsOn: [existing] }],
  });
  assert.deepEqual(batch.results[0].linkedDependencies, ["#1"]);
});

test("create_work_items: an invalid depends_on ref degrades to a warning without failing the batch", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const batch = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "batch-3",
    proposals: [
      { ref: "a", title: "Migrate the users table", dependsOn: ["nonexistent_ref_or_id"] },
      { ref: "b", title: "Update the changelog" },
    ],
  });
  assert.equal(batch.summary.created, 2, "both items must still be created despite the bad reference");
  assert.equal(batch.results[0].status, "created");
  assert.ok(Array.isArray(batch.results[0].dependencyWarnings) && batch.results[0].dependencyWarnings.length === 1);
  assert.equal(batch.results[0].linkedDependencies, undefined);
});

test("create_work_items: depends_on pointing at itself is skipped with a warning", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const batch = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "batch-4",
    proposals: [{ ref: "a", title: "Task A", dependsOn: ["a"] }],
  });
  assert.equal(batch.results[0].status, "created");
  assert.match(batch.results[0].dependencyWarnings[0], /cannot depend on itself/);
});

test("create_work_items: a depends_on edge that would close a cycle degrades to a warning, not a thrown error", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const x = await createItem(db, projectId, "Add pagination to /api/state");
  const z = await createItem(db, projectId, "Write pagination tests");
  // Existing chain: X blocks Z.
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: x, toWorkItemId: z, idempotencyKey: "cyc1" });

  // A proposal that restates X (matches it exactly, so its target resolves to the
  // canonical X) and declares Z as its own prerequisite. Z -> X would close the loop
  // X -> Z -> X. This must report a warning, not throw and lose the batch.
  const batch = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "batch-cycle",
    proposals: [{ ref: "x-again", title: "Add pagination to /api/state", dependsOn: [z] }],
  });
  assert.equal(batch.results[0].status, "matched");
  assert.equal(batch.results[0].workItemId, x);
  assert.match(batch.results[0].dependencyWarnings[0], /dependency cycle/);
  assert.equal(batch.results[0].linkedDependencies, undefined);

  const org = await organizationFor(db, principal);
  const edges = await db.prepare("SELECT COUNT(*) AS count FROM dependencies WHERE organization_id = ?").bind(org).first();
  assert.equal(edges.count, 1, "the cyclic edge must not have been written");
});
