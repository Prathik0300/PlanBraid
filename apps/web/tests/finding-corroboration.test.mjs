/**
 * F10 — Simplify finding corroboration.
 *
 * `simplification_findings.agreed_by`/`origin` existed since the schema was designed,
 * with a comment describing "a connected agent contributes to the same run on its next
 * turn" — and nothing ever wrote either column; every insert hardcoded 'matcher' and '[]'.
 * These tests are built around the two things reportSimplificationFinding has to get
 * right: corroborating an existing finding must never touch its proposedCommand (only the
 * structural matcher may hand a person something to click), and a genuinely new
 * agent-reported finding must never carry one either.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand, organizationFor } from "@/lib/store.ts";
import { createSimplificationRun, readSimplificationRun, reportSimplificationFinding } from "@/lib/simplify/runs.ts";

async function sourceFor(db, projectId, provider, externalId) {
  const organizationId = await organizationFor(db, principal);
  const row = await db.prepare("INSERT INTO sources (id, organization_id, project_id, provider, external_id, title) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(`src_${externalId}`, organizationId, projectId, provider, externalId, provider).first();
  return row.id;
}

test("corroborating an existing structural finding adds the agent's provider family, once", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Add caching to the report endpoint", "w1");
  const loser = await createItem(db, projectId, "Add caching to the report endpoint", "l1"); // identical -> fingerprint duplicate
  const run = await createSimplificationRun(db, principal, { projectId });
  const duplicate = run.findings.find((finding) => finding.kind === "duplicate" && finding.workItemId === loser);
  assert.ok(duplicate, "setup must actually produce a duplicate finding to corroborate");
  assert.deepEqual(duplicate.agreedBy, [], "nothing has corroborated it yet");

  const codex = await sourceFor(db, projectId, "codex", "c1");
  const result = await reportSimplificationFinding(db, principal, { projectId, kind: "duplicate", workItemId: loser, relatedWorkItemId: winner, reason: "same task", sourceId: codex });
  assert.equal(result.status, "corroborated");
  assert.deepEqual(result.agreedBy, ["codex"]);

  // Calling it again with the same agent must not double-count.
  const again = await reportSimplificationFinding(db, principal, { projectId, kind: "duplicate", workItemId: loser, relatedWorkItemId: winner, reason: "same task", sourceId: codex });
  assert.equal(again.status, "already_corroborated");
  assert.deepEqual(again.agreedBy, ["codex"]);

  const refreshed = await readSimplificationRun(db, principal, { runId: run.id });
  const refreshedFinding = refreshed.findings.find((finding) => finding.id === duplicate.id);
  assert.deepEqual(refreshedFinding.agreedBy, ["codex"]);
});

test("corroboration never touches the finding's proposedCommand", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Rotate the signing keys", "w2");
  const loser = await createItem(db, projectId, "Rotate the signing keys", "l2");
  const run = await createSimplificationRun(db, principal, { projectId });
  const duplicate = run.findings.find((finding) => finding.kind === "duplicate" && finding.workItemId === loser);
  const originalCommand = JSON.stringify(duplicate.proposedCommand);

  const claude = await sourceFor(db, projectId, "claude", "c2");
  await reportSimplificationFinding(db, principal, { projectId, kind: "duplicate", workItemId: loser, relatedWorkItemId: winner, reason: "same task", sourceId: claude });

  const row = await db.prepare("SELECT proposed_command FROM simplification_findings WHERE id = ?").bind(duplicate.id).first();
  assert.equal(row.proposed_command, originalCommand, "corroboration must not alter the command a merge would run");
});

test("two different models both corroborating accumulates both, in order", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Vendor the internal SDK", "w3");
  const loser = await createItem(db, projectId, "Vendor the internal SDK", "l3");
  const run = await createSimplificationRun(db, principal, { projectId });
  const duplicate = run.findings.find((finding) => finding.kind === "duplicate" && finding.workItemId === loser);
  assert.ok(duplicate, "setup must actually produce a duplicate finding to corroborate");

  const claude = await sourceFor(db, projectId, "claude", "c3");
  const codex = await sourceFor(db, projectId, "codex", "x3");
  const first = await reportSimplificationFinding(db, principal, { projectId, kind: "duplicate", workItemId: loser, relatedWorkItemId: winner, reason: "r1", sourceId: claude });
  const second = await reportSimplificationFinding(db, principal, { projectId, kind: "duplicate", workItemId: loser, relatedWorkItemId: winner, reason: "r2", sourceId: codex });

  assert.equal(first.findingId, duplicate.id);
  assert.deepEqual(second.agreedBy, ["claude", "codex"]);
});

test("two accounts of one model corroborating is still one family, not two", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Add a health check to /api/status", "w4");
  const loser = await createItem(db, projectId, "Add a health check to /api/status", "l4");
  const run = await createSimplificationRun(db, principal, { projectId });
  const duplicate = run.findings.find((finding) => finding.kind === "duplicate" && finding.workItemId === loser);
  assert.ok(duplicate, "setup must actually produce a duplicate finding to corroborate");

  const claudeWork = await sourceFor(db, projectId, "claude", "c4a");
  const claudePersonal = await sourceFor(db, projectId, "claude-code", "c4b");
  const first = await reportSimplificationFinding(db, principal, { projectId, kind: "duplicate", workItemId: loser, relatedWorkItemId: winner, reason: "r1", sourceId: claudeWork });
  const second = await reportSimplificationFinding(db, principal, { projectId, kind: "duplicate", workItemId: loser, relatedWorkItemId: winner, reason: "r2", sourceId: claudePersonal });
  assert.equal(first.findingId, duplicate.id);

  assert.deepEqual(second.agreedBy, ["claude"], "two logins for one model must count once, matching how getReadyWork counts corroboration");
});

test("reporting something new that matches nothing creates an informational, agent-originated finding", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Something worth a second look", "n1");
  await createSimplificationRun(db, principal, { projectId }); // establishes the run to report against

  const gemini = await sourceFor(db, projectId, "gemini", "g1");
  const result = await reportSimplificationFinding(db, principal, { projectId, kind: "agent_flagged", workItemId: itemId, reason: "This duplicates work in another repo", sourceId: gemini });
  assert.equal(result.status, "created");

  const row = await db.prepare("SELECT * FROM simplification_findings WHERE id = ?").bind(result.findingId).first();
  assert.equal(row.origin, "agent");
  assert.equal(row.proposed_command, null, "an agent-originated finding must never carry a command a person could click to apply");
  assert.equal(JSON.parse(row.agreed_by)[0], "gemini");
});

test("an agent-originated finding cannot be applied — nothing here does anything until a person decides to", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Flagged, not actionable", "n2");
  await createSimplificationRun(db, principal, { projectId });
  const gemini = await sourceFor(db, projectId, "gemini", "g2");
  const result = await reportSimplificationFinding(db, principal, { projectId, kind: "agent_flagged", workItemId: itemId, reason: "worth a look", sourceId: gemini });

  const { applySimplificationFinding } = await import("@/lib/simplify/runs.ts");
  await assert.rejects(() => applySimplificationFinding(db, principal, { findingId: result.findingId }), (error) => error.code === "VALIDATION_FAILED");
});

test("reporting with no existing run creates one first, so the report lands beside a full structural pass", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Add rate limiting to /api/login", "w5");
  const loser = await createItem(db, projectId, "Add rate limiting to /api/login", "l5");
  const gemini = await sourceFor(db, projectId, "gemini", "g3");

  assert.equal(await readSimplificationRun(db, principal, { projectId }), null, "no run exists yet");
  const result = await reportSimplificationFinding(db, principal, { projectId, kind: "duplicate", workItemId: loser, relatedWorkItemId: winner, reason: "same login endpoint", sourceId: gemini });
  assert.equal(result.status, "corroborated", "a real structural pass must have already found this duplicate, so the report corroborates rather than duplicates it");

  const run = await readSimplificationRun(db, principal, { projectId });
  assert.ok(run.findings.length >= 1);
});

test("a finding already applied cannot be corroborated into reappearing as open", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Cache the dashboard summary", "w6");
  const loser = await createItem(db, projectId, "Cache the dashboard summary", "l6");
  const run = await createSimplificationRun(db, principal, { projectId });
  const duplicate = run.findings.find((finding) => finding.kind === "duplicate" && finding.workItemId === loser);

  const { applySimplificationFinding } = await import("@/lib/simplify/runs.ts");
  await applySimplificationFinding(db, principal, { findingId: duplicate.id });

  const codex = await sourceFor(db, projectId, "codex", "x6");
  const result = await reportSimplificationFinding(db, principal, { projectId, kind: "duplicate", workItemId: loser, relatedWorkItemId: winner, reason: "same task", sourceId: codex });
  // UNIQUE(run_id, dedupe_key) admits only one row for this pair, ever, regardless of
  // status — so this must neither reopen the applied finding nor silently pretend a new
  // one was created (which would misreport a no-op insert as having done something).
  assert.equal(result.status, "already_resolved");
  assert.equal(result.resolution, "applied");
  assert.equal(result.findingId, duplicate.id);
});

test("reporting without a source_id is recorded as an unknown family rather than crashing", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "No source given", "n3");
  await createSimplificationRun(db, principal, { projectId });
  const result = await reportSimplificationFinding(db, principal, { projectId, kind: "agent_flagged", workItemId: itemId, reason: "no source" });
  assert.deepEqual(result.agreedBy, ["unknown"]);
});

test("corroboration is scoped to the project's own run and cannot cross into another project", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, principal, { action: "create_project", name: "Other", idempotencyKey: "fc-p2" })).projectId;
  const itemInB = await createItem(db, projectB, "Task in the other project", "b1");
  await createSimplificationRun(db, principal, { projectId: projectA });

  const codex = await sourceFor(db, projectB, "codex", "x7");
  const result = await reportSimplificationFinding(db, principal, { projectId: projectB, kind: "agent_flagged", workItemId: itemInB, reason: "flagged in B", sourceId: codex });

  const runA = await readSimplificationRun(db, principal, { projectId: projectA });
  assert.ok(!runA.findings.some((finding) => finding.id === result.findingId), "a finding reported for project B must never appear on project A's run");
});
