/**
 * E6 — DB-backed: a proposal in the ambiguous band raises a judgment request through
 * `createWorkItemsDeduplicated`, and `submitJudgment` answers it, capturing a label
 * without mutating the graph. Also covers the escalation-rate query.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { createWorkItemsDeduplicated } from "@/lib/store.ts";
import { submitJudgment } from "@/lib/planning/judgments.ts";
import { measureEscalationRate } from "@/lib/dedup/judgments.ts";

async function organizationIdFor(db, projectId) {
  const row = await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(projectId).first();
  return row.organization_id;
}

test("a possible-band match raises a needsJudgment entry at both the entry and top level", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const existingId = await createItem(db, projectId, "Add rate limiting to /api/login");

  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "jdg-1",
    proposals: [{ title: "Add rate limiting" }],
  });

  const entry = outcome.results[0];
  assert.equal(entry.status, "created");
  assert.ok(entry.needsJudgment, "the ambiguous match should raise a judgment request");
  assert.equal(outcome.needsJudgment.length, 1);
  assert.equal(outcome.needsJudgment[0].pairId, entry.needsJudgment.pairId);
  assert.equal(outcome.needsJudgment[0].answerWith, "submit_reconciliation_judgment");
  assert.match(outcome.needsJudgment[0].question, /rate limiting/);

  const row = await db.prepare("SELECT status, left_item_id, right_item_id FROM reconciliation_judgment_requests WHERE id = ?").bind(entry.needsJudgment.pairId).first();
  assert.equal(row.status, "open");
  assert.equal(row.left_item_id, entry.workItemId);
  assert.equal(row.right_item_id, existingId);
});

test("a conflict match does NOT raise a judgment request — E4's decision mechanism handles it instead", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Add lib/auth/middleware.ts");

  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "jdg-2",
    proposals: [{ title: "Remove lib/auth/middleware.ts" }],
  });

  assert.equal(outcome.results[0].relation.type, "CONFLICT");
  assert.equal(outcome.results[0].needsJudgment, undefined);
  assert.equal(outcome.needsJudgment.length, 0);
});

test("submitJudgment rejects a trivial justification without touching the database", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Add rate limiting to /api/login");
  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "jdg-3",
    proposals: [{ title: "Add rate limiting" }],
  });
  const pairId = outcome.results[0].needsJudgment.pairId;

  await assert.rejects(
    submitJudgment(db, principal, { projectId, pairId, verdict: "different", justification: "different" }),
    (error) => error.code === "VALIDATION_FAILED",
  );
  const row = await db.prepare("SELECT status FROM reconciliation_judgment_requests WHERE id = ?").bind(pairId).first();
  assert.equal(row.status, "open");
});

test("submitJudgment with a real justification answers the request and captures a label, without merging or linking anything", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const existingId = await createItem(db, projectId, "Add rate limiting to /api/login");
  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "jdg-4",
    proposals: [{ title: "Add rate limiting" }],
  });
  const newItemId = outcome.results[0].workItemId;
  const pairId = outcome.results[0].needsJudgment.pairId;
  // E4's own relation typing already ran as part of createWorkItemsDeduplicated and may
  // have linked these two independently (this pair is lexically identical once /api/login
  // is stripped as an artifact, so it reads as RELATED) — that edge is E4's business, not
  // submitJudgment's. What this test needs to prove is narrower: answering the judgment
  // itself adds no *further* edge and doesn't touch item count.
  const edgesBefore = (await db.prepare("SELECT COUNT(*)::int AS count FROM dependencies WHERE project_id = ?").bind(projectId).first()).count;

  const answer = await submitJudgment(db, principal, {
    projectId, pairId, verdict: "different",
    justification: "different — the existing item scopes rate limiting to /api/login specifically, this proposal names no endpoint at all",
  });
  assert.equal(answer.status, "answered");
  assert.equal(answer.alreadyAnswered, false);

  const row = await db.prepare("SELECT status, answered_verdict FROM reconciliation_judgment_requests WHERE id = ?").bind(pairId).first();
  assert.equal(row.status, "answered");
  assert.equal(row.answered_verdict, "different");

  const label = await db.prepare("SELECT verdict, confidence, label_source, justification FROM reconciliation_labels WHERE project_id = ? AND left_item_id = ? AND right_item_id = ?")
    .bind(projectId, newItemId, existingId).first();
  assert.equal(label.verdict, "different");
  assert.equal(label.confidence, "medium");
  assert.equal(label.label_source, "judgment");

  // Never merges: both items still exist, independently.
  const items = await db.prepare("SELECT id FROM work_items WHERE project_id = ? AND archived_at IS NULL").bind(projectId).all();
  assert.equal(items.results.length, 2);
  // Never links, beyond whatever E4 already did before this call: the count is unchanged.
  const edgesAfter = (await db.prepare("SELECT COUNT(*)::int AS count FROM dependencies WHERE project_id = ?").bind(projectId).first()).count;
  assert.equal(edgesAfter, edgesBefore);
});

test("submitJudgment replays idempotently when the same verdict is submitted twice", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Add rate limiting to /api/login");
  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "jdg-5",
    proposals: [{ title: "Add rate limiting" }],
  });
  const pairId = outcome.results[0].needsJudgment.pairId;
  const justification = "different — the existing item scopes rate limiting to /api/login specifically, this proposal has no such scope yet";

  const first = await submitJudgment(db, principal, { projectId, pairId, verdict: "different", justification });
  const second = await submitJudgment(db, principal, { projectId, pairId, verdict: "different", justification });
  assert.equal(first.alreadyAnswered, false);
  assert.equal(second.alreadyAnswered, true);

  const labels = await db.prepare("SELECT COUNT(*)::int AS count FROM reconciliation_labels WHERE label_source = 'judgment'").first();
  assert.equal(Number(labels.count), 1, "a replay must not create a second label");
});

test("submitJudgment rejects re-answering with a different verdict than the first answer", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Add rate limiting to /api/login");
  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "jdg-6",
    proposals: [{ title: "Add rate limiting" }],
  });
  const pairId = outcome.results[0].needsJudgment.pairId;

  await submitJudgment(db, principal, { projectId, pairId, verdict: "different", justification: "different — one rotates the signing key, the other renews the token" });
  await assert.rejects(
    submitJudgment(db, principal, { projectId, pairId, verdict: "same", justification: "actually the same work after all, both touch tokens.ts" }),
    (error) => error.code === "VALIDATION_FAILED",
  );
});

test("submitJudgment 404s for a pairId that doesn't exist", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await assert.rejects(
    submitJudgment(db, principal, { projectId, pairId: "jdg_nonexistent", verdict: "same", justification: "a real justification naming something concrete here" }),
    (error) => error.code === "NOT_FOUND",
  );
});

test("measureEscalationRate: counts judgment requests against created items", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationIdFor(db, projectId);
  await createItem(db, projectId, "Add rate limiting to /api/login");
  await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "jdg-7",
    proposals: [{ title: "Add rate limiting" }],
  });

  const report = await measureEscalationRate(db, organizationId, projectId);
  assert.equal(report.itemsCreated, 2);
  assert.equal(report.judgmentRequests, 1);
  assert.equal(report.rate, 0.5);
});

test("measureEscalationRate: zero items created is a zero rate, not a division-by-zero crash", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationIdFor(db, projectId);
  const report = await measureEscalationRate(db, organizationId, projectId);
  assert.equal(report.itemsCreated, 0);
  assert.equal(report.rate, 0);
});
