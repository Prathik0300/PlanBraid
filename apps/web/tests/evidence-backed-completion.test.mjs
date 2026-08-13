/**
 * M16 — evidence-backed completion (feature 6, §9 decision 1).
 *
 * The gap this closes: report_completion used to trust a `verified` boolean the calling
 * agent set on itself, so "Claude says it finished" really was sufficient. These tests are
 * built around the two ways that gap could reopen if this were done carelessly — an agent
 * writing `result: "verified"` into its own evidence array in the same call, or the gate
 * looking only at this call's evidence instead of the item's whole record — and around the
 * one legitimate path in: evidence that was already machine-verified before the claim.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand } from "@/lib/store.ts";
import { reportCompletion } from "@/lib/planning/completion.ts";

async function inProgressItem(db, projectId, title, key) {
  const itemId = await createItem(db, projectId, title, key);
  const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first();
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId, expectedVersion: row.version, status: "planned", idempotencyKey: `${key}-p` });
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId, expectedVersion: row.version + 1, status: "ready", idempotencyKey: `${key}-r` });
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId, expectedVersion: row.version + 2, status: "in_progress", idempotencyKey: `${key}-i` });
  return itemId;
}

test("report_completion with no evidence at all lands in review, never done", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await inProgressItem(db, projectId, "Ship without proof", "c1");

  const result = await reportCompletion(db, principal, { projectId, itemId, summary: "Done", idempotencyKey: "rc1" });
  assert.equal(result.status, "in_review");
  assert.equal(result.verified, false);
  const row = await db.prepare("SELECT status FROM work_items WHERE id = ?").bind(itemId).first();
  assert.equal(row.status, "in_review");
});

test("evidence with no result field at all lands in review, not done", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await inProgressItem(db, projectId, "Attach evidence, but nothing checked it", "c2");

  const result = await reportCompletion(db, principal, { projectId, itemId, summary: "Done", evidence: [{ type: "pr", label: "PR #4" }], idempotencyKey: "rc2" });
  assert.equal(result.status, "in_review");
  assert.equal(result.verified, false);
});

test("the exact gap this milestone closes: writing result 'verified' into this call's own evidence array does not reach done", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await inProgressItem(db, projectId, "Self-declare verified", "c3");

  const result = await reportCompletion(db, principal, { projectId, itemId, summary: "Done, I promise", evidence: [{ type: "agent_claim", label: "Trust me", result: "verified" }], idempotencyKey: "rc3" });
  assert.equal(result.status, "in_review", "an agent's own claim, even worded as evidence, must never be self-certifying");
  assert.equal(result.verified, false);
  const row = await db.prepare("SELECT status FROM work_items WHERE id = ?").bind(itemId).first();
  assert.equal(row.status, "in_review");
});

test("evidence that was already machine-verified before the call reaches done", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await inProgressItem(db, projectId, "Actually verified earlier", "c4");
  // Standing in for M15's report_repo_state, which is the one thing that writes this
  // result value today, computed from a real exit code rather than asserted.
  await executeCommand(db, principal, { action: "add_evidence", projectId, itemId, type: "commit", label: "Commit abc123 touched store.ts", result: "verified", idempotencyKey: "pre-verify" });

  const result = await reportCompletion(db, principal, { projectId, itemId, summary: "Done", idempotencyKey: "rc4" });
  assert.equal(result.status, "done");
  assert.equal(result.verified, true);
  const row = await db.prepare("SELECT status FROM work_items WHERE id = ?").bind(itemId).first();
  assert.equal(row.status, "done");
});

test("a failed verification result never counts as verified", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await inProgressItem(db, projectId, "The tests failed", "c5");
  await executeCommand(db, principal, { action: "add_evidence", projectId, itemId, type: "commit", label: "Commit touched store.ts", result: "failed", idempotencyKey: "pre-fail" });

  const result = await reportCompletion(db, principal, { projectId, itemId, summary: "Done", idempotencyKey: "rc5" });
  assert.equal(result.status, "in_review");
});

test("report_completion still attaches the summary note and evidence even when it lands in review", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await inProgressItem(db, projectId, "Record the evidence regardless", "c6");

  await reportCompletion(db, principal, { projectId, itemId, summary: "Implementation complete", evidence: [{ type: "pr", label: "PR #9", uri: "https://example.com/pr/9" }], idempotencyKey: "rc6" });

  const evidence = await db.prepare("SELECT type, label, uri FROM evidence WHERE work_item_id = ?").bind(itemId).first();
  assert.equal(evidence.type, "pr");
  assert.equal(evidence.uri, "https://example.com/pr/9");
  const note = await db.prepare("SELECT summary FROM work_events WHERE work_item_id = ? AND event_type = 'work_item.progress_reported'").bind(itemId).first();
  assert.ok(note, "the summary must still be recorded even when the item does not reach done");
});

test("a nonexistent work item raises NOT_FOUND rather than crashing", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await assert.rejects(
    reportCompletion(db, principal, { projectId, itemId: "wi_does_not_exist", summary: "Done", idempotencyKey: "rc7" }),
    (error) => { assert.equal(error.code, "NOT_FOUND"); return true; },
  );
});

test("calling report_completion twice with the same idempotency key does not double-attach evidence or re-fire the transition", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await inProgressItem(db, projectId, "Idempotent completion report", "c8");

  const first = await reportCompletion(db, principal, { projectId, itemId, summary: "Done", evidence: [{ type: "pr", label: "PR #1" }], idempotencyKey: "rc8" });
  const second = await reportCompletion(db, principal, { projectId, itemId, summary: "Done", evidence: [{ type: "pr", label: "PR #1" }], idempotencyKey: "rc8" });

  assert.deepEqual(first, second);
  const evidenceCount = await db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE work_item_id = ?").bind(itemId).first();
  assert.equal(Number(evidenceCount.count), 1);
});
