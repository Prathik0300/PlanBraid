/**
 * M7 — the project-scoped read path, and the two silent bugs it closes.
 *
 * Three things under test:
 *  1. Reads are scoped. A caller asking about one project never sees another's rows, and
 *     an id belonging to a different organization is a 404 rather than a leak.
 *  2. F2 — duplicate matching no longer loses old work. Candidates come from the artifact
 *     index, so a proposal restating a task completed long ago and buried under hundreds
 *     of newer items still matches it instead of quietly creating a second card.
 *  3. F5 — unlock counts are computed in one grouped query, with ranking unchanged.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { createWorkItemsDeduplicated, executeCommand, getReadyWork, organizationFor } from "@/lib/store.ts";
import { currentVersionOf, itemKeysFor, listProjects, listWorkItems, loadProjectView, loadWorkItemDetail, searchWorkItems } from "@/lib/read/project-view.ts";
import { classifyArtifact } from "@/lib/dedup/artifacts.ts";
import { backfillBlockingIndex, retrieveCandidates } from "@/lib/dedup/blocking.ts";

const otherPrincipal = { userId: "u_other", email: "other@planbraid.local", displayName: "Someone Else" };

async function orgOf(db, who = principal) {
  return organizationFor(db, who);
}

async function transition(db, projectId, itemId, status, key) {
  const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first();
  return executeCommand(db, principal, { action: "transition_item", projectId, itemId, expectedVersion: row.version, status, idempotencyKey: key });
}

// ── 1. Scoping ───────────────────────────────────────────────────────────────────────

test("listWorkItems returns only the requested project, even when another project has identical titles", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, principal, { action: "create_project", name: "Second Project", idempotencyKey: "p2" })).projectId;
  await createItem(db, projectA, "Add rate limiting to /api/login", "a1");
  await createItem(db, projectB, "Add rate limiting to /api/login", "b1");

  const items = await listWorkItems(db, await orgOf(db), { projectId: projectA });
  assert.equal(items.length, 1);
  assert.equal(items[0].projectId, projectA);
});

test("status, source and text filters run in SQL and compose", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const first = await createItem(db, projectId, "Add refresh-token rotation", "f1");
  await createItem(db, projectId, "Document the deploy runbook", "f2");
  await transition(db, projectId, first, "planned", "t1");

  const organizationId = await orgOf(db);
  assert.equal((await listWorkItems(db, organizationId, { projectId, status: "planned" })).length, 1);
  assert.equal((await listWorkItems(db, organizationId, { projectId, status: "proposed" })).length, 1);
  assert.equal((await listWorkItems(db, organizationId, { projectId, query: "refresh" })).length, 1);
  assert.equal((await listWorkItems(db, organizationId, { projectId, status: "planned", query: "runbook" })).length, 0, "filters are ANDed, not ORed");
});

test("a wildcard character in a query is matched literally, not as a wildcard", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Handle 100% CPU saturation", "w1");
  await createItem(db, projectId, "Unrelated work", "w2");

  const organizationId = await orgOf(db);
  assert.equal((await listWorkItems(db, organizationId, { projectId, query: "100%" })).length, 1);
  // A literal '%' legitimately matches the one title containing one. Unescaped it would
  // be a wildcard and match both rows, which is the failure this guards.
  assert.equal((await listWorkItems(db, organizationId, { projectId, query: "%" })).length, 1);
  // Neither title contains an underscore; unescaped, '_' matches any single character
  // and would return both.
  assert.equal((await listWorkItems(db, organizationId, { projectId, query: "_" })).length, 0);
});

test("another organization's project is not found rather than readable", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const foreignOrg = await orgOf(db, otherPrincipal);

  await assert.rejects(() => loadProjectView(db, foreignOrg, projectId, { items: true }), (error) => error.code === "NOT_FOUND");
  assert.deepEqual(await listWorkItems(db, foreignOrg, { projectId }), []);
  assert.deepEqual(await listProjects(db, foreignOrg), []);
});

test("another organization's work item is not found rather than readable", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Private task", "p1");
  const foreignOrg = await orgOf(db, otherPrincipal);

  await assert.rejects(() => loadWorkItemDetail(db, foreignOrg, itemId), (error) => error.code === "NOT_FOUND");
  assert.equal(await currentVersionOf(db, foreignOrg, itemId), null);
  assert.equal((await itemKeysFor(db, foreignOrg, [itemId])).size, 0);
});

test("loadProjectView returns only the parts asked for", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  await createItem(db, projectId, "Something to find", "v1");

  const itemsOnly = await loadProjectView(db, await orgOf(db), projectId, { items: true });
  assert.equal(itemsOnly.workItems.length, 1);
  assert.deepEqual(itemsOnly.events, [], "events were not requested and must not be loaded");
  assert.deepEqual(itemsOnly.sources, []);

  const withEvents = await loadProjectView(db, await orgOf(db), projectId, { items: true, events: true });
  assert.ok(withEvents.events.length > 0);
});

test("searchWorkItems spans projects within the organization and can be narrowed to one", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, principal, { action: "create_project", name: "Other", idempotencyKey: "sp2" })).projectId;
  await createItem(db, projectA, "Rotate signing keys", "s1");
  await createItem(db, projectB, "Rotate signing keys elsewhere", "s2");

  const organizationId = await orgOf(db);
  assert.equal((await searchWorkItems(db, organizationId, { query: "rotate signing" })).length, 2);
  assert.equal((await searchWorkItems(db, organizationId, { query: "rotate signing", projectId: projectA })).length, 1);
  assert.equal((await searchWorkItems(db, await orgOf(db, otherPrincipal), { query: "rotate signing" })).length, 0);
});

test("archived items disappear from every reader", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const winner = await createItem(db, projectId, "Add caching to the report endpoint", "m1");
  const loser = await createItem(db, projectId, "Cache the report endpoint response", "m2");
  await executeCommand(db, principal, { action: "merge_items", projectId, winnerItemId: winner, loserItemId: loser, idempotencyKey: "merge-1" });

  const organizationId = await orgOf(db);
  const ids = (await listWorkItems(db, organizationId, { projectId })).map((item) => item.id);
  assert.deepEqual(ids, [winner]);
  await assert.rejects(() => loadWorkItemDetail(db, organizationId, loser), (error) => error.code === "NOT_FOUND");
  assert.equal((await loadProjectView(db, organizationId, projectId, { items: true })).workItems.length, 1);
});

// ── 2. F2 — the artifact index ───────────────────────────────────────────────────────

test("artifacts are indexed when an item is created", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Add rate limiting to /api/login", "i1");

  const rows = await db.prepare("SELECT artifact FROM work_item_artifacts WHERE work_item_id = ? ORDER BY artifact").bind(itemId).all();
  assert.ok(rows.results.some((row) => row.artifact === "/api/login"), `expected /api/login in ${JSON.stringify(rows.results)}`);
  const stamped = await db.prepare("SELECT artifacts_indexed_at FROM work_items WHERE id = ?").bind(itemId).first();
  assert.ok(stamped.artifacts_indexed_at, "the item is marked indexed so backfill skips it");
});

test("editing an item drops artifacts it no longer mentions", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Add rate limiting to /api/login", "e1");
  const version = (await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(itemId).first()).version;
  await executeCommand(db, principal, { action: "update_item", projectId, itemId, expectedVersion: version, title: "Add rate limiting to /api/signup", idempotencyKey: "u1" });

  const rows = await db.prepare("SELECT artifact FROM work_item_artifacts WHERE work_item_id = ?").bind(itemId).all();
  const artifacts = rows.results.map((row) => row.artifact);
  assert.ok(artifacts.includes("/api/signup"));
  assert.ok(!artifacts.includes("/api/login"), "a stale artifact would keep matching work the task no longer describes");
});

test("a proposal matches work completed long ago and buried under newer items", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await orgOf(db);

  // The old, finished task: the case DEDUPLICATION_ARCHITECTURE.md §5 calls the most
  // valuable to catch, and the one recency-ordered retrieval dropped first.
  const oldId = await createItem(db, projectId, "Add rate limiting to /api/login", "old");
  await transition(db, projectId, oldId, "planned", "op1");
  await transition(db, projectId, oldId, "ready", "op2");
  await transition(db, projectId, oldId, "in_progress", "op3");
  await transition(db, projectId, oldId, "done", "op4");
  // Push it far outside any recency window.
  await db.prepare("UPDATE work_items SET updated_at = now() - interval '400 days' WHERE id = ?").bind(oldId).run();

  // 600 newer items, inserted directly: this test is about retrieval, and running them
  // through executeCommand would spend a minute proving nothing extra.
  const statements = [];
  for (let index = 0; index < 600; index += 1) {
    statements.push(db.prepare(
      "INSERT INTO work_items (id, organization_id, project_id, sequence, item_key, title, description, status, artifacts_indexed_at) VALUES (?, ?, ?, ?, ?, ?, '', 'proposed', now())",
    ).bind(`wi_filler${index}`, organizationId, projectId, 1000 + index, `#${1000 + index}`, `Unrelated filler task number ${index}`));
  }
  await db.batch(statements);

  const result = await createWorkItemsDeduplicated(db, principal, {
    projectId, idempotencyKey: "dedup-old",
    proposals: [{ ref: "again", title: "Add rate limiting to /api/login" }],
  });

  assert.equal(result.summary.matched, 1, `expected a match against the old completed item, got ${JSON.stringify(result.results)}`);
  assert.equal(result.results[0].workItemId, oldId);
  assert.match(result.results[0].warning ?? "", /already done/i, "restating finished work must warn, not silently collapse");
});

test("items written before the index existed are backfilled from the read path", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await orgOf(db);

  // Simulates pre-migration data: a row with no index entries and no indexed stamp.
  await db.prepare(
    "INSERT INTO work_items (id, organization_id, project_id, sequence, item_key, title, description, status) VALUES (?, ?, ?, 900, '#900', ?, '', 'done')",
  ).bind("wi_legacy", organizationId, projectId, "Add rate limiting to /api/login").run();
  await db.prepare("UPDATE work_items SET updated_at = now() - interval '400 days' WHERE id = 'wi_legacy'").run();

  assert.equal(await backfillBlockingIndex(db, organizationId, projectId), 1);
  const artifactRows = await db.prepare("SELECT artifact FROM work_item_artifacts WHERE work_item_id = 'wi_legacy'").all();
  assert.ok(artifactRows.results.some((row) => row.artifact === "/api/login"));
  // E1: both indices are backfilled from the same pass, not two independent ones each
  // filtering on the shared artifacts_indexed_at flag — the real bug that shape would
  // produce is the second index silently never getting backfilled at all, since the
  // first pass to finish already consumed the "needs indexing" flag. See blocking.ts's
  // own note on backfillBlockingIndex for the full reasoning.
  const tokenRows = await db.prepare("SELECT token FROM work_item_tokens WHERE work_item_id = 'wi_legacy'").all();
  assert.ok(tokenRows.results.length > 0, "the token index must be backfilled in the same pass as the artifact index, not left empty");
  assert.equal(await backfillBlockingIndex(db, organizationId, projectId), 0, "a backfilled item is never rescanned");
});

test("retrieveCandidates: the artifact retriever reaches past any recency window", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await orgOf(db);
  const ancient = await createItem(db, projectId, "Fix the token refresh in lib/oauth.ts", "r1");
  await db.prepare("UPDATE work_items SET updated_at = now() - interval '900 days' WHERE id = ?").bind(ancient).run();

  const byArtifact = await retrieveCandidates(db, organizationId, projectId, [{ title: "Repair token refresh in lib/oauth.ts" }]);
  assert.ok(byArtifact.map((item) => item.id).includes(ancient), "the artifact index must reach past any recency window");
});

test("retrieveCandidates: the rare-token retriever catches a paraphrase with no shared artifact at all", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await orgOf(db);
  const existing = await createItem(db, projectId, "Investigate the intermittent websocket disconnection", "r3");

  const byToken = await retrieveCandidates(db, organizationId, projectId, [{ title: "Diagnose the sporadic websocket disconnection issue" }]);
  assert.ok(byToken.map((item) => item.id).includes(existing), "sharing the distinctive word 'websocket'/'disconnection' must retrieve this candidate with no artifact in either title");
});

// E1 (RECONCILIATION_ARCHITECTURE.md §5) deliberately removes the old recency-window
// fallback: it was finding F2's actual bug, not a safety net worth keeping. A proposal
// that shares neither a concrete artifact nor a distinctive word with anything in the
// project retrieves nothing, and that is the correct answer, not a regression — recall
// on the golden set (tests/blocking.test.mjs) is what actually proves this is safe.
test("retrieveCandidates: a proposal sharing no artifact and no distinctive word with anything retrieves nothing at all", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await orgOf(db);
  await createItem(db, projectId, "Rotate the signing keys for the payment webhook", "r4");

  const candidates = await retrieveCandidates(db, organizationId, projectId, [{ title: "Improve accessibility contrast on the settings page" }]);
  assert.deepEqual(candidates, []);
});

test("retrieveCandidates never crosses a project boundary", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, principal, { action: "create_project", name: "Other", idempotencyKey: "rp2" })).projectId;
  await createItem(db, projectB, "Add rate limiting to /api/login", "x1");

  const candidates = await retrieveCandidates(db, await orgOf(db), projectA, [{ title: "Add rate limiting to /api/login" }]);
  assert.deepEqual(candidates, [], "the same task in two projects is two different tasks");
});

test("merging clears the loser's index entries and restoring it rebuilds them", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await orgOf(db);
  const winner = await createItem(db, projectId, "Add rate limiting to /api/login", "mw");
  const loser = await createItem(db, projectId, "Throttle the /api/login endpoint", "ml");
  await executeCommand(db, principal, { action: "merge_items", projectId, winnerItemId: winner, loserItemId: loser, idempotencyKey: "mrg" });

  const afterMerge = await db.prepare("SELECT COUNT(*) AS count FROM work_item_artifacts WHERE work_item_id = ?").bind(loser).first();
  assert.equal(Number(afterMerge.count), 0);

  const alias = await db.prepare("SELECT id FROM work_item_aliases WHERE archived_work_item_id = ?").bind(loser).first();
  await executeCommand(db, principal, { action: "split_alias", projectId, aliasId: alias.id, idempotencyKey: "split" });
  assert.equal(await backfillBlockingIndex(db, organizationId, projectId), 1, "the restored item is queued for re-indexing");
  const rebuilt = await db.prepare("SELECT COUNT(*) AS count FROM work_item_artifacts WHERE work_item_id = ?").bind(loser).first();
  assert.ok(Number(rebuilt.count) > 0);
});

test("artifact kinds are classified", () => {
  assert.equal(classifyArtifact("/api/login"), "endpoint");
  assert.equal(classifyArtifact("lib/store.ts"), "file");
  assert.equal(classifyArtifact("DATABASE_URL"), "env");
  assert.equal(classifyArtifact("refreshAccessToken"), "symbol");
  assert.equal(classifyArtifact("#42"), "key");
});

// ── 3. F5 — grouped unlock counts ────────────────────────────────────────────────────

test("unlock counts are correct with no dependencies at all", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const a = await createItem(db, projectId, "Standalone one", "n1");
  const b = await createItem(db, projectId, "Standalone two", "n2");
  for (const [index, id] of [a, b].entries()) {
    await transition(db, projectId, id, "planned", `np${index}`);
    await transition(db, projectId, id, "ready", `nr${index}`);
  }

  const result = await getReadyWork(db, principal, { projectId });
  assert.equal(result.workItems.length, 2);
  assert.ok(result.workItems.every((item) => item.unlockCount === 0));
  assert.ok(result.workItems.every((item) => item.reason === "Unblocked and ready."));
});

test("unlock counts stay per-item across many candidates in one grouped query", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);

  // Three ready items unlocking 2, 1 and 0 downstream tasks respectively.
  const ready = [];
  for (const [index, unlocks] of [2, 1, 0].entries()) {
    const id = await createItem(db, projectId, `Prerequisite ${index}`, `g${index}`);
    await transition(db, projectId, id, "planned", `gp${index}`);
    await transition(db, projectId, id, "ready", `gr${index}`);
    for (let n = 0; n < unlocks; n += 1) {
      const dependent = await createItem(db, projectId, `Dependent ${index}-${n}`, `gd${index}-${n}`);
      await executeCommand(db, principal, { action: "add_dependency", projectId, fromWorkItemId: id, toWorkItemId: dependent, type: "blocks", idempotencyKey: `ge${index}-${n}` });
    }
    ready.push({ id, unlocks });
  }

  const result = await getReadyWork(db, principal, { projectId });
  for (const { id, unlocks } of ready) {
    const found = result.workItems.find((item) => item.id === id);
    assert.equal(found.unlockCount, unlocks, `${id} should unlock ${unlocks}`);
  }
  assert.deepEqual(result.workItems.map((item) => item.unlockCount), [2, 1, 0], "highest unlock count still ranks first");
});
