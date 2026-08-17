/**
 * E5 — the ablation harness. Confirms the with/without comparison actually isolates the
 * embedding retriever's contribution: a paraphrase pair with real (synthetic) vectors
 * loaded is caught with embeddings and missed without them; a pair E1 already has signal
 * for is correctly excluded from the paraphrase population entirely, since it proves
 * nothing about the tier either way.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { setupProject, createItem } from "./support/fixtures.mjs";
import { vectorLiteral } from "../lib/dedup/embedding.ts";
import { backfillEmbeddingIndex } from "../lib/dedup/embedding-index.ts";
import { measureEmbeddingAblation } from "../lib/dedup/embedding-eval.ts";
import { captureLabelStatement } from "../lib/dedup/labels.ts";
import { adjudicate } from "../lib/dedup/match.ts";
import { buildSignature } from "../lib/dedup/signature.ts";

function pad(vec, dim = 256) {
  return [...vec, ...new Array(dim - vec.length).fill(0)];
}

async function seedVectors(db, entries) {
  for (const [token, vec] of entries) {
    await db.prepare("INSERT INTO token_vectors (token, vec, weight) VALUES (?, ?, 1) ON CONFLICT (token) DO NOTHING").bind(token, vectorLiteral(vec)).run();
  }
}

async function label(db, organizationId, projectId, leftId, leftTitle, rightId, rightTitle, verdict) {
  const leftSig = buildSignature(leftTitle);
  const rightSig = buildSignature(rightTitle);
  const adjudication = adjudicate({ signature: leftSig, fingerprintValue: leftSig.normalized }, {
    id: rightId, itemKey: "", title: rightTitle, status: "proposed", signature: rightSig, fingerprintValue: rightSig.normalized,
  });
  await db.batch([captureLabelStatement(db, {
    organizationId, projectId, leftItemId: leftId, rightItemId: rightId, verdict, confidence: "high", source: "split", adjudication,
  })]);
}

test("measureEmbeddingAblation: a true paraphrase (no shared artifact/token) is caught with embeddings, missed without", async () => {
  const db = await createTestDb();
  await seedVectors(db, [["charg", pad([1, 0, 0])], ["invoic", pad([0.95, 0.05, 0])]]);
  const projectId = await setupProject(db);
  const organizationId = (await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(projectId).first()).organization_id;
  const olderId = await createItem(db, projectId, "Fix the charging pipeline");
  const newerId = await createItem(db, projectId, "Fix the invoicing system");
  await backfillEmbeddingIndex(db, organizationId, projectId);
  await label(db, organizationId, projectId, olderId, "Fix the charging pipeline", newerId, "Fix the invoicing system", "same");

  const itemsById = new Map([
    [olderId, { projectId, title: "Fix the charging pipeline", createdAt: "2026-01-01T00:00:00Z" }],
    [newerId, { projectId, title: "Fix the invoicing system", createdAt: "2026-01-02T00:00:00Z" }],
  ]);
  const labels = [{ leftItemId: olderId, rightItemId: newerId, verdict: "same" }];

  const report = await measureEmbeddingAblation(db, organizationId, labels, itemsById);
  assert.equal(report.paraphraseTotal, 1);
  assert.equal(report.recallWithEmbeddings, 1);
  assert.equal(report.recallWithoutEmbeddings, 0);
  assert.deepEqual(report.improvedPairs, [{ olderItemId: olderId, newerItemId: newerId }]);
});

test("measureEmbeddingAblation: a pair E1 already catches (shared token) is excluded from the paraphrase population", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = (await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(projectId).first()).organization_id;
  const olderId = await createItem(db, projectId, "Add rate limiting to login");
  const newerId = await createItem(db, projectId, "Add rate limiting for login");

  const itemsById = new Map([
    [olderId, { projectId, title: "Add rate limiting to login", createdAt: "2026-01-01T00:00:00Z" }],
    [newerId, { projectId, title: "Add rate limiting for login", createdAt: "2026-01-02T00:00:00Z" }],
  ]);
  const labels = [{ leftItemId: olderId, rightItemId: newerId, verdict: "same" }];

  const report = await measureEmbeddingAblation(db, organizationId, labels, itemsById);
  assert.equal(report.paraphraseTotal, 0);
});

test("measureEmbeddingAblation: with an empty token_vectors table, recall with and without embeddings is identical (the paraphrase case cannot improve without real weights)", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = (await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(projectId).first()).organization_id;
  const olderId = await createItem(db, projectId, "Fix the charging pipeline");
  const newerId = await createItem(db, projectId, "Fix the invoicing system");

  const itemsById = new Map([
    [olderId, { projectId, title: "Fix the charging pipeline", createdAt: "2026-01-01T00:00:00Z" }],
    [newerId, { projectId, title: "Fix the invoicing system", createdAt: "2026-01-02T00:00:00Z" }],
  ]);
  const labels = [{ leftItemId: olderId, rightItemId: newerId, verdict: "same" }];

  const report = await measureEmbeddingAblation(db, organizationId, labels, itemsById);
  assert.equal(report.paraphraseTotal, 1);
  assert.equal(report.recallWithEmbeddings, report.recallWithoutEmbeddings);
  assert.equal(report.improvedPairs.length, 0);
});

test("measureEmbeddingAblation: an empty label set reports zero paraphrase pairs and 100% recall by the ratio(0,0)=1 convention, not NaN", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = (await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(projectId).first()).organization_id;
  const report = await measureEmbeddingAblation(db, organizationId, [], new Map());
  assert.equal(report.paraphraseTotal, 0);
  assert.equal(report.recallWithEmbeddings, 1);
  assert.equal(report.recallWithoutEmbeddings, 1);
});
