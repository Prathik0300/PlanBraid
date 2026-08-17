/**
 * E5 — static embedding tier tests. Two layers: pure vector math (`lib/dedup/embedding.ts`,
 * this file) and the DB-backed indexing/retrieval built on top of it
 * (`tests/embedding-index.test.mjs`). Every test here uses small, hand-built vectors —
 * there is no real distilled model in this environment (see embedding.ts's own module
 * comment) — so these prove the *math* is correct, not that it captures real semantic
 * similarity.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EMBEDDING_DIM, cosineSimilarity, meanPool, parseVectorLiteral, vectorLiteral } from "../lib/dedup/embedding.ts";

test("meanPool: a single vector with weight 1 pools to itself", () => {
  const pooled = meanPool([{ vec: [1, 2, 3], weight: 1 }]);
  assert.deepEqual(pooled, [1, 2, 3]);
});

test("meanPool: two equally-weighted vectors average componentwise", () => {
  const pooled = meanPool([{ vec: [0, 0, 0], weight: 1 }, { vec: [2, 4, 6], weight: 1 }]);
  assert.deepEqual(pooled, [1, 2, 3]);
});

test("meanPool: a heavier weight pulls the pool toward it", () => {
  const pooled = meanPool([{ vec: [0, 0], weight: 1 }, { vec: [10, 10], weight: 3 }]);
  assert.deepEqual(pooled, [7.5, 7.5]);
});

test("meanPool: an empty list is null, not a zero vector", () => {
  assert.equal(meanPool([]), null);
});

test("meanPool: zero total weight is null, not a division by zero producing NaN/Infinity", () => {
  const pooled = meanPool([{ vec: [1, 2], weight: 0 }, { vec: [3, 4], weight: 0 }]);
  assert.equal(pooled, null);
});

test("cosineSimilarity: identical vectors are 1", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});

test("cosineSimilarity: orthogonal vectors are 0", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosineSimilarity: opposite vectors are -1", () => {
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
});

test("cosineSimilarity: a zero vector on either side is 0, not NaN from a division by zero", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([1, 1], [0, 0]), 0);
  assert.ok(Number.isFinite(cosineSimilarity([0, 0], [0, 0])));
});

test("cosineSimilarity: scale-invariant — a scaled copy of a vector is still similarity 1", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [2, 4, 6]), 1);
});

test("vectorLiteral / parseVectorLiteral: round-trips through pgvector's text format", () => {
  const vec = [0.1, -0.5, 2, 0];
  const literal = vectorLiteral(vec);
  assert.equal(literal, "[0.1,-0.5,2,0]");
  assert.deepEqual(parseVectorLiteral(literal), vec);
});

test("parseVectorLiteral: an empty vector literal parses to an empty array, not [NaN]", () => {
  assert.deepEqual(parseVectorLiteral("[]"), []);
});

test("EMBEDDING_DIM matches the schema's vector(256) columns", () => {
  assert.equal(EMBEDDING_DIM, 256);
});
