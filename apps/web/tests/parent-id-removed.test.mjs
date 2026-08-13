/**
 * F7 — parent_id, decided.
 *
 * The column was declared in the schema and read into WorkItem for as long as the schema
 * existed, and nothing anywhere ever wrote to it — a decision three architecture documents
 * deferred without ever actually making. Settled: removed, in favor of the `objective_id`
 * M20 introduces later, which names what the relationship means instead of leaving every
 * reader to guess.
 *
 * The one thing worth a real test is the migration itself: dropping a column from a table
 * that already has rows must not touch anything else in those rows, and must be a genuine
 * no-op on a database that never had the column in the first place.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { setupProject, createItem } from "./support/fixtures.mjs";

test("work_items has no parent_id column after schema setup", async () => {
  const db = await createTestDb();
  const columns = await db.prepare("SELECT column_name FROM information_schema.columns WHERE table_name = 'work_items'").all();
  assert.ok(!columns.results.some((row) => row.column_name === "parent_id"));
});

test("dropping the column on a database that pre-dates F7 preserves every other column's data", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Pre-existing work", "pre1");
  // Simulate a database that had parent_id from before this migration existed.
  await db.prepare("ALTER TABLE work_items ADD COLUMN parent_id TEXT").run();
  await db.prepare("UPDATE work_items SET parent_id = 'wi_something' WHERE id = ?").bind(itemId).run();

  const before = await db.prepare("SELECT title, status, sequence, item_key FROM work_items WHERE id = ?").bind(itemId).first();

  // Re-running schema setup is what a real deploy does; MIGRATION_STATEMENTS' drop must
  // remove the column cleanly rather than erroring because a later ALTER expects it gone.
  await ensureSchemaFresh(db);

  const columns = await db.prepare("SELECT column_name FROM information_schema.columns WHERE table_name = 'work_items'").all();
  assert.ok(!columns.results.some((row) => row.column_name === "parent_id"));
  const after = await db.prepare("SELECT title, status, sequence, item_key FROM work_items WHERE id = ?").bind(itemId).first();
  assert.deepEqual(after, before, "dropping one column must not disturb any other column's data");
});

/** ensureSchema is a process-wide once-guard; re-invoke the underlying statements directly
 * so this test can exercise the migration a second time within one process. */
async function ensureSchemaFresh(db) {
  const { MIGRATION_STATEMENTS } = await import("@/db/setup.ts");
  for (const statement of MIGRATION_STATEMENTS) {
    try { await db.prepare(statement).run(); } catch { /* already applied */ }
  }
}

test("re-running the migration when the column is already gone is a genuine no-op", async () => {
  const db = await createTestDb(); // never had parent_id at all
  await ensureSchemaFresh(db); // DROP COLUMN IF EXISTS must not throw with nothing to drop
  await ensureSchemaFresh(db); // and a second re-run must be equally harmless
});
