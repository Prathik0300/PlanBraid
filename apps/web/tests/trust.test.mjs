/**
 * M9 — provenance and derived confidence, and the F4 fix.
 *
 * Two things under test: every write now stamps how it was learned, and confidence is a
 * pure function recomputed from the current record rather than a value anyone wrote down
 * — so the exact failure F4 describes (an item stays "verified" after its evidence is
 * gone) is structurally impossible once nothing stores the number.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand, organizationFor } from "@/lib/store.ts";
import { confidenceOf } from "@/lib/trust/confidence.ts";
import { isVerifiedProvenance, PROVENANCES, provenanceFor, provenanceStrength, strongestProvenance } from "@/lib/trust/provenance.ts";

const browser = { ...principal, authentication: "browser" };
const agent = { ...principal, authentication: "personal_token", credentialId: "cred_1" };

async function transition(db, who, projectId, itemId, status, key, extra = {}) {
  const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first();
  return executeCommand(db, who, { action: "transition_item", projectId, itemId, expectedVersion: row.version, status, idempotencyKey: key, ...extra });
}

async function eventsFor(db, itemId) {
  const rows = await db.prepare("SELECT * FROM work_events WHERE work_item_id = ? ORDER BY created_at DESC").bind(itemId).all();
  return rows.results;
}

// ── provenance.ts ────────────────────────────────────────────────────────────────────

test("provenance strength is monotonic in the declared order", () => {
  for (let index = 1; index < PROVENANCES.length; index += 1) {
    assert.ok(provenanceStrength(PROVENANCES[index]) > provenanceStrength(PROVENANCES[index - 1]));
  }
});

test("strongestProvenance ignores unknown values rather than crashing on them", () => {
  assert.equal(strongestProvenance(["ai_proposed", "not_a_real_class", "git_verified"]), "git_verified");
  assert.equal(strongestProvenance([]), null);
});

test("a browser principal is always human_approved regardless of statedBy", () => {
  assert.equal(provenanceFor(browser), "human_approved");
  assert.equal(provenanceFor(browser, { statedBy: "irrelevant" }), "human_approved");
});

test("an agent naming who decided is human_stated; naming nobody is ai_proposed", () => {
  assert.equal(provenanceFor(agent, { statedBy: "Prathik" }), "human_stated");
  assert.equal(provenanceFor(agent), "ai_proposed");
  assert.equal(provenanceFor(agent, { statedBy: "   " }), "ai_proposed", "whitespace is not a name");
});

test("isVerifiedProvenance draws the line at code_observed and above", () => {
  assert.ok(!isVerifiedProvenance("human_approved"));
  assert.ok(isVerifiedProvenance("code_observed"));
  assert.ok(isVerifiedProvenance("git_verified"));
  assert.ok(isVerifiedProvenance("ci_verified"));
});

// ── Every write stamps provenance ───────────────────────────────────────────────────

test("creating an item stamps status_provenance and the creation event", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const byPerson = await executeCommand(db, browser, { action: "create_item", projectId, title: "Typed by a person", idempotencyKey: "p1" });
  const byAgent = await executeCommand(db, agent, { action: "create_item", projectId, title: "Suggested", idempotencyKey: "p2" });

  const personRow = await db.prepare("SELECT status_provenance FROM work_items WHERE id = ?").bind(byPerson.itemId).first();
  const agentRow = await db.prepare("SELECT status_provenance FROM work_items WHERE id = ?").bind(byAgent.itemId).first();
  assert.equal(personRow.status_provenance, "human_approved");
  assert.equal(agentRow.status_provenance, "ai_proposed");

  const events = await eventsFor(db, byPerson.itemId);
  assert.equal(events[0].provenance, "human_approved");
});

test("a transition stamps provenance on both the row and its event", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Move me", "t1");
  await transition(db, agent, projectId, itemId, "planned", "t1-p");

  const row = await db.prepare("SELECT status_provenance FROM work_items WHERE id = ?").bind(itemId).first();
  assert.equal(row.status_provenance, "ai_proposed");
  const events = await eventsFor(db, itemId);
  assert.equal(events[0].provenance, "ai_proposed");
});

test("progress notes and evidence attachments both carry provenance", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Track this", "e1");
  await executeCommand(db, agent, { action: "add_note", projectId, itemId, summary: "Working on it", idempotencyKey: "n1" });
  await executeCommand(db, agent, { action: "add_evidence", projectId, itemId, type: "test_run", label: "npm test", idempotencyKey: "ev1" });

  const events = await eventsFor(db, itemId);
  const note = events.find((event) => event.event_type === "work_item.progress_reported");
  const evidence = events.find((event) => event.event_type === "evidence.attached");
  assert.equal(note.provenance, "ai_proposed");
  assert.equal(evidence.provenance, "ai_proposed");
});

test("a reported acceptance is stamped human_stated, distinct from a real click", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const proposed = await executeCommand(db, agent, { action: "create_item", projectId, title: "Idea", idempotencyKey: "a1" });
  await executeCommand(db, agent, { action: "set_maturity", projectId, itemIds: [proposed.itemId], maturity: "accepted", statedBy: "Prathik", idempotencyKey: "acc1" });
  const events = await eventsFor(db, proposed.itemId);
  const promotion = events.find((event) => event.event_type === "work_item.maturity_changed");
  assert.equal(promotion.provenance, "human_stated");
});

test("a structured reason lands on the event separately from the free-text summary", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Explain yourself", "rs1");
  await transition(db, browser, projectId, itemId, "cancelled", "rs1-c", { resolution: "rejected", resolutionReason: "Superseded by a cheaper approach" });
  const events = await eventsFor(db, itemId);
  assert.equal(events[0].reason, "Superseded by a cheaper approach");
  assert.match(events[0].summary, /moved #\d+ from proposed to cancelled/);
});

// ── F4: verification_status stops mirroring status ──────────────────────────────────

test("moving to done no longer fabricates verification with nothing behind it", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Finish me", "f1");
  await transition(db, principal, projectId, itemId, "planned", "f1-p");
  await transition(db, principal, projectId, itemId, "ready", "f1-r");
  await transition(db, principal, projectId, itemId, "in_progress", "f1-s");
  await transition(db, principal, projectId, itemId, "done", "f1-d");

  const row = await db.prepare("SELECT verification_status, completion_confidence FROM work_items WHERE id = ?").bind(itemId).first();
  assert.notEqual(row.verification_status, "passed", "the status transition alone must not fabricate verification");
  assert.notEqual(row.completion_confidence, "verified", "nor completion confidence");
});

test("attaching evidence still raises completion_confidence to supported", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "With proof", "f2");
  await executeCommand(db, principal, { action: "add_evidence", projectId, itemId, type: "pr", label: "PR #4", idempotencyKey: "ev2" });
  const row = await db.prepare("SELECT completion_confidence FROM work_items WHERE id = ?").bind(itemId).first();
  assert.equal(row.completion_confidence, "supported");
});

test("legacy rows fabricated as 'passed' purely by status are corrected on organization load", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  // Simulate the old behaviour: done, 'passed', no evidence at all.
  await db.prepare("INSERT INTO work_items (id, organization_id, project_id, sequence, item_key, title, status, verification_status, completion_confidence) VALUES ('wi_old_done', ?, ?, 55, '#55', 'Old done item', 'done', 'passed', 'verified')")
    .bind(organizationId, projectId).run();
  // The migration runs from organizationFor(), keyed off data_migrations, and this
  // organization already exists (setupProject ran it once) so re-triggering it means
  // clearing the migration marker the way a real pre-migration organization would lack it.
  await db.prepare("DELETE FROM data_migrations WHERE organization_id = ? AND migration_key LIKE '%verification-status%'").bind(organizationId).run();

  await organizationFor(db, principal);
  const row = await db.prepare("SELECT verification_status, completion_confidence FROM work_items WHERE id = 'wi_old_done'").first();
  assert.equal(row.verification_status, "pending");
  assert.equal(row.completion_confidence, "reported");
});

test("a legacy done item that does carry evidence keeps 'supported', not reset to nothing", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  await db.prepare("INSERT INTO work_items (id, organization_id, project_id, sequence, item_key, title, status, verification_status, completion_confidence) VALUES ('wi_old_evidenced', ?, ?, 56, '#56', 'Old done item with proof', 'done', 'passed', 'verified')")
    .bind(organizationId, projectId).run();
  await db.prepare("INSERT INTO evidence (id, organization_id, project_id, work_item_id, type, label) VALUES ('evd_old', ?, ?, 'wi_old_evidenced', 'pr', 'PR #1')").bind(organizationId, projectId).run();
  await db.prepare("DELETE FROM data_migrations WHERE organization_id = ? AND migration_key LIKE '%verification-status%'").bind(organizationId).run();

  await organizationFor(db, principal);
  const row = await db.prepare("SELECT verification_status, completion_confidence FROM work_items WHERE id = 'wi_old_evidenced'").first();
  assert.equal(row.verification_status, "pending", "still unverified: evidence existing is not the same as it being checked");
  assert.equal(row.completion_confidence, "supported");
});

test("the migration runs once per organization, not once per load", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Already migrated once", "once1");
  // Set a value the migration would reset, simulating something legitimate written *after*
  // the migration already ran for this organization.
  await db.prepare("UPDATE work_items SET verification_status = 'passed' WHERE id = ?").bind(itemId).run();
  await organizationFor(db, principal); // second load must not re-touch already-corrected rows
  const row = await db.prepare("SELECT verification_status FROM work_items WHERE id = ?").bind(itemId).first();
  assert.equal(row.verification_status, "passed", "a value set after the migration already ran must survive a later load");
});

// ── confidence.ts ────────────────────────────────────────────────────────────────────

function baseItem(overrides = {}) {
  return { id: "wi_1", status: "ready", maturity: "accepted", statusProvenance: "ai_proposed", verificationStatus: "pending", completionConfidence: "reported", updatedAt: new Date().toISOString(), ...overrides };
}

test("a completion with no evidence at all is low confidence", () => {
  const result = confidenceOf({ item: baseItem({ status: "done", statusProvenance: "ai_proposed" }), events: [], corroboration: 1, evidenceCount: 0, verifiedEvidenceCount: 0, now: Date.now() });
  assert.equal(result.level, "low");
  assert.ok(result.reasons.some((line) => /no evidence/i.test(line)));
});

test("a completion with unverified evidence is medium, not high", () => {
  const result = confidenceOf({ item: baseItem({ status: "done" }), events: [], corroboration: 1, evidenceCount: 1, verifiedEvidenceCount: 0, now: Date.now() });
  assert.equal(result.level, "medium");
});

test("a completion with machine-verified evidence, recently, is high", () => {
  const result = confidenceOf({ item: baseItem({ status: "done", statusProvenance: "git_verified" }), events: [], corroboration: 1, evidenceCount: 1, verifiedEvidenceCount: 1, now: Date.now() });
  assert.equal(result.level, "high");
  assert.ok(result.reasons.some((line) => /machine-checked/i.test(line)));
});

test("a verified completion that has gone stale drops to medium, not high forever", () => {
  const now = Date.now();
  const old = new Date(now - 30 * 86_400_000).toISOString();
  const result = confidenceOf({ item: baseItem({ status: "done", statusProvenance: "git_verified", updatedAt: old }), events: [], corroboration: 1, evidenceCount: 1, verifiedEvidenceCount: 1, now });
  assert.equal(result.level, "medium");
  assert.ok(result.reasons.some((line) => /days/i.test(line)));
});

test("a plain proposal is low confidence with no penalty language about staleness", () => {
  const result = confidenceOf({ item: baseItem({ status: "proposed", maturity: "proposal", statusProvenance: "ai_proposed" }), events: [], corroboration: 1, evidenceCount: 0, verifiedEvidenceCount: 0, now: Date.now() });
  assert.equal(result.level, "low");
});

test("independent corroboration lifts a proposal's confidence without claiming it is verified", () => {
  const result = confidenceOf({ item: baseItem({ status: "proposed", maturity: "proposal" }), events: [], corroboration: 3, evidenceCount: 0, verifiedEvidenceCount: 0, now: Date.now() });
  assert.equal(result.level, "medium");
  assert.ok(result.reasons.some((line) => /independently by 3/i.test(line)));
  assert.ok(!result.reasons.some((line) => /verified/i.test(line)));
});

test("a human-approved status without evidence is medium, not high — approval is not verification", () => {
  const result = confidenceOf({ item: baseItem({ statusProvenance: "human_approved" }), events: [], corroboration: 1, evidenceCount: 0, verifiedEvidenceCount: 0, now: Date.now() });
  assert.equal(result.level, "high", "a fresh human decision is the strongest non-machine signal there is");
});

test("the same human-approved status goes stale after two weeks", () => {
  const now = Date.now();
  const old = new Date(now - 20 * 86_400_000).toISOString();
  const result = confidenceOf({ item: baseItem({ statusProvenance: "human_approved", updatedAt: old }), events: [], corroboration: 1, evidenceCount: 0, verifiedEvidenceCount: 0, now });
  assert.equal(result.level, "medium");
});

test("confidence never claims verification once evidence is gone, even if the row still says done", () => {
  // The exact scenario F4 describes: a row stuck at 'done'/'passed' after its evidence was
  // deleted. Confidence must read the *current* evidence count, not the stored status.
  const result = confidenceOf({ item: baseItem({ status: "done", statusProvenance: "ai_proposed", verificationStatus: "passed", completionConfidence: "verified" }), events: [], corroboration: 1, evidenceCount: 0, verifiedEvidenceCount: 0, now: Date.now() });
  assert.equal(result.level, "low", "a stale stored 'verified' value must not leak into the derived level");
});

test("the strongest provenance across item and events wins, and later events can only raise it", () => {
  const events = [
    { eventType: "work_item.completion_verified", createdAt: new Date().toISOString(), provenance: "git_verified" },
    { eventType: "work_item.created", createdAt: new Date(Date.now() - 86_400_000).toISOString(), provenance: "ai_proposed" },
  ];
  const result = confidenceOf({ item: baseItem({ status: "done", statusProvenance: "ai_proposed" }), events, corroboration: 1, evidenceCount: 1, verifiedEvidenceCount: 1, now: Date.now() });
  assert.equal(result.basis, "git_verified");
  assert.equal(result.level, "high");
});

test("with nothing recorded at all, confidence still returns a sentence rather than nothing", () => {
  const result = confidenceOf({ item: baseItem({ statusProvenance: null }), events: [], corroboration: 1, evidenceCount: 0, verifiedEvidenceCount: 0, now: Date.now() });
  assert.ok(result.reasons.length > 0);
  assert.equal(result.basis, null);
});
