/**
 * E8 — direct tests for `lib/dedup/relate.ts`, the one module
 * RECONCILIATION_ARCHITECTURE.md §10 asks for. Confirms it agrees with the underlying
 * cascade it wraps (`adjudicate`/`classifyRelation`/`explain`) rather than being a
 * second, independent implementation — the exact "two matchers" risk §10 warns about,
 * checked directly rather than assumed away by construction.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildSignature } from "../lib/dedup/signature.ts";
import { adjudicate, explain } from "../lib/dedup/match.ts";
import { classifyRelation } from "../lib/dedup/relations.ts";
import { relate } from "../lib/dedup/relate.ts";

function candidateOf(id, itemKey, title, status = "ready") {
  return { id, itemKey, title, status };
}

test("relate: a duplicate pair (identical signature) agrees with adjudicate/classifyRelation/explain", () => {
  const result = relate({ title: "Add user authentication" }, candidateOf("wi_1", "#1", "Implement user authentication"));
  const signature = buildSignature("Add user authentication");
  const candidateSignature = buildSignature("Implement user authentication");
  const proposalInput = { signature, fingerprintValue: signature.normalized };
  const candidateFull = { id: "wi_1", itemKey: "#1", title: "Implement user authentication", status: "ready", signature: candidateSignature, fingerprintValue: candidateSignature.normalized };
  const expectedAdjudication = adjudicate(proposalInput, candidateFull);
  const expectedRelation = classifyRelation(proposalInput, candidateFull);

  assert.equal(result.verdict, expectedAdjudication.verdict);
  assert.equal(result.verdict, "duplicate");
  assert.equal(result.relation, expectedRelation.type);
  assert.equal(result.score, expectedAdjudication.score);
  assert.equal(result.reason, expectedAdjudication.reason);
  assert.equal(result.explanation, explain({ ...expectedAdjudication, candidate: candidateFull }));
});

test("relate: a conflict pair (antonym actions, shared artifact) reports verdict conflict and relation CONFLICT", () => {
  const result = relate({ title: "Add lib/auth/middleware.ts" }, candidateOf("wi_2", "#2", "Remove lib/auth/middleware.ts"));
  assert.equal(result.verdict, "conflict");
  assert.equal(result.relation, "CONFLICT");
  assert.match(result.explanation, /middleware\.ts/);
});

test("relate: a genuinely unrelated pair is verdict distinct, relation NEW", () => {
  const result = relate({ title: "Improve onboarding copy" }, candidateOf("wi_3", "#3", "Speed up the search index"));
  assert.equal(result.verdict, "distinct");
  assert.equal(result.relation, "NEW");
});

test("relate: a subset artifact relationship is surfaced as relation SUBSET even though the verdict is only possible", () => {
  const result = relate({ title: "Update lib/dedup/blocking.ts" }, candidateOf("wi_4", "#4", "Update lib/dedup/blocking.ts and lib/dedup/features.ts and lib/dedup/train.ts"));
  assert.equal(result.relation, "SUBSET");
});

test("relate: reason is the short raw phrase, explanation is the full sentence naming the candidate", () => {
  const result = relate({ title: "Add user authentication" }, candidateOf("wi_5", "#5", "Implement user authentication"));
  assert.ok(!result.reason.includes("#5"), "the short reason should not itself repeat the item key");
  assert.ok(result.explanation.includes("#5"), "the full explanation should name the candidate");
});

test("relate: a pre-built signature is reused rather than recomputed (memoization contract)", () => {
  const signature = buildSignature("Add user authentication");
  // A signature deliberately inconsistent with the title, to prove relate() actually
  // used the *signature* argument rather than silently recomputing from `title`.
  const result = relate({ title: "Completely unrelated text", signature }, candidateOf("wi_6", "#6", "Implement user authentication"));
  assert.equal(result.verdict, "duplicate");
});
