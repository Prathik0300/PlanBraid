/**
 * M21 — planning-loop detection.
 *
 * The data this reads already exists: every restatement the dedup matcher collapses is
 * stored as an alias with its source and timestamp, specifically so a pattern like this
 * could be read back without any agent reporting it. The bar for "loop" is deliberately
 * low — see analyze.ts's comment on why a false positive here is cheap and a missed loop
 * is not — so most of these tests are about what correctly does NOT count as one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { findPlanningLoops } from "@/lib/simplify/analyze.ts";
import { createWorkItemsDeduplicated, executeCommand, organizationFor } from "@/lib/store.ts";
import { loadProjectView } from "@/lib/read/project-view.ts";
import { createSimplificationRun } from "@/lib/simplify/runs.ts";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject } from "./support/fixtures.mjs";

let counter = 0;
function item(over = {}) {
  counter += 1;
  return {
    id: `wi_${counter}`, projectId: "p1", sequence: counter, itemKey: `#${counter}`, type: "task",
    title: "", description: "", status: "proposed", maturity: "accepted", resolution: null, resolutionReason: null, deferredUntil: null,
    priority: "normal", assignee: null, sourceId: `src_${counter}`, codingSpaceId: null,
    completionConfidence: "reported", verificationStatus: "pending", blockerReason: null, statusProvenance: "ai_proposed",
    blockingCount: 0, unblockedAt: null, version: 1, startedAt: null, completedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
  };
}
function source(id, provider) { return { id, projectId: "p1", codingSpaceId: null, provider, externalId: id, title: provider, model: null, status: "active", assurance: "instructed", currentTaskIds: [], lastSeenAt: new Date().toISOString(), agentAccountId: null, agentAccountLabel: null }; }
function alias(workItemId, sourceId, daysAgo) { return { id: `als_${workItemId}_${sourceId}`, workItemId, title: "restated", description: "", sourceId, matchMethod: "lexical", matchReason: "", createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString() }; }

const now = Date.now();
const oldTimestamp = new Date(now - 20 * 86_400_000).toISOString();

// ── The pure function ───────────────────────────────────────────────────────────────

test("three independent proposals across two models, no work done, is a loop", () => {
  const target = item({ createdAt: oldTimestamp, sourceId: "src_claude" });
  const sources = [source("src_claude", "claude"), source("src_codex", "codex")];
  const aliases = [alias(target.id, "src_codex", 15), alias(target.id, "src_codex", 5)];
  const findings = findPlanningLoops([target], aliases, sources, [], [], now);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "planning_loop");
  assert.match(findings[0].reason, /3 times/);
  // Span is measured from the first proposal (createdAt, 20 days ago) to `now`, not merely
  // to the latest restatement — a loop nobody has touched since its last proposal is still
  // an open loop today.
  assert.match(findings[0].reason, /20 days/);
});

test("two proposals is not yet a loop", () => {
  const target = item({ createdAt: oldTimestamp, sourceId: "src_claude" });
  const sources = [source("src_claude", "claude"), source("src_codex", "codex")];
  const aliases = [alias(target.id, "src_codex", 10)];
  assert.deepEqual(findPlanningLoops([target], aliases, sources, [], [], now), []);
});

test("three proposals from the same model family is not a loop — one agent repeating itself is not a pattern several agents hit", () => {
  const target = item({ createdAt: oldTimestamp, sourceId: "src_claude_a" });
  const sources = [source("src_claude_a", "claude"), source("src_claude_b", "claude-code")];
  const aliases = [alias(target.id, "src_claude_b", 15), alias(target.id, "src_claude_b", 5)];
  assert.deepEqual(findPlanningLoops([target], aliases, sources, [], [], now), []);
});

test("a started item is never a loop, no matter how many times it was proposed", () => {
  const target = item({ createdAt: oldTimestamp, sourceId: "src_claude" });
  const sources = [source("src_claude", "claude"), source("src_codex", "codex")];
  const aliases = [alias(target.id, "src_codex", 15), alias(target.id, "src_codex", 5)];
  const events = [{ eventType: "work_item.started", workItemId: target.id }];
  assert.deepEqual(findPlanningLoops([target], aliases, sources, events, [], now), []);
});

test("an item with evidence attached is never a loop", () => {
  const target = item({ createdAt: oldTimestamp, sourceId: "src_claude" });
  const sources = [source("src_claude", "claude"), source("src_codex", "codex")];
  const aliases = [alias(target.id, "src_codex", 15), alias(target.id, "src_codex", 5)];
  const evidence = [{ id: "evd_1", workItemId: target.id, sourceId: null, type: "pr", label: "PR", uri: null, result: null, createdAt: new Date().toISOString() }];
  assert.deepEqual(findPlanningLoops([target], aliases, sources, [], evidence, now), []);
});

test("done or cancelled items are never loops even if repeatedly proposed beforehand", () => {
  for (const status of ["done", "cancelled"]) {
    const target = item({ status, createdAt: oldTimestamp, sourceId: "src_claude" });
    const sources = [source("src_claude", "claude"), source("src_codex", "codex")];
    const aliases = [alias(target.id, "src_codex", 15), alias(target.id, "src_codex", 5)];
    assert.deepEqual(findPlanningLoops([target], aliases, sources, [], [], now), []);
  }
});

test("three proposals within a couple of days is not a pattern yet", () => {
  const target = item({ createdAt: new Date(now - 2 * 86_400_000).toISOString(), sourceId: "src_claude" });
  const sources = [source("src_claude", "claude"), source("src_codex", "codex")];
  const aliases = [alias(target.id, "src_codex", 1), alias(target.id, "src_codex", 0)];
  assert.deepEqual(findPlanningLoops([target], aliases, sources, [], [], now), []);
});

test("aliases from a source that no longer exists do not crash the pass and do not count toward provider diversity", () => {
  const target = item({ createdAt: oldTimestamp, sourceId: "src_claude" });
  const sources = [source("src_claude", "claude")];
  const aliases = [alias(target.id, "src_missing", 15), alias(target.id, "src_missing", 5)];
  assert.deepEqual(findPlanningLoops([target], aliases, sources, [], [], now), []);
});

test("the finding names every proposing model family and how many times each", () => {
  const target = item({ createdAt: oldTimestamp, sourceId: "src_claude" });
  const sources = [source("src_claude", "claude"), source("src_codex_a", "codex"), source("src_codex_b", "codex-desktop"), source("src_gemini", "gemini")];
  const aliases = [alias(target.id, "src_codex_a", 15), alias(target.id, "src_codex_b", 10), alias(target.id, "src_gemini", 5)];
  const findings = findPlanningLoops([target], aliases, sources, [], [], now);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /codex×2/);
  assert.match(findings[0].detail, /claude×1/);
  assert.match(findings[0].detail, /gemini×1/);
});

test("a planning loop is informational and carries no proposedCommand — nothing here should auto-apply", () => {
  const target = item({ createdAt: oldTimestamp, sourceId: "src_claude" });
  const sources = [source("src_claude", "claude"), source("src_codex", "codex")];
  const aliases = [alias(target.id, "src_codex", 15), alias(target.id, "src_codex", 5)];
  const findings = findPlanningLoops([target], aliases, sources, [], [], now);
  assert.equal(findings[0].verdict, "informational");
  assert.equal(findings[0].proposedCommand, undefined);
});

test("dedupeKey is stable, so the same loop reported twice is one row", () => {
  const target = item({ createdAt: oldTimestamp, sourceId: "src_claude" });
  const sources = [source("src_claude", "claude"), source("src_codex", "codex")];
  const aliases = [alias(target.id, "src_codex", 15), alias(target.id, "src_codex", 5)];
  const first = findPlanningLoops([target], aliases, sources, [], [], now);
  const second = findPlanningLoops([target], aliases, sources, [], [], now);
  assert.equal(first[0].dedupeKey, second[0].dedupeKey);
});

// ── End to end, through the real dedup + Simplify pipeline ─────────────────────────────

/**
 * The dedup matcher only ever auto-collapses on an exact fingerprint match or an identical
 * artifact set (DEDUPLICATION_ARCHITECTURE.md §6.3's asymmetry: a mere lexical resemblance
 * stays "possible" and creates a separate item, on purpose). So proving the loop finding
 * end to end needs proposals that genuinely fingerprint-match, which near-synonym wording
 * does not reliably do — the literal case here is three agents each restating the exact
 * same task, which is the real-world shape a loop actually takes.
 */
const LOOP_TITLE = "Refactor the authentication middleware";

test("a task independently proposed three times by two agents over real usage surfaces as a loop in a Simplify run", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);

  const claude = await db.prepare("INSERT INTO sources (id, organization_id, project_id, provider, external_id, title) VALUES ('src_c', ?, ?, 'claude', 'c1', 'Claude') RETURNING id").bind(organizationId, projectId).first();
  const codex = await db.prepare("INSERT INTO sources (id, organization_id, project_id, provider, external_id, title) VALUES ('src_x', ?, ?, 'codex', 'x1', 'Codex') RETURNING id").bind(organizationId, projectId).first();

  const first = await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: claude.id, idempotencyKey: "loop-1", proposals: [{ title: LOOP_TITLE }] });
  const second = await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: codex.id, idempotencyKey: "loop-2", proposals: [{ title: LOOP_TITLE }] });
  const third = await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: codex.id, idempotencyKey: "loop-3", proposals: [{ title: LOOP_TITLE }] });
  assert.equal(second.results[0].status, "matched", "the setup must actually collapse into aliases, or this test proves nothing");
  assert.equal(third.results[0].status, "matched");

  const itemId = first.results[0].workItemId;
  await db.prepare("UPDATE work_items SET created_at = ? WHERE id = ?").bind(oldTimestamp, itemId).run();
  await db.prepare("UPDATE work_item_aliases SET created_at = ? WHERE work_item_id = ?").bind(new Date(now - 10 * 86_400_000).toISOString(), itemId).run();

  const run = await createSimplificationRun(db, principal, { projectId });
  const loop = run.findings.find((finding) => finding.kind === "planning_loop" && finding.workItemId === itemId);
  assert.ok(loop, `expected a planning_loop finding among ${JSON.stringify(run.findings.map((f) => f.kind))}`);
});

/** proposed -> in_progress is not a legal jump (ALLOWED_TRANSITIONS); goes through the
 * same planned -> ready -> in_progress path a real agent's start_work call would. */
async function start(db, projectId, itemId, keyPrefix) {
  for (const [index, status] of ["planned", "ready", "in_progress"].entries()) {
    const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first();
    await executeCommand(db, principal, { action: "transition_item", projectId, itemId, expectedVersion: row.version, status, idempotencyKey: `${keyPrefix}-${index}` });
  }
}

test("real usage where the task actually got started never surfaces as a loop", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const claude = await db.prepare("INSERT INTO sources (id, organization_id, project_id, provider, external_id, title) VALUES ('src_c2', ?, ?, 'claude', 'c2', 'Claude') RETURNING id").bind(organizationId, projectId).first();
  const codex = await db.prepare("INSERT INTO sources (id, organization_id, project_id, provider, external_id, title) VALUES ('src_x2', ?, ?, 'codex', 'x2', 'Codex') RETURNING id").bind(organizationId, projectId).first();

  const first = await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: claude.id, idempotencyKey: "started-1", proposals: [{ title: LOOP_TITLE }] });
  await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: codex.id, idempotencyKey: "started-2", proposals: [{ title: LOOP_TITLE }] });
  await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: codex.id, idempotencyKey: "started-3", proposals: [{ title: LOOP_TITLE }] });

  const itemId = first.results[0].workItemId;
  await db.prepare("UPDATE work_items SET created_at = ? WHERE id = ?").bind(oldTimestamp, itemId).run();
  await start(db, projectId, itemId, "started-t");

  const run = await createSimplificationRun(db, principal, { projectId });
  assert.ok(!run.findings.some((finding) => finding.kind === "planning_loop"), "started work must never be flagged as a loop, however many times it was proposed first");
});

test("loop detection sees a started event outside loadDashboard's 250-row cap", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const claude = await db.prepare("INSERT INTO sources (id, organization_id, project_id, provider, external_id, title) VALUES ('src_c3', ?, ?, 'claude', 'c3', 'Claude') RETURNING id").bind(organizationId, projectId).first();
  const codex = await db.prepare("INSERT INTO sources (id, organization_id, project_id, provider, external_id, title) VALUES ('src_x3', ?, ?, 'codex', 'x3', 'Codex') RETURNING id").bind(organizationId, projectId).first();

  const first = await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: claude.id, idempotencyKey: "cap-1", proposals: [{ title: LOOP_TITLE }] });
  await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: codex.id, idempotencyKey: "cap-2", proposals: [{ title: LOOP_TITLE }] });
  await createWorkItemsDeduplicated(db, principal, { projectId, sourceId: codex.id, idempotencyKey: "cap-3", proposals: [{ title: LOOP_TITLE }] });
  const itemId = first.results[0].workItemId;
  await db.prepare("UPDATE work_items SET created_at = ? WHERE id = ?").bind(oldTimestamp, itemId).run();
  await start(db, projectId, itemId, "cap-t");

  // Push the started event's project_revision far below anything a 250-row org-wide window
  // would keep, by generating 400 unrelated events after it.
  for (let index = 0; index < 400; index += 1) {
    await executeCommand(db, principal, { action: "add_note", projectId, itemId, summary: `filler ${index}`, idempotencyKey: `cap-filler-${index}` });
  }

  const view = await loadProjectView(db, organizationId, projectId, { events: true });
  const startedStillInWindow = view.events.some((event) => event.workItemId === itemId && event.eventType === "work_item.started");
  assert.ok(!startedStillInWindow, "the test setup must actually push the event out of the capped window, or this test proves nothing");

  const run = await createSimplificationRun(db, principal, { projectId });
  assert.ok(!run.findings.some((finding) => finding.kind === "planning_loop"), "the started event must still be found via the unbounded query, not the capped dashboard window");
});
