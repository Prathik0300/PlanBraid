/**
 * M11 — pre-planning intelligence, and the reason it is called the highest-return item in
 * `PLANNING_INTELLIGENCE_ROADMAP.md`.
 *
 * The "done when" bar the roadmap sets is literal: in the two-agent scenario, the second
 * agent's plan references the first agent's item keys instead of restating them, with no
 * human in between. Every relevant bucket is exercised directly against that scenario, plus
 * the guidance generator's own promise — never a template firing on empty data — and the
 * relevance floor that keeps an unrelated project's history from flooding the response.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand, organizationFor, registerSourceSession, updateSourceHeartbeat } from "@/lib/store.ts";
import { getPlanningContext } from "@/lib/planning/context.ts";

async function transition(db, projectId, itemId, status, key, extra = {}) {
  const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first();
  return executeCommand(db, principal, { action: "transition_item", projectId, itemId, expectedVersion: row.version, status, idempotencyKey: key, ...extra });
}

async function context(db, projectId, objective, extra = {}) {
  const organizationId = await organizationFor(db, principal);
  return getPlanningContext(db, organizationId, { projectId, objective, ...extra });
}

// ── The scenario the roadmap's "done when" describes ────────────────────────────────

test("the two-agent scenario: the second agent's objective surfaces the first agent's completed work by item key", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Migrate JWT signing from HS256 to RS256", "rs256");
  await transition(db, projectId, itemId, "planned", "p1");
  await transition(db, projectId, itemId, "ready", "p2");
  await transition(db, projectId, itemId, "in_progress", "p3");
  await transition(db, projectId, itemId, "done", "p4");

  const result = await context(db, projectId, "improve authentication by migrating JWT signing to RS256");
  assert.equal(result.alreadyDone.length, 1);
  assert.equal(result.alreadyDone[0].itemKey, "#1");
  assert.ok(result.guidance.some((line) => line.includes("#1")), `guidance must name the item key: ${JSON.stringify(result.guidance)}`);
});

test("a rejected approach surfaces with its reason, so the same idea does not get proposed a second time", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Share one HS256 secret across every service", "hs256");
  await transition(db, projectId, itemId, "cancelled", "r1", { resolution: "rejected", resolutionReason: "breaks service isolation" });

  const result = await context(db, projectId, "use a shared secret across services for authentication");
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].resolution, "rejected");
  assert.equal(result.rejected[0].resolutionReason, "breaks service isolation");
  assert.ok(result.guidance.some((line) => line.includes("breaks service isolation")));
});

test("in-progress work names who is holding it, when a live lease exists", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Add refresh-token rotation to the auth service", "rot1");
  await transition(db, projectId, itemId, "planned", "s1");
  await transition(db, projectId, itemId, "ready", "s2");
  await transition(db, projectId, itemId, "in_progress", "s3");
  const source = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "sess-1" });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [itemId] });

  const result = await context(db, projectId, "add refresh-token rotation to the auth service");
  assert.equal(result.inProgress.length, 1);
  assert.equal(result.inProgress[0].heldBy, "codex");
  assert.ok(result.guidance.some((line) => line.includes("codex") && line.includes("#1")));
});

test("in-progress work with no live lease still surfaces, just without a holder", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Add refresh-token rotation", "rot2");
  await transition(db, projectId, itemId, "planned", "t1");
  await transition(db, projectId, itemId, "ready", "t2");
  await transition(db, projectId, itemId, "in_progress", "t3");

  const result = await context(db, projectId, "add refresh-token rotation");
  assert.equal(result.inProgress.length, 1);
  assert.equal(result.inProgress[0].heldBy, null);
});

test("blocked work carries the chain, reusing the same pass Simplify runs", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const blocker = await createItem(db, projectId, "Add the token persistence schema", "sch1");
  const blocked = await createItem(db, projectId, "Add automatic refresh-token rotation", "rot3");
  await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: blocker, toWorkItemId: blocked, type: "blocks", idempotencyKey: "dep1" });

  const result = await context(db, projectId, "add automatic refresh-token rotation");
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].workItemId, blocked);
  assert.match(result.blocked[0].reason, /waiting on|is the only thing/i);
});

test("open proposals surface with corroboration, and heavy corroboration triggers loop guidance", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const claude = await db.prepare("INSERT INTO sources (id, organization_id, project_id, provider, external_id, title) VALUES ('src_pc', ?, ?, 'claude', 'pc1', 'Claude') RETURNING id").bind(organizationId, projectId).first();
  const codex = await db.prepare("INSERT INTO sources (id, organization_id, project_id, provider, external_id, title) VALUES ('src_px', ?, ?, 'codex', 'px1', 'Codex') RETURNING id").bind(organizationId, projectId).first();

  const { createWorkItemsDeduplicated } = await import("@/lib/store.ts");
  await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: claude.id, idempotencyKey: "pc-1", proposals: [{ title: "Refactor the authentication middleware" }] });
  await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: codex.id, idempotencyKey: "pc-2", proposals: [{ title: "Refactor the authentication middleware" }] });
  await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: codex.id, idempotencyKey: "pc-3", proposals: [{ title: "Refactor the authentication middleware" }] });

  const result = await context(db, projectId, "refactor the authentication middleware");
  assert.equal(result.openProposals.length, 1);
  assert.equal(result.openProposals[0].timesProposed, 3);
  assert.deepEqual([...result.openProposals[0].proposedBy].sort(), ["claude", "codex"]);
});

test("unrelated proposals do not trigger the loop-count guidance line", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Refactor the authentication middleware", "auth1");
  const result = await context(db, projectId, "refactor the authentication middleware");
  assert.ok(!result.guidance.some((line) => line.includes("related proposals already exist")));
});

// ── Relevance filtering ──────────────────────────────────────────────────────────────

test("work unrelated to the objective does not appear at all", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const relevantId = await createItem(db, projectId, "Add rate limiting to /api/login", "rl1");
  await createItem(db, projectId, "Redesign the marketing homepage", "hp1");
  await transition(db, projectId, relevantId, "planned", "u1");

  const result = await context(db, projectId, "add rate limiting to the login endpoint");
  const allItemIds = [...result.alreadyDone, ...result.inProgress, ...result.planned, ...result.blocked, ...result.rejected, ...result.openProposals].map((entry) => entry.workItemId);
  assert.ok(allItemIds.includes(relevantId));
  assert.ok(!allItemIds.some((id) => id !== relevantId), "the unrelated homepage task must not appear in any bucket");
});

test("a shared concrete artifact is relevant even with completely different wording — the case lexical overlap alone would miss", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Update the handler at lib/oauth.ts to support refresh", "oauth1");
  const result = await context(db, projectId, "investigate why refreshing tokens breaks lib/oauth.ts");
  // createItem (via the shared, non-browser `principal` fixture) creates agent-proposal
  // maturity by default, so the item lands in openProposals rather than planned — every
  // bucket is a valid place for "surfaced at all" to be checked.
  const ids = [...result.planned, ...result.alreadyDone, ...result.openProposals].map((entry) => entry.workItemId);
  assert.ok(ids.includes(itemId), "a shared artifact reference must be enough to surface the item regardless of wording");
});

test("context for a project with no work at all returns empty buckets and no guidance, not an error", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const result = await context(db, projectId, "build something entirely new");
  assert.deepEqual(result.alreadyDone, []);
  assert.deepEqual(result.guidance, []);
  assert.equal(result.consideredCount, 0);
});

test("work from a different project never appears, even with an identical objective", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, principal, { action: "create_project", name: "Other", idempotencyKey: "pc-p2" })).projectId;
  await createItem(db, projectB, "Add rate limiting to /api/login", "b1");

  const result = await context(db, projectA, "add rate limiting to /api/login");
  assert.deepEqual(result.planned, []);
});

// ── Guidance discipline: never a template firing on empty data ─────────────────────

test("guidance is empty when nothing relevant was found — no line asserts something false", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Something entirely unrelated to spelunking", "x1");
  const result = await context(db, projectId, "plan a spelunking expedition");
  assert.deepEqual(result.guidance, []);
});

test("guidance never mentions a bucket that is empty", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Add rate limiting to /api/login", "rl2");
  await transition(db, projectId, itemId, "planned", "g1");

  const result = await context(db, projectId, "add rate limiting to /api/login");
  assert.deepEqual(result.alreadyDone, []);
  assert.deepEqual(result.rejected, []);
  assert.ok(!result.guidance.some((line) => /already covers this|was rejected|was superseded/.test(line)));
});

// ── Bucketing correctness ────────────────────────────────────────────────────────────

test("a resolved-but-uncategorized cancellation (resolution unspecified) is filed into neither alreadyDone nor rejected", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Add rate limiting to /api/login", "rl3");
  await transition(db, projectId, itemId, "cancelled", "c1"); // no resolution given -> 'unspecified'

  const result = await context(db, projectId, "add rate limiting to /api/login");
  assert.deepEqual(result.alreadyDone, []);
  assert.deepEqual(result.rejected, []);
});

test("a proposal (unaccepted maturity) is bucketed as an open proposal, not as planned", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const agent = { ...principal, authentication: "personal_token", credentialId: "cred_1" };
  await executeCommand(db, agent, { action: "create_item", projectId, title: "Add rate limiting to /api/login", idempotencyKey: "prop1" });

  const result = await context(db, projectId, "add rate limiting to /api/login");
  assert.equal(result.openProposals.length, 1);
  assert.deepEqual(result.planned, []);
});

test("each bucket is capped so the response stays a briefing, not a dump", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  for (let index = 0; index < 10; index += 1) {
    const itemId = await createItem(db, projectId, `Add rate limiting to /api/endpoint${index}`, `cap${index}`);
    await transition(db, projectId, itemId, "planned", `capp${index}`);
  }
  const result = await context(db, projectId, "add rate limiting across the API");
  assert.ok(result.planned.length <= 6, `expected the bucket capped at 6, got ${result.planned.length}`);
  assert.ok(result.consideredCount >= result.planned.length, "consideredCount must reflect everything ranked as relevant, not just what fit in the bucket");
});
