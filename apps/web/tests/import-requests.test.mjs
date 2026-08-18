/**
 * "Import from a connected agent": asking one specific source to report everything it
 * knows about a project. Planbraid cannot reach into a live agent conversation (MCP
 * here is request/response with no server-to-client channel), so a request is durable
 * state resolved two ways — the agent's own next registerSourceSession call surfaces
 * it, or a create_work_items batch that names it closes it directly. These cover both
 * pickup points, the idempotent re-click behavior, and that a stray or stale id never
 * fails the batch that named it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createWorkItemsDeduplicated, organizationFor, registerSourceSession, requestImport } from "@/lib/store.ts";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";

const otherPrincipal = { userId: "u_intruder", email: "intruder@planbraid.local", displayName: "Someone Else" };

test("requesting import for the same project + source twice reuses the open request", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { sourceId } = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "conv-1" });

  const first = await requestImport(db, principal, { projectId, sourceId });
  assert.equal(first.status, "created");

  const second = await requestImport(db, principal, { projectId, sourceId });
  assert.equal(second.status, "already_pending");
  assert.equal(second.importRequestId, first.importRequestId);

  const org = await organizationFor(db, principal);
  const rows = await db.prepare("SELECT id FROM import_requests WHERE organization_id = ? AND status = 'pending'").bind(org).all();
  assert.equal(rows.results.length, 1, "re-clicking must not pile up duplicate pending requests");
});

test("registerSourceSession surfaces a pending request for that exact source, and none for another", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { sourceId: codexId } = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "conv-1" });
  await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "conv-2" });

  const requested = await requestImport(db, principal, { projectId, sourceId: codexId });

  const codexAgain = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "conv-1" });
  assert.equal(codexAgain.pendingImportRequest?.id, requested.importRequestId);

  const claudeAgain = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "conv-2" });
  assert.equal(claudeAgain.pendingImportRequest, null);
});

test("registerSourceSession: a genuinely empty project reports existingWork as null, not an empty summary", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const result = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "conv-empty" });
  assert.equal(result.existingWork, null);
});

test("registerSourceSession: a project with open work hands back a compact summary — the 'read the plan first' mechanism", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Add rate limiting to the login endpoint", "pre-existing-1");
  await createItem(db, projectId, "Fix the flaky CI job", "pre-existing-2");

  const result = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "conv-1" });
  assert.equal(result.existingWork.openItemCount, 2);
  assert.equal(result.existingWork.recent.length, 2);
  assert.ok(result.existingWork.recent.some((entry) => entry.title === "Add rate limiting to the login endpoint"));
  assert.match(result.existingWork.note, /read/i);
});

test("registerSourceSession: existingWork excludes done/cancelled work and only counts what's still open", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const doneId = await createItem(db, projectId, "Already finished this one", "pre-existing-done");
  await createItem(db, projectId, "Still open", "pre-existing-open");
  await db.prepare("UPDATE work_items SET status = 'done' WHERE id = ?").bind(doneId).run();

  const result = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "conv-2" });
  assert.equal(result.existingWork.openItemCount, 1);
  assert.ok(!result.existingWork.recent.some((entry) => entry.title === "Already finished this one"));
});

test("registerSourceSession: existingWork is present again on a reconnect (idempotent replay), not only on first registration", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Pre-existing work", "pre-existing-3");
  await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "conv-3" });

  const reconnect = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "conv-3" });
  assert.equal(reconnect.idempotentReplay, true);
  assert.equal(reconnect.existingWork.openItemCount, 1);
});

test("create_work_items naming the request completes it with the reported count", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { sourceId } = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "conv-1" });
  const { importRequestId } = await requestImport(db, principal, { projectId, sourceId });

  await createWorkItemsDeduplicated(db, principal, {
    projectId, sourceId, importRequestId, idempotencyKey: "import-batch-1",
    proposals: [{ title: "Add rate limiting to the public API" }, { title: "Write onboarding docs" }],
  });

  const org = await organizationFor(db, principal);
  const row = await db.prepare("SELECT status, reported_count FROM import_requests WHERE id = ? AND organization_id = ?").bind(importRequestId, org).first();
  assert.equal(row.status, "completed");
  assert.equal(row.reported_count, 2);

  const event = await db.prepare("SELECT event_type, summary FROM work_events WHERE organization_id = ? AND event_type = 'import.completed'").bind(org).first();
  assert.ok(event, "an import.completed activity event should be recorded");
  assert.match(event.summary, /imported 2 tasks/);

  // Resolved, so a fresh click starts a new request rather than reusing the closed one.
  const again = await requestImport(db, principal, { projectId, sourceId });
  assert.equal(again.status, "created");
  assert.notEqual(again.importRequestId, importRequestId);
});

test("a mismatched or already-resolved import_request_id is a silent no-op, not a batch failure", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { sourceId } = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "conv-1" });

  // Stray id from an old, already-used prompt: nothing to resolve, but the batch itself
  // must still succeed.
  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, sourceId, importRequestId: "imp_does_not_exist", idempotencyKey: "import-batch-2",
    proposals: [{ title: "Some task reported anyway" }],
  });
  assert.equal(outcome.summary.created, 1);
});

test("requestImport rejects a source that belongs to someone else's project", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const { sourceId } = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "conv-1" });

  await assert.rejects(
    requestImport(db, otherPrincipal, { projectId, sourceId }),
    (error) => { assert.equal(error.code, "NOT_FOUND"); return true; },
  );
});
