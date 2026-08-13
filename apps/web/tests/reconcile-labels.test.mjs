/**
 * E0 — the reconciliation evaluation harness.
 *
 * Two things under test, matching the two halves of lib/dedup/labels.ts:
 *  1. Capture: merging two items writes a positive label, splitting or dismissing a
 *     duplicate-shaped finding writes a negative one — at the moment of the action, in
 *     the same commit, with no separate write path to drift from the thing it labels.
 *  2. Evaluation: evaluateReconciliation is pure and must get recall, precision, and
 *     the false-merge count — the one number `RECONCILIATION_ARCHITECTURE.md §8` says
 *     can veto a release — exactly right against a hand-built matcher, before it is ever
 *     pointed at the real one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand } from "@/lib/store.ts";
import { createSimplificationRun, dismissSimplificationFinding } from "@/lib/simplify/runs.ts";
import { evaluateReconciliation, snapshotAdjudication } from "@/lib/dedup/labels.ts";

async function labelsFor(db, projectId) {
  const rows = await db.prepare("SELECT * FROM reconciliation_labels WHERE project_id = ? ORDER BY created_at").bind(projectId).all();
  return rows.results;
}

// ── Capture ──────────────────────────────────────────────────────────────────────────

test("merging two items writes a positive, high-confidence label", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Add caching to the report endpoint", "w1");
  const loser = await createItem(db, projectId, "Cache the report endpoint response", "l1");
  await executeCommand(db, principal, { action: "merge_items", projectId, winnerItemId: winner, loserItemId: loser, idempotencyKey: "m1" });

  const labels = await labelsFor(db, projectId);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].verdict, "same");
  assert.equal(labels[0].confidence, "high");
  assert.equal(labels[0].label_source, "merge");
  assert.ok([labels[0].left_item_id, labels[0].right_item_id].includes(winner));
  assert.ok([labels[0].left_item_id, labels[0].right_item_id].includes(loser));
  assert.ok(JSON.parse(labels[0].features).method);
});

test("splitting a merge-created alias writes a negative label for the restored pair", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Add caching to the report endpoint", "w2");
  const loser = await createItem(db, projectId, "Cache the report endpoint response", "l2");
  await executeCommand(db, principal, { action: "merge_items", projectId, winnerItemId: winner, loserItemId: loser, idempotencyKey: "m2" });
  const alias = await db.prepare("SELECT id FROM work_item_aliases WHERE archived_work_item_id = ?").bind(loser).first();

  await executeCommand(db, principal, { action: "split_alias", projectId, aliasId: alias.id, idempotencyKey: "s2" });

  const labels = await labelsFor(db, projectId);
  assert.equal(labels.length, 2, "the merge's positive label and the split's negative label are both preserved");
  const split = labels.find((label) => label.label_source === "split");
  assert.ok(split, "the split must be captured too");
  assert.equal(split.verdict, "different");
  assert.equal(split.confidence, "high");
  assert.ok([split.left_item_id, split.right_item_id].includes(winner));
  assert.ok([split.left_item_id, split.right_item_id].includes(loser));
});

test("splitting a fingerprint-matched alias (never a merge) also writes a negative label", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { createWorkItemsDeduplicated } = await import("@/lib/store.ts");
  const first = await createWorkItemsDeduplicated(db, principal, { projectId, idempotencyKey: "batch-1", proposals: [{ title: "Add rate limiting to /api/login" }] });
  const second = await createWorkItemsDeduplicated(db, principal, { projectId, idempotencyKey: "batch-2", proposals: [{ title: "Add rate limiting to /api/login" }] });
  assert.equal(second.results[0].status, "matched");
  const targetId = first.results[0].workItemId;
  const alias = await db.prepare("SELECT id FROM work_item_aliases WHERE work_item_id = ?").bind(targetId).first();

  const result = await executeCommand(db, principal, { action: "split_alias", projectId, aliasId: alias.id, idempotencyKey: "s3" });

  const labels = await labelsFor(db, projectId);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].verdict, "different");
  assert.equal(labels[0].label_source, "split");
  assert.ok([labels[0].left_item_id, labels[0].right_item_id].includes(targetId));
  assert.ok([labels[0].left_item_id, labels[0].right_item_id].includes(result.itemId));
});

test("dismissing a duplicate finding writes a negative label at weak confidence", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Rotate signing keys", "w3");
  await createItem(db, projectId, "Rotate signing keys", "l3"); // identical -> fingerprint duplicate
  const run = await createSimplificationRun(db, principal, { projectId });
  const duplicate = run.findings.find((finding) => finding.kind === "duplicate");
  assert.ok(duplicate, "setup must actually produce a duplicate finding");

  await dismissSimplificationFinding(db, principal, { findingId: duplicate.id });

  const labels = await labelsFor(db, projectId);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].verdict, "different");
  assert.equal(labels[0].confidence, "weak", "a dismissal is weaker evidence than an explicit split");
  assert.equal(labels[0].label_source, "dismissal");
});

test("dismissing a non-pair finding (blocked_chain, stale, ...) writes no label at all", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const blocker = await createItem(db, projectId, "Prerequisite", "b1");
  const blocked = await createItem(db, projectId, "Waits on the prerequisite", "b2");
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: blocker, toWorkItemId: blocked, type: "blocks", idempotencyKey: "dep1" });
  const run = await createSimplificationRun(db, principal, { projectId });
  const chain = run.findings.find((finding) => finding.kind === "blocked_chain");
  assert.ok(chain, "setup must actually produce a blocked_chain finding");

  await dismissSimplificationFinding(db, principal, { findingId: chain.id });

  assert.deepEqual(await labelsFor(db, projectId), [], "a blocked_chain has no 'same work' pair to label");
});

test("dismissing an applied (already non-open) finding is rejected before any label is written", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Vendor the SDK", "w4");
  await createItem(db, projectId, "Vendor the SDK", "l4");
  const run = await createSimplificationRun(db, principal, { projectId });
  const duplicate = run.findings.find((finding) => finding.kind === "duplicate");
  const { applySimplificationFinding } = await import("@/lib/simplify/runs.ts");
  await applySimplificationFinding(db, principal, { findingId: duplicate.id });

  await assert.rejects(() => dismissSimplificationFinding(db, principal, { findingId: duplicate.id }), (error) => error.code === "NOT_FOUND");
  // The merge_items the apply ran already wrote its own positive label; dismissal must
  // not have added a second, contradictory one on top of it.
  const labels = await labelsFor(db, projectId);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].verdict, "same");
});

test("the same pair merged, then split, then merged again keeps only the first label of each kind", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Add caching to the report endpoint", "w5");
  const loser = await createItem(db, projectId, "Cache the report endpoint response", "l5");
  await executeCommand(db, principal, { action: "merge_items", projectId, winnerItemId: winner, loserItemId: loser, idempotencyKey: "m5a" });
  const alias = await db.prepare("SELECT id FROM work_item_aliases WHERE archived_work_item_id = ?").bind(loser).first();
  await executeCommand(db, principal, { action: "split_alias", projectId, aliasId: alias.id, idempotencyKey: "s5" });
  await executeCommand(db, principal, { action: "merge_items", projectId, winnerItemId: winner, loserItemId: loser, idempotencyKey: "m5b" });

  const labels = await labelsFor(db, projectId);
  // UNIQUE(project_id, pair_hash, label_source) keeps the first merge and the split; the
  // second merge is a duplicate of the same (project, pair, 'merge') key and is silently
  // absorbed rather than producing a contradictory third row.
  assert.equal(labels.length, 2);
  assert.equal(labels.filter((label) => label.label_source === "merge").length, 1);
  assert.equal(labels.filter((label) => label.label_source === "split").length, 1);
});

test("a failed merge (already-started work) never writes a label", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Task A", "w6");
  const loser = await createItem(db, projectId, "Task B", "l6");
  const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(loser).first();
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId: loser, expectedVersion: row.version, status: "planned", idempotencyKey: "p6" });
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId: loser, expectedVersion: row.version + 1, status: "ready", idempotencyKey: "r6" });
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId: loser, expectedVersion: row.version + 2, status: "in_progress", idempotencyKey: "i6" });

  await assert.rejects(() => executeCommand(db, principal, { action: "merge_items", projectId, winnerItemId: winner, loserItemId: loser, idempotencyKey: "m6" }));
  assert.deepEqual(await labelsFor(db, projectId), []);
});

// ── Evaluation ───────────────────────────────────────────────────────────────────────

function item(title) { return { title }; }
/** Trivial adjudicator standing in for the real matcher: collapses only literally
 * identical titles, everything else is 'possible'. Isolates evaluateReconciliation's own
 * arithmetic from lib/dedup/match.ts's actual rules. */
function toyAdjudicator(left, right) {
  if (left.title === right.title) return { verdict: "duplicate", score: 1, method: "fingerprint", reason: "identical" };
  return { verdict: "possible", score: 0.5, method: "lexical", reason: "similar" };
}

test("recall and precision are computed correctly against a small hand-built set", () => {
  const items = new Map([
    ["a1", item("same")], ["a2", item("same")], // labelled same, matcher agrees (true positive)
    ["b1", item("same")], ["b2", item("different")], // labelled same, matcher disagrees (miss)
    ["c1", item("x")], ["c2", item("x")], // labelled different, matcher would collapse (FALSE MERGE)
  ]);
  const labels = [
    { leftItemId: "a1", rightItemId: "a2", verdict: "same", confidence: "high", source: "merge" },
    { leftItemId: "b1", rightItemId: "b2", verdict: "same", confidence: "high", source: "merge" },
    { leftItemId: "c1", rightItemId: "c2", verdict: "different", confidence: "high", source: "split" },
  ];
  const report = evaluateReconciliation(labels, items, toyAdjudicator);

  assert.equal(report.total, 3);
  assert.equal(report.recall, 1 / 2, "1 of 2 'same' labels was actually collapsed");
  assert.equal(report.falseMerges, 1);
  assert.equal(report.falseMergeExamples[0].leftItemId, "c1");
});

test("false merges is exactly zero when the matcher agrees with every negative label", () => {
  const items = new Map([["a", item("x")], ["b", item("y")]]);
  const labels = [{ leftItemId: "a", rightItemId: "b", verdict: "different", confidence: "high", source: "split" }];
  const report = evaluateReconciliation(labels, items, toyAdjudicator);
  assert.equal(report.falseMerges, 0);
});

test("splitTrueDuplicates counts a 'same' label the matcher only calls possible", () => {
  const items = new Map([["a", item("rate limiting")], ["b", item("throttling")]]);
  const labels = [{ leftItemId: "a", rightItemId: "b", verdict: "same", confidence: "high", source: "merge" }];
  const report = evaluateReconciliation(labels, items, toyAdjudicator);
  assert.equal(report.splitTrueDuplicates, 1);
  assert.equal(report.recall, 0);
});

test("a label whose item no longer exists is skipped, not crashed on", () => {
  const items = new Map([["a", item("x")]]); // "b" is missing
  const labels = [{ leftItemId: "a", rightItemId: "b", verdict: "same", confidence: "high", source: "merge" }];
  const report = evaluateReconciliation(labels, items, toyAdjudicator);
  assert.equal(report.total, 0);
  assert.equal(report.recall, 1, "an empty denominator reads as perfect, not as a failure");
});

test("recall and precision on an empty golden set read as 1, not NaN or a crash", () => {
  const report = evaluateReconciliation([], new Map(), toyAdjudicator);
  assert.equal(report.total, 0);
  assert.equal(report.recall, 1);
  assert.equal(report.precision, 1);
  assert.equal(report.falseMerges, 0);
});

test("bySource breaks recall down per label source", () => {
  const items = new Map([["a1", item("x")], ["a2", item("x")], ["b1", item("y")], ["b2", item("z")]]);
  const labels = [
    { leftItemId: "a1", rightItemId: "a2", verdict: "same", confidence: "high", source: "merge" },
    { leftItemId: "b1", rightItemId: "b2", verdict: "same", confidence: "weak", source: "dismissal" },
  ];
  const report = evaluateReconciliation(labels, items, toyAdjudicator);
  assert.equal(report.bySource.merge.total, 1);
  assert.equal(report.bySource.merge.recall, 1);
  assert.equal(report.bySource.dismissal.total, 1);
  assert.equal(report.bySource.dismissal.recall, 0);
  assert.equal(report.bySource.split.total, 0);
});

test("evaluateReconciliation against the real matcher: the shipped vetoes produce zero false merges on an adversarial set", () => {
  // The exact pairs DEDUPLICATION_ARCHITECTURE.md's table warns embeddings get wrong —
  // if the real cascade ever regressed on these, this is where it would show up as a
  // false merge.
  const items = new Map([
    ["a1", { title: "Add rate limiting to /api/login" }],
    ["a2", { title: "Add rate limiting to /api/signup" }],
    ["b1", { title: "Add auth middleware" }],
    ["b2", { title: "Remove auth middleware" }],
  ]);
  const labels = [
    { leftItemId: "a1", rightItemId: "a2", verdict: "different", confidence: "high", source: "split" },
    { leftItemId: "b1", rightItemId: "b2", verdict: "different", confidence: "high", source: "split" },
  ];
  const report = evaluateReconciliation(labels, items, (left, right) => snapshotAdjudication(left, right));
  assert.equal(report.falseMerges, 0);
});
