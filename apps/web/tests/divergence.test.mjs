/**
 * M17 — divergence detection.
 *
 * possibly_implemented is pure (lib/simplify/analyze.ts): everything it needs is already
 * in items+evidence, since M15's ingestRepoObservation only ever writes commit-type
 * evidence when a real artifact match happened. evidence_removed is not pure
 * (lib/simplify/divergence.ts) because telling "deleted" from "merely edited" needs
 * repo_observations' deleted_paths, which sits outside DashboardState on purpose. Both
 * are informational findings that still carry a proposedCommand — a deliberate departure
 * from every other informational kind in this pipeline, which the roadmap states
 * explicitly ("propose a transition the user applies, never automatic").
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject } from "./support/fixtures.mjs";
import { executeCommand, organizationFor } from "@/lib/store.ts";
import { findPossiblyImplemented } from "@/lib/simplify/analyze.ts";
import { findEvidenceRemoved } from "@/lib/simplify/divergence.ts";
import { ingestRepoObservation } from "@/lib/evidence/ingest.ts";
import { applySimplificationFinding, createSimplificationRun } from "@/lib/simplify/runs.ts";
import { loadProjectView } from "@/lib/read/project-view.ts";

async function plannedItem(db, projectId, title, key) {
  const created = await executeCommand(db, principal, { action: "create_item", projectId, title, idempotencyKey: `item-${key}` });
  const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(created.itemId).first();
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId: created.itemId, expectedVersion: row.version, status: "planned", idempotencyKey: `${key}-planned` });
  return created.itemId;
}

async function doneItem(db, projectId, title, key) {
  const created = await executeCommand(db, principal, { action: "create_item", projectId, title, idempotencyKey: `item-${key}` });
  let version = (await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(created.itemId).first()).version;
  for (const status of ["planned", "ready", "in_progress", "done"]) {
    await executeCommand(db, principal, { action: "transition_item", projectId, itemId: created.itemId, expectedVersion: version, status, idempotencyKey: `${key}-${status}` });
    version += 1;
  }
  return created.itemId;
}

async function view(db, projectId) {
  const organizationId = await organizationFor(db, principal);
  return loadProjectView(db, organizationId, projectId, { items: true });
}

test("possibly_implemented: a planned item touched by a commit after it was proposed is flagged", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await plannedItem(db, projectId, "Migrate store.ts to RS256", "pi1");
  await ingestRepoObservation(db, principal, { projectId, headSha: "a".repeat(40), changedPaths: ["apps/web/lib/store.ts"] });

  const { workItems } = await view(db, projectId);
  const evidenceRows = await db.prepare("SELECT * FROM evidence WHERE work_item_id = ?").bind(itemId).all();
  const evidence = evidenceRows.results.map((row) => ({ workItemId: row.work_item_id, type: row.type, label: row.label, createdAt: row.created_at }));

  const findings = findPossiblyImplemented(workItems, evidence);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].workItemId, itemId);
  assert.equal(findings[0].proposedCommand.action, "transition_item");
  assert.equal(findings[0].proposedCommand.status, "ready");
});

test("possibly_implemented: a planned item never touched by any commit is not flagged", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await plannedItem(db, projectId, "Untouched work", "pi2");
  const { workItems } = await view(db, projectId);
  assert.deepEqual(findPossiblyImplemented(workItems, []), []);
});

test("possibly_implemented: evidence recorded before the item was even proposed does not count", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await plannedItem(db, projectId, "Migrate store.ts to RS256", "pi3");
  const item = (await view(db, projectId)).workItems.find((entry) => entry.id === itemId);
  const evidence = [{ workItemId: itemId, type: "commit", label: "old", createdAt: new Date(new Date(item.createdAt).getTime() - 60000).toISOString() }];
  assert.deepEqual(findPossiblyImplemented([item], evidence), []);
});

test("possibly_implemented: a done item is never flagged, only planned ones", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await doneItem(db, projectId, "Migrate store.ts to RS256", "pi4");
  const item = (await view(db, projectId)).workItems.find((entry) => entry.id === itemId);
  const evidence = [{ workItemId: itemId, type: "commit", label: "later", createdAt: new Date(Date.now() + 60000).toISOString() }];
  assert.deepEqual(findPossiblyImplemented([item], evidence), []);
});

test("possibly_implemented: non-commit evidence (an agent's own claim) does not count", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await plannedItem(db, projectId, "Some task", "pi5");
  const item = (await view(db, projectId)).workItems.find((entry) => entry.id === itemId);
  const evidence = [{ workItemId: itemId, type: "agent_claim", label: "trust me", createdAt: new Date(Date.now() + 60000).toISOString() }];
  assert.deepEqual(findPossiblyImplemented([item], evidence), []);
});

test("evidence_removed: a done item whose evidenced file is later deleted is flagged", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const itemId = await doneItem(db, projectId, "Migrate store.ts to RS256", "er1");
  await ingestRepoObservation(db, principal, { projectId, headSha: "b".repeat(40), changedPaths: ["apps/web/lib/store.ts"] });
  // Two observations issued back to back can land in the same millisecond under
  // Postgres's now(), which would make the ordering this finding depends on
  // indeterminate. Backdating the evidencing one is what makes "later" unambiguous here.
  await db.prepare("UPDATE repo_observations SET created_at = now() - interval '1 hour' WHERE project_id = ?").bind(projectId).run();
  await db.prepare("UPDATE evidence SET created_at = now() - interval '1 hour' WHERE work_item_id = ?").bind(itemId).run();
  await ingestRepoObservation(db, principal, { projectId, headSha: "c".repeat(40), changedPaths: ["apps/web/lib/store.ts"], deletedPaths: ["apps/web/lib/store.ts"] });

  const { workItems } = await view(db, projectId);
  const evidenceRows = (await db.prepare("SELECT * FROM evidence WHERE work_item_id = ?").bind(itemId).all()).results;
  const evidence = evidenceRows.map((row) => ({ workItemId: row.work_item_id, type: row.type, label: row.label, createdAt: row.created_at }));

  const findings = await findEvidenceRemoved(db, organizationId, projectId, workItems, evidence);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].workItemId, itemId);
  assert.equal(findings[0].proposedCommand.status, "ready");
});

test("evidence_removed: a deletion that happened before the evidence was recorded does not count", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const itemId = await doneItem(db, projectId, "Migrate store.ts to RS256", "er2");
  await ingestRepoObservation(db, principal, { projectId, headSha: "d".repeat(40), changedPaths: ["apps/web/lib/store.ts"], deletedPaths: ["apps/web/lib/store.ts"] });
  await db.prepare("UPDATE repo_observations SET created_at = now() - interval '1 hour' WHERE project_id = ?").bind(projectId).run();
  await ingestRepoObservation(db, principal, { projectId, headSha: "e".repeat(40), changedPaths: ["apps/web/lib/store.ts"] });

  const { workItems } = await view(db, projectId);
  const evidenceRows = (await db.prepare("SELECT * FROM evidence WHERE work_item_id = ?").bind(itemId).all()).results;
  const evidence = evidenceRows.map((row) => ({ workItemId: row.work_item_id, type: row.type, label: row.label, createdAt: row.created_at }));

  const findings = await findEvidenceRemoved(db, organizationId, projectId, workItems, evidence);
  assert.deepEqual(findings, []);
});

test("evidence_removed: a done item with no commit evidence at all is never flagged, even if something with the same artifact was deleted", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const itemId = await doneItem(db, projectId, "Migrate store.ts to RS256", "er3");
  await ingestRepoObservation(db, principal, { projectId, headSha: "f".repeat(40), changedPaths: ["apps/web/lib/store.ts"], deletedPaths: ["apps/web/lib/store.ts"] });

  const { workItems } = await view(db, projectId);
  const findings = await findEvidenceRemoved(db, organizationId, projectId, workItems, []);
  assert.deepEqual(findings, []);
  void itemId;
});

test("evidence_removed: a plain modification (not a deletion) of the same file never triggers this finding", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const itemId = await doneItem(db, projectId, "Migrate store.ts to RS256", "er4");
  await ingestRepoObservation(db, principal, { projectId, headSha: "1".repeat(40), changedPaths: ["apps/web/lib/store.ts"] });
  await ingestRepoObservation(db, principal, { projectId, headSha: "2".repeat(40), changedPaths: ["apps/web/lib/store.ts"] });

  const { workItems } = await view(db, projectId);
  const evidenceRows = (await db.prepare("SELECT * FROM evidence WHERE work_item_id = ?").bind(itemId).all()).results;
  const evidence = evidenceRows.map((row) => ({ workItemId: row.work_item_id, type: row.type, label: row.label, createdAt: row.created_at }));

  const findings = await findEvidenceRemoved(db, organizationId, projectId, workItems, evidence);
  assert.deepEqual(findings, []);
});

test("evidence_removed: an observation in a different project never crosses over", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, principal, { action: "create_project", name: "Other", idempotencyKey: "er5-proj" })).projectId;
  const organizationId = await organizationFor(db, principal);
  const itemId = await doneItem(db, projectA, "Migrate store.ts to RS256", "er5");
  await ingestRepoObservation(db, principal, { projectId: projectA, headSha: "3".repeat(40), changedPaths: ["apps/web/lib/store.ts"] });
  await ingestRepoObservation(db, principal, { projectId: projectB, headSha: "4".repeat(40), changedPaths: ["apps/web/lib/store.ts"], deletedPaths: ["apps/web/lib/store.ts"] });

  const { workItems } = await view(db, projectA);
  const evidenceRows = (await db.prepare("SELECT * FROM evidence WHERE work_item_id = ?").bind(itemId).all()).results;
  const evidence = evidenceRows.map((row) => ({ workItemId: row.work_item_id, type: row.type, label: row.label, createdAt: row.created_at }));

  const findings = await findEvidenceRemoved(db, organizationId, projectA, workItems, evidence);
  assert.deepEqual(findings, []);
});

test("integration: createSimplificationRun surfaces both divergence kinds, and applying one moves the item to ready", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const plannedId = await plannedItem(db, projectId, "Migrate store.ts to RS256", "int1");
  await ingestRepoObservation(db, principal, { projectId, headSha: "5".repeat(40), changedPaths: ["apps/web/lib/store.ts"] });

  const doneId = await doneItem(db, projectId, "Rotate secrets.env values", "int2");
  await ingestRepoObservation(db, principal, { projectId, headSha: "6".repeat(40), changedPaths: ["config/secrets.env"] });
  await db.prepare("UPDATE repo_observations SET created_at = now() - interval '1 hour' WHERE project_id = ? AND head_sha = ?").bind(projectId, "6".repeat(40)).run();
  await db.prepare("UPDATE evidence SET created_at = now() - interval '1 hour' WHERE work_item_id = ?").bind(doneId).run();
  await ingestRepoObservation(db, principal, { projectId, headSha: "7".repeat(40), changedPaths: ["config/secrets.env"], deletedPaths: ["config/secrets.env"] });

  const run = await createSimplificationRun(db, principal, { projectId });
  const possiblyImplemented = run.findings.find((finding) => finding.kind === "possibly_implemented");
  const evidenceRemoved = run.findings.find((finding) => finding.kind === "evidence_removed");
  assert.ok(possiblyImplemented, "expected a possibly_implemented finding");
  assert.equal(possiblyImplemented.workItemId, plannedId);
  assert.ok(evidenceRemoved, "expected an evidence_removed finding");
  assert.equal(evidenceRemoved.workItemId, doneId);

  await applySimplificationFinding(db, principal, { findingId: possiblyImplemented.id });
  const row = await db.prepare("SELECT status FROM work_items WHERE id = ?").bind(plannedId).first();
  assert.equal(row.status, "ready");
});
