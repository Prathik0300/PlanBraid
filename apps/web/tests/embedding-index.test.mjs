/**
 * E5 — DB-backed embedding indexing and retrieval. `token_vectors` is seeded here with
 * small, hand-built vectors for a handful of words — not the real distilled model, which
 * doesn't exist in this environment (see lib/dedup/embedding.ts's module comment) — so
 * these tests prove the pipeline (indexing, backfill, ANN retrieval, and the "empty table
 * changes nothing" invariant) is correct, not that it captures real semantic similarity.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { setupProject, createItem } from "./support/fixtures.mjs";
import { vectorLiteral } from "../lib/dedup/embedding.ts";
import { backfillEmbeddingIndex, embeddingIndexStatements, retrieveByEmbedding } from "../lib/dedup/embedding-index.ts";
import { retrieveCandidates } from "../lib/dedup/blocking.ts";

/** Two clearly-separated clusters in a tiny embedding space: "payment" words near
 * [1,0,0,...], "onboarding" words near [0,1,0,...] — enough to prove nearest-neighbor
 * retrieval and cosine ranking work, without claiming these numbers mean anything
 * semantically the way a real distilled model's would. */
async function seedVectors(db, entries) {
  for (const [token, vec] of entries) {
    await db.prepare("INSERT INTO token_vectors (token, vec, weight) VALUES (?, ?, 1) ON CONFLICT (token) DO NOTHING")
      .bind(token, vectorLiteral(vec)).run();
  }
}

function pad(vec, dim = 256) {
  return [...vec, ...new Array(dim - vec.length).fill(0)];
}

test("embeddingIndexStatements: computes and stores a pooled embedding when token_vectors has matching rows", async () => {
  const db = await createTestDb();
  await seedVectors(db, [["charg", pad([1, 0, 0])], ["retri", pad([0.9, 0.1, 0])]]);

  const statements = await embeddingIndexStatements(db, {
    organizationId: "org1", projectId: "proj1", workItemId: "wi1",
    title: "Add retry to charge processing", description: "", now: new Date().toISOString(),
  });
  await db.batch(statements);

  const row = await db.prepare("SELECT embedding FROM work_item_embeddings WHERE work_item_id = ?").bind("wi1").first();
  assert.ok(row, "an embedding row should have been written");
});

test("embeddingIndexStatements: no matching tokens leaves no embedding row (token_vectors empty is the default state)", async () => {
  const db = await createTestDb();
  const statements = await embeddingIndexStatements(db, {
    organizationId: "org1", projectId: "proj1", workItemId: "wi1",
    title: "Add retry to charge processing", description: "", now: new Date().toISOString(),
  });
  await db.batch(statements);

  const row = await db.prepare("SELECT embedding FROM work_item_embeddings WHERE work_item_id = ?").bind("wi1").first();
  assert.equal(row, null);
  const item = await db.prepare("SELECT embeddings_indexed_at FROM work_items WHERE id = ?").bind("wi1").first();
  // The item doesn't exist in this test (no create_item call) so this just confirms the
  // statement batch didn't error — the real "flag gets stamped" behavior is covered by
  // the backfill test below, against a real item.
  assert.equal(item, null);
});

test("embeddingIndexStatements: an edit that removes every matching token deletes the stale embedding", async () => {
  const db = await createTestDb();
  await seedVectors(db, [["charg", pad([1, 0, 0])]]);
  await db.batch(await embeddingIndexStatements(db, {
    organizationId: "org1", projectId: "proj1", workItemId: "wi1",
    title: "Fix charging", description: "", now: new Date().toISOString(),
  }));
  assert.ok(await db.prepare("SELECT 1 FROM work_item_embeddings WHERE work_item_id = ?").bind("wi1").first());

  await db.batch(await embeddingIndexStatements(db, {
    organizationId: "org1", projectId: "proj1", workItemId: "wi1",
    title: "Improve onboarding copy", description: "", now: new Date().toISOString(),
  }));
  assert.equal(await db.prepare("SELECT 1 FROM work_item_embeddings WHERE work_item_id = ?").bind("wi1").first(), null);
});

test("backfillEmbeddingIndex: indexes real pre-existing items and stamps embeddings_indexed_at, using its own flag separate from artifacts_indexed_at", async () => {
  const db = await createTestDb();
  await seedVectors(db, [["charg", pad([1, 0, 0])], ["retri", pad([0.9, 0.1, 0])]]);
  const projectId = await setupProject(db);
  const itemId = await createItem(db, projectId, "Add retry to charging");

  const before = await db.prepare("SELECT embeddings_indexed_at, artifacts_indexed_at FROM work_items WHERE id = ?").bind(itemId).first();
  assert.equal(before.embeddings_indexed_at, null);
  assert.ok(before.artifacts_indexed_at, "create_item already indexes artifacts/tokens synchronously");

  const organizationId = (await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(projectId).first()).organization_id;
  const indexed = await backfillEmbeddingIndex(db, organizationId, projectId);
  assert.equal(indexed, 1);

  const after = await db.prepare("SELECT embeddings_indexed_at FROM work_items WHERE id = ?").bind(itemId).first();
  assert.ok(after.embeddings_indexed_at);
  assert.ok(await db.prepare("SELECT 1 FROM work_item_embeddings WHERE work_item_id = ?").bind(itemId).first());
});

test("backfillEmbeddingIndex: a second call finds nothing left to do", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = (await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(projectId).first()).organization_id;
  await createItem(db, projectId, "Add retry to charging");

  await backfillEmbeddingIndex(db, organizationId, projectId);
  const second = await backfillEmbeddingIndex(db, organizationId, projectId);
  assert.equal(second, 0);
});

test("retrieveByEmbedding: an empty token_vectors table returns an empty ranking for every proposal, no query issued beyond the lookup", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const rankings = await retrieveByEmbedding(db, projectId, [["add", "charg"], ["fix", "onboard"]], 50);
  assert.deepEqual(rankings, [[], []]);
});

test("retrieveByEmbedding: ranks stored items by cosine distance to the proposal's pooled embedding", async () => {
  const db = await createTestDb();
  await seedVectors(db, [["charg", pad([1, 0, 0])], ["onboard", pad([0, 1, 0])]]);
  const projectId = await setupProject(db);
  const organizationId = (await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(projectId).first()).organization_id;
  const paymentItem = await createItem(db, projectId, "Fix charging bug");
  const onboardingItem = await createItem(db, projectId, "Improve onboarding");
  await backfillEmbeddingIndex(db, organizationId, projectId);

  const [rankingForPaymentProposal] = await retrieveByEmbedding(db, projectId, [["charg"]], 50);
  assert.equal(rankingForPaymentProposal[0], paymentItem);

  const [rankingForOnboardingProposal] = await retrieveByEmbedding(db, projectId, [["onboard"]], 50);
  assert.equal(rankingForOnboardingProposal[0], onboardingItem);
});

test("integration: retrieveCandidates surfaces a paraphrase with no shared artifact or token once embeddings are populated", async () => {
  const db = await createTestDb();
  // "charg" and "invoic" placed near each other in this tiny space — standing in for two
  // words a real static embedding would consider semantically close. "Fix the charging
  // pipeline" and "Fix the invoicing system" share only the action verb ("fix", excluded
  // from object tokens entirely — buildSignature strips it before tokens are computed)
  // and a stopword ("the") — no artifact, no shared object token — so neither the
  // artifact retriever nor E1's rare-token retriever can see this pair at all; only the
  // embedding retriever can.
  await seedVectors(db, [["charg", pad([1, 0, 0])], ["invoic", pad([0.95, 0.05, 0])]]);
  const projectId = await setupProject(db);
  const organizationId = (await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(projectId).first()).organization_id;
  const existingId = await createItem(db, projectId, "Fix the charging pipeline");
  await backfillEmbeddingIndex(db, organizationId, projectId);

  const candidates = await retrieveCandidates(db, organizationId, projectId, [{ title: "Fix the invoicing system" }]);
  assert.ok(candidates.some((item) => item.id === existingId), "the embedding retriever should have surfaced the semantically-close item");
});

test("integration: retrieveCandidates behaves exactly as E1 alone when token_vectors is empty (the tier's inertness invariant)", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = (await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(projectId).first()).organization_id;
  await createItem(db, projectId, "Fix the charging pipeline");

  // No shared artifact, no shared token, and no embedding table populated: this must
  // retrieve nothing, exactly like E1's own documented behavior before E5 existed.
  const candidates = await retrieveCandidates(db, organizationId, projectId, [{ title: "Fix the invoicing system" }]);
  assert.deepEqual(candidates, []);
});
