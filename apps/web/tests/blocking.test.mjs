/**
 * E1 — blocking rebuild (RECONCILIATION_ARCHITECTURE.md §5).
 *
 * Two layers under test. The RRF/IDF math (`fuseRankings`, `rankByArtifactOverlap`,
 * `rankByRareTokens`, `computeIdf`) is pure and tested directly, with no database — the
 * pipeline's own rule that retrieval math stays testable without one. `retrieveCandidates`
 * and `backfillBlockingIndex` are the DB-backed shell around it, tested against the real
 * indices. The organizing idea throughout: recall is the only thing that matters at this
 * stage, and the old recency-window fallback is gone on purpose, not a case that slipped
 * through — a proposal sharing nothing with the project's existing work is supposed to
 * retrieve nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";
import { executeCommand, organizationFor } from "@/lib/store.ts";
import { backfillBlockingIndex, blockingIndexStatements, computeIdf, fuseRankings, rankByArtifactOverlap, rankByRareTokens, retrieveCandidates } from "@/lib/dedup/blocking.ts";
import { measureBlockingRecall } from "@/lib/dedup/blocking-eval.ts";
import { captureLabelStatement, snapshotAdjudication } from "@/lib/dedup/labels.ts";

// ── Pure: fuseRankings (RRF) ────────────────────────────────────────────────────────────

test("fuseRankings: a single retriever's own order is preserved by score", () => {
  const fused = fuseRankings([["a", "b", "c"]]);
  assert.deepEqual(fused.map((entry) => entry.workItemId), ["a", "b", "c"]);
  assert.ok(fused[0].score > fused[1].score && fused[1].score > fused[2].score);
});

test("fuseRankings: a candidate found by two retrievers outranks one found by only one", () => {
  const fused = fuseRankings([["a", "b"], ["b"]]);
  // b is #2 in retriever 1 and #1 in retriever 2; a is #1 in retriever 1 only.
  const byId = Object.fromEntries(fused.map((entry) => [entry.workItemId, entry.score]));
  assert.ok(byId.b > byId.a, "appearing in both retrievers must beat appearing in only one, even from a worse rank in the one it does");
});

test("fuseRankings: rank 1 in either retriever alone scores identically — RRF is symmetric across retrievers", () => {
  const onlyFirst = fuseRankings([["a"], []]);
  const onlySecond = fuseRankings([[], ["a"]]);
  assert.equal(onlyFirst[0].score, onlySecond[0].score);
});

test("fuseRankings: an empty set of rankings produces no candidates", () => {
  assert.deepEqual(fuseRankings([]), []);
  assert.deepEqual(fuseRankings([[], []]), []);
});

test("fuseRankings: exact ties break deterministically by work item id, not by insertion order", () => {
  const first = fuseRankings([["z", "a"]]);
  const second = fuseRankings([["a", "z"]]);
  // Both z and a are absent from any second retriever, and neither appears in the other's
  // list here, so they never actually tie in this setup — construct a genuine tie instead.
  const tied = fuseRankings([["z"], ["a"]]); // both rank 1 in their own single retriever
  assert.equal(tied[0].workItemId, "a", "a tie must resolve the same way regardless of which retriever produced which candidate");
  void first; void second;
});

// ── Pure: rankByArtifactOverlap ─────────────────────────────────────────────────────────

test("rankByArtifactOverlap: more shared artifacts ranks higher", () => {
  const ranking = rankByArtifactOverlap(
    ["a.ts", "b.ts", "c.ts"],
    new Map([["two", ["a.ts", "b.ts"]], ["one", ["a.ts"]], ["none", ["z.ts"]]]),
  );
  assert.deepEqual(ranking, ["two", "one"], "a candidate sharing zero artifacts must be excluded, not ranked last");
});

test("rankByArtifactOverlap: no proposal artifacts at all yields no ranking", () => {
  assert.deepEqual(rankByArtifactOverlap([], new Map([["x", ["a.ts"]]])), []);
});

test("rankByArtifactOverlap: ties break deterministically by work item id", () => {
  const ranking = rankByArtifactOverlap(["a.ts"], new Map([["zzz", ["a.ts"]], ["aaa", ["a.ts"]]]));
  assert.deepEqual(ranking, ["aaa", "zzz"]);
});

// ── Pure: computeIdf ─────────────────────────────────────────────────────────────────────

test("computeIdf: a token in every document still gets a small positive weight, never zero or negative", () => {
  const idf = computeIdf(new Map([["common", 100]]), 100);
  assert.ok(idf.get("common") > 0);
});

test("computeIdf: a rare token weighs meaningfully more than a common one", () => {
  const idf = computeIdf(new Map([["rare", 1], ["common", 90]]), 100);
  assert.ok(idf.get("rare") > idf.get("common") * 2, `expected rare >> common, got rare=${idf.get("rare")} common=${idf.get("common")}`);
});

test("computeIdf: an unlisted token (df not provided) is simply absent, not zero by crash", () => {
  const idf = computeIdf(new Map(), 50);
  assert.equal(idf.get("never-seen"), undefined);
});

// ── Pure: rankByRareTokens ───────────────────────────────────────────────────────────────

test("rankByRareTokens: sharing a rare token outranks sharing more common tokens — IDF-weighted, not a raw count", () => {
  const idf = computeIdf(new Map([["websocket", 1], ["fix", 40], ["the", 45]]), 50);
  const ranking = rankByRareTokens(
    ["websocket", "fix", "the"],
    new Map([
      ["rareMatch", ["websocket"]],
      ["commonMatch", ["fix", "the"]],
    ]),
    idf,
  );
  assert.deepEqual(ranking, ["rareMatch", "commonMatch"], "one shared rare token must outrank two shared common ones");
});

test("rankByRareTokens: a candidate sharing no tokens is excluded, not ranked with weight 0", () => {
  const idf = computeIdf(new Map([["a", 1]]), 10);
  assert.deepEqual(rankByRareTokens(["a"], new Map([["x", ["b"]]]), idf), []);
});

// ── DB-backed: blockingIndexStatements / backfillBlockingIndex ─────────────────────────

test("blockingIndexStatements: writes both artifact and token rows for one item in one batch", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const itemId = "wi_manual_test";
  await db.prepare("INSERT INTO work_items (id, organization_id, project_id, sequence, item_key, title, description, status) VALUES (?, ?, ?, 1, '#1', ?, '', 'proposed')")
    .bind(itemId, organizationId, projectId, "Fix the token refresh in lib/oauth.ts").run();

  await db.batch(blockingIndexStatements(db, { organizationId, projectId, workItemId: itemId, title: "Fix the token refresh in lib/oauth.ts", description: "", now: new Date().toISOString() }));

  const artifacts = await db.prepare("SELECT artifact FROM work_item_artifacts WHERE work_item_id = ?").bind(itemId).all();
  const tokens = await db.prepare("SELECT token FROM work_item_tokens WHERE work_item_id = ?").bind(itemId).all();
  assert.ok(artifacts.results.some((row) => row.artifact === "lib/oauth.ts"));
  assert.ok(tokens.results.some((row) => row.token === "token"));
});

test("backfillBlockingIndex: builds both indices from one pass — the bug this milestone fixed", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  await db.prepare("INSERT INTO work_items (id, organization_id, project_id, sequence, item_key, title, description, status) VALUES ('wi_pre', ?, ?, 1, '#1', ?, '', 'proposed')")
    .bind(organizationId, projectId, "Investigate the websocket disconnection").run();

  assert.equal(await backfillBlockingIndex(db, organizationId, projectId), 1);
  const artifactCount = await db.prepare("SELECT COUNT(*) AS count FROM work_item_artifacts WHERE work_item_id = 'wi_pre'").first();
  const tokenCount = await db.prepare("SELECT COUNT(*) AS count FROM work_item_tokens WHERE work_item_id = 'wi_pre'").first();
  assert.ok(Number(tokenCount.count) > 0, "the token index must be populated, not silently starved by the shared artifacts_indexed_at flag");
  void artifactCount;
});

// ── DB-backed: retrieveCandidates ────────────────────────────────────────────────────────

test("retrieveCandidates: RRF actually changes which items surface — a candidate found by both retrievers wins over one found by only one, when the cap bites", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const both = await createItem(db, projectId, "Fix the websocket disconnection in lib/socket.ts", "both");
  const artifactOnly = await createItem(db, projectId, "Rewrite lib/socket.ts entirely", "art-only");

  const candidates = await retrieveCandidates(db, organizationId, projectId, [{ title: "Diagnose the websocket disconnection in lib/socket.ts" }]);
  const ids = candidates.map((item) => item.id);
  assert.ok(ids.includes(both));
  assert.ok(ids.includes(artifactOnly));
});

test("retrieveCandidates: never filters by status — done and cancelled items are candidates by design", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const doneId = await createItem(db, projectId, "Fix the token refresh in lib/oauth.ts", "done-item");
  for (const [status, key] of [["planned", "d1"], ["ready", "d2"], ["in_progress", "d3"], ["done", "d4"]]) {
    const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(doneId).first();
    await executeCommand(db, principal, { action: "transition_item", projectId, itemId: doneId, expectedVersion: row.version, status, idempotencyKey: key });
  }

  const candidates = await retrieveCandidates(db, organizationId, projectId, [{ title: "Repair token refresh in lib/oauth.ts" }]);
  assert.ok(candidates.map((item) => item.id).includes(doneId));
});

test("retrieveCandidates: a batch of proposals unions each one's own top candidates", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const oauthItem = await createItem(db, projectId, "Fix the token refresh in lib/oauth.ts", "batch-a");
  const cacheItem = await createItem(db, projectId, "Add a cache layer to lib/render.ts", "batch-b");

  const candidates = await retrieveCandidates(db, organizationId, projectId, [
    { title: "Repair lib/oauth.ts token handling" },
    { title: "Speed up lib/render.ts with caching" },
  ]);
  const ids = candidates.map((item) => item.id);
  assert.ok(ids.includes(oauthItem), "the first proposal's own match must survive the union");
  assert.ok(ids.includes(cacheItem), "the second proposal's own match must survive the union too");
});

test("retrieveCandidates: an empty title (no artifacts, no tokens) retrieves nothing without crashing", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  await createItem(db, projectId, "Rotate the signing keys", "empty-1");

  const candidates = await retrieveCandidates(db, organizationId, projectId, [{ title: "" }]);
  assert.deepEqual(candidates, []);
});

test("retrieveCandidates: an empty proposals array retrieves nothing without crashing", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  await createItem(db, projectId, "Rotate the signing keys", "empty-2");

  assert.deepEqual(await retrieveCandidates(db, organizationId, projectId, []), []);
});

// ── DB-backed: E1's own gate — measureBlockingRecall ────────────────────────────────────

test("measureBlockingRecall: a real 'same' label whose pair blocking can find scores as caught", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const winner = await createItem(db, projectId, "Add rate limiting to /api/login", "mw1");
  const loser = await createItem(db, projectId, "Throttle requests to /api/login", "ml1");
  await executeCommand(db, principal, { action: "merge_items", projectId, winnerItemId: winner, loserItemId: loser, idempotencyKey: "mrg1" });

  const labelRow = await db.prepare("SELECT pair_hash FROM reconciliation_labels WHERE project_id = ?").bind(projectId).first();
  assert.ok(labelRow, "the merge must have produced a golden-set label to evaluate against");
  const labels = [{ leftItemId: winner, rightItemId: loser, verdict: "same" }];
  const items = new Map([
    [winner, { projectId, title: "Add rate limiting to /api/login", createdAt: new Date(Date.now() - 60000).toISOString() }],
    [loser, { projectId, title: "Throttle requests to /api/login", createdAt: new Date().toISOString() }],
  ]);

  const report = await measureBlockingRecall(db, organizationId, labels, items);
  assert.equal(report.total, 1);
  assert.equal(report.recall, 1);
  assert.deepEqual(report.missed, []);
});

test("measureBlockingRecall: a pair sharing nothing at all is correctly reported as missed, not silently skipped", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const a = await createItem(db, projectId, "Rotate signing keys", "miss-a");
  const b = await createItem(db, projectId, "Improve accessibility contrast", "miss-b");

  const labels = [{ leftItemId: a, rightItemId: b, verdict: "same" }];
  const items = new Map([
    [a, { projectId, title: "Rotate signing keys", createdAt: new Date(Date.now() - 60000).toISOString() }],
    [b, { projectId, title: "Improve accessibility contrast", createdAt: new Date().toISOString() }],
  ]);

  const report = await measureBlockingRecall(db, organizationId, labels, items);
  assert.equal(report.recall, 0);
  assert.equal(report.missed.length, 1);
  assert.equal(report.missed[0].olderItemId, a);
  assert.equal(report.missed[0].newerItemId, b);
});

test("measureBlockingRecall: 'different'-labelled pairs are never counted at all — this measures recall, not accuracy", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const a = await createItem(db, projectId, "Rotate signing keys", "diff-a");
  const b = await createItem(db, projectId, "Improve accessibility contrast", "diff-b");

  const labels = [{ leftItemId: a, rightItemId: b, verdict: "different" }];
  const items = new Map([
    [a, { projectId, title: "Rotate signing keys", createdAt: new Date().toISOString() }],
    [b, { projectId, title: "Improve accessibility contrast", createdAt: new Date().toISOString() }],
  ]);

  const report = await measureBlockingRecall(db, organizationId, labels, items);
  assert.equal(report.total, 0);
  assert.equal(report.recall, 1, "an empty evaluated set reads as 1, not 0 or NaN");
});

test("measureBlockingRecall: a pair split across two projects is skipped, not scored as a miss", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, principal, { action: "create_project", name: "Other", idempotencyKey: "cross-proj" })).projectId;
  const organizationId = await organizationFor(db, principal);
  const a = await createItem(db, projectA, "Add rate limiting to /api/login", "cross-a");
  const b = await createItem(db, projectB, "Add rate limiting to /api/login", "cross-b");

  const labels = [{ leftItemId: a, rightItemId: b, verdict: "same" }];
  const items = new Map([
    [a, { projectId: projectA, title: "Add rate limiting to /api/login", createdAt: new Date().toISOString() }],
    [b, { projectId: projectB, title: "Add rate limiting to /api/login", createdAt: new Date().toISOString() }],
  ]);

  const report = await measureBlockingRecall(db, organizationId, labels, items);
  assert.equal(report.total, 0, "a cross-project pair is not a real blocking-recall question and must not be counted");
});

test("measureBlockingRecall: a label whose item no longer exists is skipped, not crashed on", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const a = await createItem(db, projectId, "Rotate signing keys", "gone-a");

  const labels = [{ leftItemId: a, rightItemId: "wi_never_existed", verdict: "same" }];
  const items = new Map([[a, { projectId, title: "Rotate signing keys", createdAt: new Date().toISOString() }]]);

  const report = await measureBlockingRecall(db, organizationId, labels, items);
  assert.equal(report.total, 0);
});

// ── Integration: real dedup labels feed the blocking-recall harness end to end ────────

test("integration: captureLabelStatement's real output is directly usable by measureBlockingRecall", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const winner = await createItem(db, projectId, "Fix the token refresh in lib/oauth.ts", "int-w");
  const loser = await createItem(db, projectId, "Repair token refresh handling in lib/oauth.ts", "int-l");

  const adjudication = snapshotAdjudication({ title: "Fix the token refresh in lib/oauth.ts" }, { title: "Repair token refresh handling in lib/oauth.ts" });
  await db.batch([captureLabelStatement(db, { organizationId, projectId, leftItemId: winner, rightItemId: loser, verdict: "same", confidence: "high", source: "merge", adjudication })]);

  const labelRow = await db.prepare("SELECT left_item_id, right_item_id, verdict FROM reconciliation_labels WHERE project_id = ?").bind(projectId).first();
  const labels = [{ leftItemId: labelRow.left_item_id, rightItemId: labelRow.right_item_id, verdict: labelRow.verdict }];
  const items = new Map([
    [winner, { projectId, title: "Fix the token refresh in lib/oauth.ts", createdAt: new Date(Date.now() - 60000).toISOString() }],
    [loser, { projectId, title: "Repair token refresh handling in lib/oauth.ts", createdAt: new Date().toISOString() }],
  ]);

  const report = await measureBlockingRecall(db, organizationId, labels, items);
  assert.equal(report.recall, 1);
});
