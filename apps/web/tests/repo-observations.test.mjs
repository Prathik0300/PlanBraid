/**
 * M15 — repository observations via the bridge.
 *
 * The one distinction these tests are built around: a commit touching a file is not proof
 * the file is correct, so evidence only ever reads `result: "verified"` when a
 * verification command actually ran and exited zero. Everything else — a bare touch, a
 * failing command — attaches real evidence (the observation happened) without claiming
 * more than that, because lib/trust/confidence.ts treats "verified" as its strongest tier
 * and a false one there is exactly the fabricated trust signal M9 exists to prevent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand } from "@/lib/store.ts";
import { ingestRepoObservation } from "@/lib/evidence/ingest.ts";

test("a commit touching an item's known file attaches unverified evidence when no verification command ran", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Fix a bug in store.ts", "ro1");

  const result = await ingestRepoObservation(db, principal, { projectId, headSha: "a".repeat(40), changedPaths: ["apps/web/lib/store.ts"] });
  assert.deepEqual(result.matchedItemIds, [itemId]);

  const evidence = await db.prepare("SELECT type, label, result FROM evidence WHERE work_item_id = ?").bind(itemId).first();
  assert.equal(evidence.type, "commit");
  assert.equal(evidence.result, null, "a touch with no verification command must never be marked verified");
  assert.match(evidence.label, /apps\/web\/lib\/store\.ts/);

  const item = await db.prepare("SELECT completion_confidence FROM work_items WHERE id = ?").bind(itemId).first();
  assert.equal(item.completion_confidence, "supported");
});

test("a passing verification command marks matched evidence verified", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Fix a bug in store.ts", "ro2");

  await ingestRepoObservation(db, principal, { projectId, headSha: "b".repeat(40), changedPaths: ["apps/web/lib/store.ts"], verificationCommand: "npm test", verificationExitCode: 0 });

  const evidence = await db.prepare("SELECT result FROM evidence WHERE work_item_id = ?").bind(itemId).first();
  assert.equal(evidence.result, "verified");
});

test("a failing verification command marks matched evidence failed, not verified", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Fix a bug in store.ts", "ro3");

  await ingestRepoObservation(db, principal, { projectId, headSha: "c".repeat(40), changedPaths: ["apps/web/lib/store.ts"], verificationCommand: "npm test", verificationExitCode: 1 });

  const evidence = await db.prepare("SELECT result FROM evidence WHERE work_item_id = ?").bind(itemId).first();
  assert.equal(evidence.result, "failed");
});

test("reporting the same commit twice is idempotent: no duplicate observation, no duplicate evidence", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Fix a bug in store.ts", "ro4");
  const headSha = "d".repeat(40);

  const first = await ingestRepoObservation(db, principal, { projectId, headSha, changedPaths: ["apps/web/lib/store.ts"] });
  const second = await ingestRepoObservation(db, principal, { projectId, headSha, changedPaths: ["apps/web/lib/store.ts"] });

  assert.equal(first.idempotentReplay, false);
  assert.equal(second.idempotentReplay, true);
  assert.equal(first.observationId, second.observationId);

  const observationCount = await db.prepare("SELECT COUNT(*) AS count FROM repo_observations WHERE project_id = ? AND head_sha = ?").bind(projectId, headSha).first();
  assert.equal(Number(observationCount.count), 1);
  const evidenceCount = await db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE work_item_id = ?").bind(itemId).first();
  assert.equal(Number(evidenceCount.count), 1);
});

test("a commit that touches nothing an item mentions attaches to nothing", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Fix a bug in store.ts", "ro5");

  const result = await ingestRepoObservation(db, principal, { projectId, headSha: "e".repeat(40), changedPaths: ["apps/web/lib/unrelated-file.ts"] });
  assert.deepEqual(result.matchedItemIds, []);
});

test("a changed path is matched by suffix, so a short artifact still catches a long repo-relative path", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Fix a bug in store.ts", "ro6");

  const result = await ingestRepoObservation(db, principal, { projectId, headSha: "f".repeat(40), changedPaths: ["some/deeply/nested/path/store.ts"] });
  assert.deepEqual(result.matchedItemIds, [itemId]);
});

test("a false-suffix path (ends with the artifact's letters but not as a path segment) does not match", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Fix a bug in store.ts", "ro7");

  const result = await ingestRepoObservation(db, principal, { projectId, headSha: "1".repeat(40), changedPaths: ["backingstore.ts"] });
  assert.deepEqual(result.matchedItemIds, []);
});

test("an observation in a different project never matches this project's items", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, principal, { action: "create_project", name: "Other", idempotencyKey: "ro8-proj" })).projectId;
  await createItem(db, projectA, "Fix a bug in store.ts", "ro8");

  const result = await ingestRepoObservation(db, principal, { projectId: projectB, headSha: "2".repeat(40), changedPaths: ["apps/web/lib/store.ts"] });
  assert.deepEqual(result.matchedItemIds, []);
});

test("the observation row records commit metadata: sha, branch, and changed paths", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await ingestRepoObservation(db, principal, { projectId, headSha: "3".repeat(40), branch: "main", changedPaths: ["a.ts", "b.ts"], verificationCommand: "npm test", verificationExitCode: 0 });

  const row = await db.prepare("SELECT branch, changed_paths, verification_command, verification_exit_code FROM repo_observations WHERE project_id = ? AND head_sha = ?").bind(projectId, "3".repeat(40)).first();
  assert.equal(row.branch, "main");
  assert.deepEqual(JSON.parse(row.changed_paths), ["a.ts", "b.ts"]);
  assert.equal(row.verification_command, "npm test");
  assert.equal(Number(row.verification_exit_code), 0);
});

test("a deleted path never attaches commit evidence for itself, even though it is also listed in changed_paths", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Fix a bug in store.ts", "ro9");

  const result = await ingestRepoObservation(db, principal, { projectId, headSha: "5".repeat(40), changedPaths: ["apps/web/lib/store.ts"], deletedPaths: ["apps/web/lib/store.ts"] });
  assert.deepEqual(result.matchedItemIds, [], "a deletion is not positive evidence and must not attach commit evidence for the deleted path");
  const evidenceCount = await db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE work_item_id = ?").bind(itemId).first();
  assert.equal(Number(evidenceCount.count), 0);
});

test("a commit that both touches one file and deletes another still attaches evidence for the untouched-by-deletion one", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Fix a bug in store.ts and signature.ts", "ro10");

  const result = await ingestRepoObservation(db, principal, { projectId, headSha: "6".repeat(40), changedPaths: ["apps/web/lib/store.ts", "apps/web/lib/signature.ts"], deletedPaths: ["apps/web/lib/store.ts"] });
  assert.deepEqual(result.matchedItemIds, [itemId]);
  const evidence = await db.prepare("SELECT label FROM evidence WHERE work_item_id = ?").bind(itemId).first();
  assert.match(evidence.label, /signature\.ts/);
  assert.doesNotMatch(evidence.label, /store\.ts/);
});

test("an observation with no changed paths at all is recorded but matches nothing, without crashing", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const result = await ingestRepoObservation(db, principal, { projectId, headSha: "4".repeat(40), changedPaths: [] });
  assert.deepEqual(result.matchedItemIds, []);
  assert.ok(result.observationId);
});
