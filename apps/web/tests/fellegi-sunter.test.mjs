/**
 * E3 — Fellegi-Sunter scorer tests.
 *
 * Three layers: the feature vector (does each of the twelve features bucket correctly,
 * and go missing exactly when it should), the log-odds math (does scoring behave like a
 * probability — missing features are neutral, the sigmoid never overflows), and the
 * assembled path (`adjudicateFs`) end to end against the same kind of hand-built pairs
 * `tests/dedup.test.mjs` uses for the production cascade.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildSignature, fingerprint } from "../lib/dedup/signature.ts";
import { computeFeatures } from "../lib/dedup/features.ts";
import {
  SEED_WEIGHTS, adjudicateFs, decide, probabilityOfMatch, scoreFeatures,
} from "../lib/dedup/fellegi-sunter.ts";

async function proposalOf(title, description = "") {
  const signature = buildSignature(title, description);
  return { signature, fingerprintValue: await fingerprint(signature) };
}

async function candidateOf(title, description = "", { status = "ready", itemKey = "#1", id = "wi_1", updatedAt } = {}) {
  const signature = buildSignature(title, description);
  return { id, itemKey, title, status, updatedAt, signature, fingerprintValue: await fingerprint(signature) };
}

// ---------------------------------------------------------------------------
// features.ts
// ---------------------------------------------------------------------------

test("features: f1 fingerprint — equal only when both signatures are literally identical", async () => {
  const a = await proposalOf("Add user authentication");
  const bSame = await candidateOf("Add authentication for users");
  const bDifferent = await candidateOf("Fix the login button");
  assert.equal(computeFeatures(a, bSame).f1_fingerprint.level, "equal");
  assert.equal(computeFeatures(a, bDifferent).f1_fingerprint.level, "different");
});

test("features: f1 fingerprint — missing when either fingerprint is absent", async () => {
  const a = await proposalOf("Add user authentication");
  const b = await candidateOf("Add user authentication");
  assert.equal(computeFeatures(a, { ...b, fingerprintValue: null }).f1_fingerprint, null);
});

test("features: f2 artifact jaccard — missing only when BOTH sides name zero artifacts", async () => {
  const a = await proposalOf("Add a health check endpoint");
  const b = await candidateOf("Improve error messages");
  assert.equal(computeFeatures(a, b).f2_artifactJaccard, null);
});

test("features: f2 artifact jaccard — a real 'none' when one side has artifacts and the other doesn't", async () => {
  const a = await proposalOf("Update lib/dedup/blocking.ts");
  const b = await candidateOf("Improve error messages");
  assert.equal(computeFeatures(a, b).f2_artifactJaccard.level, "none");
});

test("features: f2 artifact jaccard — buckets shared-file overlap", async () => {
  const a = await proposalOf("Update lib/dedup/blocking.ts");
  const b = await candidateOf("Refactor lib/dedup/blocking.ts");
  assert.equal(computeFeatures(a, b).f2_artifactJaccard.level, "high");
});

test("features: f3 artifact containment — missing when either side names zero artifacts", async () => {
  const a = await proposalOf("Update lib/dedup/blocking.ts");
  const b = await candidateOf("Improve error messages");
  assert.equal(computeFeatures(a, b).f3_artifactContainment, null);
});

test("features: f3 artifact containment — high when one artifact set is a subset of the other", async () => {
  const a = await proposalOf("Update lib/dedup/blocking.ts and lib/dedup/features.ts");
  const b = await candidateOf("Update lib/dedup/blocking.ts");
  assert.equal(computeFeatures(a, b).f3_artifactContainment.level, "high");
});

test("features: f4 symbol overlap — missing when neither side names a symbol", async () => {
  const a = await proposalOf("Update lib/dedup/blocking.ts");
  const b = await candidateOf("Update lib/dedup/features.ts");
  assert.equal(computeFeatures(a, b).f4_symbolOverlap, null);
});

test("features: f4 symbol overlap — high-unresolved when both sides name the same function but no symbol table is supplied (E7)", async () => {
  const a = await proposalOf("Fix refreshAccessToken to handle expiry");
  const b = await candidateOf("Cover refreshAccessToken with a test");
  assert.equal(computeFeatures(a, b).f4_symbolOverlap.level, "high-unresolved");
});

test("features: f4 symbol overlap — high-resolved when the shared name is confirmed against a real symbol table (E7)", async () => {
  const a = await proposalOf("Fix refreshAccessToken to handle expiry");
  const b = await candidateOf("Cover refreshAccessToken with a test");
  const resolved = computeFeatures(a, b, { resolvedSymbols: new Set(["refreshaccesstoken"]) });
  assert.equal(resolved.f4_symbolOverlap.level, "high-resolved");
});

test("features: f4 symbol overlap — an unrelated resolved-symbol set still reads as high-unresolved (the shared name itself isn't confirmed)", async () => {
  const a = await proposalOf("Fix refreshAccessToken to handle expiry");
  const b = await candidateOf("Cover refreshAccessToken with a test");
  const resolved = computeFeatures(a, b, { resolvedSymbols: new Set(["someUnrelatedSymbol"]) });
  assert.equal(resolved.f4_symbolOverlap.level, "high-unresolved");
});

test("features: f5 subsystem — unknown becomes a missing feature, not a level", async () => {
  const a = await proposalOf("Improve error messages");
  const b = await candidateOf("Add a health check endpoint");
  assert.equal(computeFeatures(a, b).f5_subsystem, null);
});

test("features: f5 subsystem — same directory prefix reads as 'same'", async () => {
  const a = await proposalOf("Update lib/dedup/blocking.ts");
  const b = await candidateOf("Update lib/dedup/features.ts");
  assert.equal(computeFeatures(a, b).f5_subsystem.level, "same");
});

test("features: f6 action — 'unknown' verb on either side is a wildcard, not missing", async () => {
  const a = await proposalOf("Frobnicate the widget");
  const b = await candidateOf("Add the widget");
  const observation = computeFeatures(a, b).f6_action;
  assert.notEqual(observation, null);
  assert.equal(observation.level, "compatible");
});

test("features: f6 action — same action class reads as 'same'", async () => {
  const a = await proposalOf("Add user authentication");
  const b = await candidateOf("Implement user authentication");
  assert.equal(computeFeatures(a, b).f6_action.level, "same");
});

test("features: f7 lexical — missing only when neither title tokens nor criteria offer any signal", async () => {
  const a = await proposalOf("Update lib/dedup/blocking.ts");
  const b = await candidateOf("Update lib/dedup/features.ts");
  // Both titles reduce to "update" (an action word, stripped before object tokens) plus
  // an artifact (also stripped) — nothing is left in objectTokens, and neither has criteria.
  assert.equal(computeFeatures(a, b).f7_lexical, null);
});

test("features: f7 lexical — high when title wording overlaps heavily", async () => {
  const a = await proposalOf("Add rate limiting to the login endpoint");
  const b = await candidateOf("Add rate limiting for the login endpoint");
  assert.equal(computeFeatures(a, b).f7_lexical.level, "high");
});

test("features: f9 criteria — missing when neither side has acceptance criteria (the common case)", async () => {
  const a = await proposalOf("Add rate limiting", "Limit requests per IP.");
  const b = await candidateOf("Add rate limiting", "Applies to the login endpoint.");
  assert.equal(computeFeatures(a, b).f9_criteria, null);
});

test("features: f9 criteria — buckets overlapping checklists", async () => {
  const description = "- [ ] rejects after five failed attempts\n- [ ] resets after a successful login";
  const a = await proposalOf("Add rate limiting", description);
  const b = await candidateOf("Throttle repeated logins", description);
  assert.equal(computeFeatures(a, b).f9_criteria.level, "high");
});

test("features: f8/f10/f11 — missing unless the caller supplies external context", async () => {
  const a = await proposalOf("Add rate limiting");
  const b = await candidateOf("Add rate limiting");
  const bare = computeFeatures(a, b);
  assert.equal(bare.f8_embedding, null);
  assert.equal(bare.f10_graphProximity, null);
  assert.equal(bare.f11_implementationOverlap, null);
  const supplied = computeFeatures(a, b, { embeddingCosine: 0.9, graphProximity: 0.5, implementationOverlap: 0.1 });
  assert.equal(supplied.f8_embedding.level, "high");
  assert.equal(supplied.f10_graphProximity.level, "medium");
  assert.equal(supplied.f11_implementationOverlap.level, "low");
});

test("features: f12 temporal — missing unless the caller supplies candidate status", async () => {
  const a = await proposalOf("Add rate limiting");
  const b = await candidateOf("Add rate limiting");
  assert.equal(computeFeatures(a, b).f12_temporal, null);
});

test("features: f12 temporal — active/cancelled/recent-done/stale-done all distinguished", async () => {
  const a = await proposalOf("Add rate limiting");
  const b = await candidateOf("Add rate limiting");
  const now = Date.parse("2026-08-13T00:00:00Z");
  const recent = new Date(now - 2 * 86_400_000).toISOString();
  const stale = new Date(now - 30 * 86_400_000).toISOString();
  assert.equal(computeFeatures(a, b, { candidateStatus: "ready", now }).f12_temporal.level, "candidate-active");
  assert.equal(computeFeatures(a, b, { candidateStatus: "cancelled", now }).f12_temporal.level, "candidate-cancelled");
  assert.equal(computeFeatures(a, b, { candidateStatus: "done", candidateUpdatedAt: recent, now }).f12_temporal.level, "candidate-done-recent");
  assert.equal(computeFeatures(a, b, { candidateStatus: "done", candidateUpdatedAt: stale, now }).f12_temporal.level, "candidate-done-stale");
});

// ---------------------------------------------------------------------------
// fellegi-sunter.ts — the math
// ---------------------------------------------------------------------------

test("fellegi-sunter: a missing feature contributes nothing to the score", async () => {
  const a = await proposalOf("Add rate limiting to the login endpoint");
  const b = await candidateOf("Add rate limiting to the login endpoint");
  const withCriteria = computeFeatures(a, b, { candidateStatus: "ready" });
  const priorOnly = { ...withCriteria, f9_criteria: null };
  const withF9 = { ...withCriteria, f9_criteria: { level: "high" } };
  const scoreWithout = scoreFeatures(priorOnly, SEED_WEIGHTS).logOdds;
  const scoreWith = scoreFeatures(withF9, SEED_WEIGHTS).logOdds;
  // Adding a real high-agreement observation can only raise the log-odds, never lower it
  // below the no-observation baseline — that's the "missing is neutral" property.
  assert.ok(scoreWith > scoreWithout);
});

test("fellegi-sunter: an unrecognized level for a feature that IS in the weight table is skipped like a miss", () => {
  const vector = { f1_fingerprint: { level: "not-a-real-level" } };
  const { logOdds, contributions } = scoreFeatures(vector, SEED_WEIGHTS);
  assert.equal(contributions.length, 0);
  assert.equal(logOdds, scoreFeatures({}, SEED_WEIGHTS).logOdds);
});

test("fellegi-sunter: probabilityOfMatch stays in (0, 1) and never overflows at extreme log-odds", () => {
  assert.ok(probabilityOfMatch(500) > 0.999999);
  assert.ok(probabilityOfMatch(500) <= 1);
  assert.ok(probabilityOfMatch(-500) < 0.000001);
  assert.ok(probabilityOfMatch(-500) >= 0);
  assert.equal(probabilityOfMatch(0), 0.5);
  assert.ok(Number.isFinite(probabilityOfMatch(500)));
  assert.ok(Number.isFinite(probabilityOfMatch(-500)));
});

test("fellegi-sunter: collapse threshold matches the roadmap's own worked example (200:1 -> ~0.995)", () => {
  const table = { ...SEED_WEIGHTS, costRatio: 200 };
  const decision = decide({}, table);
  assert.ok(Math.abs(decision.collapseThreshold - 0.995) < 0.001);
});

test("fellegi-sunter: decide — duplicate only past the collapse threshold, possible in the 0.5+ band, distinct below", () => {
  const highTable = { prior: 0.5, costRatio: 1, weights: { f1_fingerprint: { equal: { m: 0.999, u: 0.001 } } } };
  assert.equal(decide({ f1_fingerprint: { level: "equal" } }, highTable).verdict, "duplicate");
  const mildTable = { prior: 0.5, costRatio: 200, weights: { f7_lexical: { high: { m: 0.6, u: 0.3 } } } };
  assert.equal(decide({ f7_lexical: { level: "high" } }, mildTable).verdict, "possible");
  const noneTable = { prior: 0.02, costRatio: 200, weights: {} };
  assert.equal(decide({}, noneTable).verdict, "distinct");
});

// ---------------------------------------------------------------------------
// adjudicateFs — the assembled path
// ---------------------------------------------------------------------------

test("adjudicateFs: reuses the shared veto — identical fingerprints collapse regardless of the weight table", async () => {
  const a = await proposalOf("Add user authentication");
  const b = await candidateOf("Add authentication for users");
  const decision = adjudicateFs(a, b);
  assert.equal(decision.method, "veto");
  assert.equal(decision.verdict, "duplicate");
});

test("adjudicateFs: reuses the shared veto — antonym actions are always distinct, never scored", async () => {
  const a = await proposalOf("Add the login endpoint");
  const b = await candidateOf("Remove the login endpoint");
  const decision = adjudicateFs(a, b);
  assert.equal(decision.method, "veto");
  assert.equal(decision.verdict, "distinct");
});

test("adjudicateFs: reuses the shared veto — disjoint artifacts are always distinct, never scored", async () => {
  const a = await proposalOf("Rate limit /api/login");
  const b = await candidateOf("Rate limit /api/signup");
  const decision = adjudicateFs(a, b);
  assert.equal(decision.method, "veto");
  assert.equal(decision.verdict, "distinct");
});

test("adjudicateFs: strong non-fingerprint agreement (shared file, same action, overlapping wording) scores high enough to flag", async () => {
  const a = await proposalOf("Add caching to lib/dedup/blocking.ts");
  const b = await candidateOf("Add a cache layer to lib/dedup/blocking.ts", "", { status: "ready" });
  const decision = adjudicateFs(a, b);
  assert.equal(decision.method, "fellegi-sunter");
  assert.notEqual(decision.verdict, "distinct");
  assert.ok(decision.probability > 0.5);
});

test("adjudicateFs: weak, mostly-missing evidence stays distinct rather than defaulting to possible", async () => {
  const a = await proposalOf("Improve onboarding copy");
  const b = await candidateOf("Speed up the search index");
  const decision = adjudicateFs(a, b);
  assert.equal(decision.method, "fellegi-sunter");
  assert.equal(decision.verdict, "distinct");
});

test("adjudicateFs: reason cites the strongest contributing features, not a raw score", async () => {
  const a = await proposalOf("Add caching to lib/dedup/blocking.ts");
  const b = await candidateOf("Add a cache layer to lib/dedup/blocking.ts");
  const decision = adjudicateFs(a, b);
  assert.match(decision.reason, /f\d+_\w+=/);
});

test("adjudicateFs: an explicit weight table overrides SEED_WEIGHTS (what the training script's output is for)", async () => {
  const a = await proposalOf("Improve onboarding copy");
  const b = await candidateOf("Speed up the search index");
  const permissive = { prior: 0.5, costRatio: 200, weights: {} };
  const decision = adjudicateFs(a, b, permissive);
  assert.equal(decision.probability, 0.5);
  assert.equal(decision.verdict, "possible");
});
