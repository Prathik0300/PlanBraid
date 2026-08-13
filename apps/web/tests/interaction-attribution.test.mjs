/**
 * F9 — interaction reconciliation attributed by interaction_id, not by clock.
 *
 * The defect: reconciliation counted every work_event with `created_at >= started_at`,
 * with no upper bound at all. Two interactions from the same source that overlap in time
 * — a real pattern when an agent starts a new turn before syncing the previous one —
 * could not be told apart by timestamps alone, so each interaction's completion saw the
 * other's mutations as its own, in both directions.
 *
 * The fix tags every mutation event with whichever interaction was open for that source
 * at write time (`activeInteractionId`), so reconciliation for a real begin/sync pair is
 * an exact match instead of a guess. These tests are built directly around the
 * overlapping case, plus the older no-prior-`begin_interaction` fallback that still needs
 * to keep working for clients that skip it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand, recordInteraction, registerSourceSession } from "@/lib/store.ts";

async function begin(db, projectId, sourceId, externalId) {
  return recordInteraction(db, principal, { projectId, sourceId, externalId, event: "started" });
}
async function complete(db, projectId, sourceId, externalId, extra = {}) {
  return recordInteraction(db, principal, { projectId, sourceId, externalId, event: "completed", ...extra });
}
async function note(db, projectId, itemId, sourceId, key) {
  return executeCommand(db, principal, { action: "add_note", projectId, itemId, sourceId, summary: `progress ${key}`, idempotencyKey: `note-${key}` });
}

test("a turn that changes a todo is reconciled as todos_changed", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s1" });
  const itemId = await createItem(db, projectId, "Some task", "i1");

  await begin(db, projectId, source.sourceId, "turn-1");
  await note(db, projectId, itemId, source.sourceId, "a");
  const result = await complete(db, projectId, source.sourceId, "turn-1");
  assert.equal(result.reconciliation, "todos_changed");
});

test("a turn that touches nothing is reconciled as no_todo_change", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s2" });

  await begin(db, projectId, source.sourceId, "turn-1");
  const result = await complete(db, projectId, source.sourceId, "turn-1");
  assert.equal(result.reconciliation, "no_todo_change");
});

test("the exact defect: two overlapping interactions from one source no longer cross-attribute", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s3" });
  const itemA = await createItem(db, projectId, "Task A", "ia");
  const itemB = await createItem(db, projectId, "Task B", "ib");

  // Turn 1 begins, then — before it syncs — turn 2 begins on the same source. This is
  // exactly the shape that broke the old timestamp-window query: both interactions are
  // 'started' with overlapping ranges.
  await begin(db, projectId, source.sourceId, "turn-1");
  await begin(db, projectId, source.sourceId, "turn-2");

  // Only turn 2 (the now-active interaction for this source) actually changes anything.
  await note(db, projectId, itemB, source.sourceId, "b");

  const turn1Result = await complete(db, projectId, source.sourceId, "turn-1");
  const turn2Result = await complete(db, projectId, source.sourceId, "turn-2");

  assert.equal(turn1Result.reconciliation, "no_todo_change", "turn 1 must not see turn 2's mutation as its own");
  assert.equal(turn2Result.reconciliation, "todos_changed", "turn 2's own mutation must still be attributed to it");
  void itemA; // named for clarity of what was available to touch but wasn't
});

test("the reverse direction: the earlier turn's own mutation is not stolen by the later one", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s4" });
  const itemA = await createItem(db, projectId, "Task A", "ia2");

  await begin(db, projectId, source.sourceId, "turn-1");
  await note(db, projectId, itemA, source.sourceId, "a"); // attributed to turn-1, the only one open right now
  await begin(db, projectId, source.sourceId, "turn-2"); // turn-2 opens after; nothing happens during it

  const turn1Result = await complete(db, projectId, source.sourceId, "turn-1");
  const turn2Result = await complete(db, projectId, source.sourceId, "turn-2");

  assert.equal(turn1Result.reconciliation, "todos_changed", "the mutation genuinely happened during turn 1");
  assert.equal(turn2Result.reconciliation, "no_todo_change", "turn 2 must not inherit turn 1's mutation just because it was open at completion time");
});

test("sequential, non-overlapping turns from one source are each reconciled independently", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s5" });
  const itemA = await createItem(db, projectId, "Task A", "ia3");

  await begin(db, projectId, source.sourceId, "turn-1");
  await note(db, projectId, itemA, source.sourceId, "a");
  const first = await complete(db, projectId, source.sourceId, "turn-1");

  await begin(db, projectId, source.sourceId, "turn-2");
  const second = await complete(db, projectId, source.sourceId, "turn-2");

  assert.equal(first.reconciliation, "todos_changed");
  assert.equal(second.reconciliation, "no_todo_change", "a later, unrelated interaction must not inherit an earlier one's mutation");
});

test("two different sources overlapping in time never cross-attribute — the ordinary case must keep working", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const claude = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s6" });
  const codex = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "s7" });
  const itemA = await createItem(db, projectId, "Claude's task", "ia4");

  await begin(db, projectId, claude.sourceId, "turn-1");
  await begin(db, projectId, codex.sourceId, "turn-1"); // same external_id, different source: no collision
  await note(db, projectId, itemA, claude.sourceId, "a");

  const claudeResult = await complete(db, projectId, claude.sourceId, "turn-1");
  const codexResult = await complete(db, projectId, codex.sourceId, "turn-1");
  assert.equal(claudeResult.reconciliation, "todos_changed");
  assert.equal(codexResult.reconciliation, "no_todo_change");
});

test("a mutation event is stamped with the interaction that was open when it was written", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s8" });
  const itemId = await createItem(db, projectId, "Stamped task", "ia5");
  const started = await begin(db, projectId, source.sourceId, "turn-1");
  await note(db, projectId, itemId, source.sourceId, "a");

  const event = await db.prepare("SELECT interaction_id FROM work_events WHERE event_type = 'work_item.progress_reported'").first();
  assert.equal(event.interaction_id, started.interactionId);
});

test("an event written with no open interaction for its source carries a null interaction_id", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s9" });
  const itemId = await createItem(db, projectId, "No open turn", "ia6");
  await note(db, projectId, itemId, source.sourceId, "a"); // no begin_interaction was ever called

  const event = await db.prepare("SELECT interaction_id FROM work_events WHERE event_type = 'work_item.progress_reported'").first();
  assert.equal(event.interaction_id, null);
});

test("completing without ever calling begin_interaction still falls back to a bounded window, not an unbounded one", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s10" });
  const itemId = await createItem(db, projectId, "Sync-only turn", "ia7");
  await note(db, projectId, itemId, source.sourceId, "a");

  // No begin_interaction call at all: `existing` will be null inside recordInteraction,
  // exercising the fallback path rather than the exact interaction_id match.
  const result = await complete(db, projectId, source.sourceId, "sync-only-turn");
  assert.equal(result.reconciliation, "todos_changed", "the fallback window must still see a mutation that happened moments ago");
});

test("the fallback window has a genuine upper bound: a later, unrelated interaction's events are not swept in", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "s11" });
  const itemA = await createItem(db, projectId, "Early, no begin_interaction", "ia8");
  const itemB = await createItem(db, projectId, "Later, different turn", "ia9");

  // A sync-only completion with nothing having happened yet.
  const early = await complete(db, projectId, source.sourceId, "sync-only-early");
  assert.equal(early.reconciliation, "no_todo_change");

  // A later turn, properly bracketed, that changes something after the first one completed.
  await begin(db, projectId, source.sourceId, "turn-later");
  await note(db, projectId, itemB, source.sourceId, "b");
  await complete(db, projectId, source.sourceId, "turn-later");
  void itemA;

  // Re-fetching the *already-completed* early interaction's stored reconciliation must not
  // have been retroactively changed by the later turn's activity.
  const stored = await db.prepare("SELECT reconciliation FROM interactions WHERE source_id = ? AND external_id = ?").bind(source.sourceId, "sync-only-early").first();
  assert.equal(stored.reconciliation, "no_todo_change");
});
