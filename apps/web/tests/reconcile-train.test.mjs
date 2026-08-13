/**
 * E3 training tests — the pure counting/smoothing math in lib/dedup/train.ts, exercised
 * without a database. Mirrors how tests/blocking.test.mjs covers blocking-eval.ts's pure
 * half separately from the script that feeds it real rows.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildSignature, fingerprint } from "../lib/dedup/signature.ts";
import { SEED_WEIGHTS } from "../lib/dedup/fellegi-sunter.ts";
import { estimateWeights, levelUniverse, tallyPairs } from "../lib/dedup/train.ts";

async function proposalOf(title, description = "") {
  const signature = buildSignature(title, description);
  return { signature, fingerprintValue: await fingerprint(signature) };
}

async function candidateOf(title, description = "", { status = "ready", itemKey = "#1", id = "wi_1" } = {}) {
  const signature = buildSignature(title, description);
  return { id, itemKey, title, status, signature, fingerprintValue: await fingerprint(signature) };
}

test("tallyPairs: a fingerprint-identical pair is excluded — a veto would catch it before FS ever scores it", async () => {
  const proposal = await proposalOf("Add user authentication");
  const candidate = await candidateOf("Add authentication for users");
  const result = tallyPairs([{ proposal, candidate, verdict: "same" }]);
  assert.equal(result.vetoedSkipped, 1);
  assert.equal(result.sameTotal, 0);
  assert.equal(result.counts.size, 0);
});

test("tallyPairs: an antonym-action pair is excluded the same way", async () => {
  const proposal = await proposalOf("Add the login endpoint");
  const candidate = await candidateOf("Remove the login endpoint");
  const result = tallyPairs([{ proposal, candidate, verdict: "different" }]);
  assert.equal(result.vetoedSkipped, 1);
  assert.equal(result.differentTotal, 0);
});

test("tallyPairs: non-vetoed pairs are tallied per feature and level, split by verdict", async () => {
  const same1 = { proposal: await proposalOf("Add caching to lib/dedup/blocking.ts"), candidate: await candidateOf("Add a cache layer to lib/dedup/blocking.ts"), verdict: "same" };
  const different1 = { proposal: await proposalOf("Improve onboarding copy"), candidate: await candidateOf("Speed up the search index"), verdict: "different" };
  const result = tallyPairs([same1, different1]);
  assert.equal(result.vetoedSkipped, 0);
  assert.equal(result.sameTotal, 1);
  assert.equal(result.differentTotal, 1);
  const f2 = result.counts.get("f2_artifactJaccard");
  assert.ok(f2, "f2 should have been observed for the same1 pair");
  assert.equal(f2.get("high")?.same, 1);
});

test("levelUniverse: uses SEED_WEIGHTS's own bucket names for a known feature", () => {
  assert.deepEqual(new Set(levelUniverse("f5_subsystem", [])), new Set(["same", "adjacent", "different"]));
});

test("levelUniverse: falls back to observed levels for a feature the seed table has no entry for", () => {
  assert.deepEqual(levelUniverse("f8_embedding", ["high", "low"]).sort(), ["high", "low"]);
});

test("estimateWeights: a feature with fewer supporting labels than minLabels keeps the whole seed entry untouched", async () => {
  const same1 = { proposal: await proposalOf("Add caching to lib/dedup/blocking.ts"), candidate: await candidateOf("Add a cache layer to lib/dedup/blocking.ts"), verdict: "same" };
  const tallied = tallyPairs([same1]);
  const { weights, report } = estimateWeights(tallied, 20);
  const row = report.find((entry) => entry.feature === "f2_artifactJaccard");
  assert.equal(row.status, "kept-seed");
  assert.deepEqual(weights.f2_artifactJaccard, SEED_WEIGHTS.weights.f2_artifactJaccard);
});

test("estimateWeights: a well-supported feature is retrained, and its m-values sum to ~1 across the level universe", async () => {
  const pairs = [];
  for (let i = 0; i < 25; i++) {
    // Same title/action on both sides, artifacts overlapping but not identical (a shared
    // file plus one extra on the proposal's side) — real, non-trivial artifact agreement,
    // and the differing artifact set keeps the two signatures from being fingerprint-equal
    // (which would otherwise veto the pair before it ever reaches tallying).
    pairs.push({
      proposal: await proposalOf(`Add caching for module ${i}`, `touches lib/dedup/blocking${i}.ts and lib/dedup/features.ts`),
      candidate: await candidateOf(`Add caching for module ${i}`, `touches lib/dedup/blocking${i}.ts`),
      verdict: "same",
    });
    // Same title/action again (so no action veto), but only the proposal names a file —
    // one side empty is a real "none" observation for f2, not a disjoint-artifacts veto
    // (that veto only fires when BOTH sides have artifacts that don't intersect).
    pairs.push({
      proposal: await proposalOf(`Add caching for module ${i}`, `touches lib/dedup/blocking${i}.ts`),
      candidate: await candidateOf(`Add caching for module ${i}`),
      verdict: "different",
    });
  }
  const tallied = tallyPairs(pairs);
  const { weights, report } = estimateWeights(tallied, 20);
  const row = report.find((entry) => entry.feature === "f2_artifactJaccard");
  assert.equal(row.status, "trained");
  const mSum = Object.values(weights.f2_artifactJaccard).reduce((sum, entry) => sum + entry.m, 0);
  assert.ok(Math.abs(mSum - 1) < 0.01, `m-values should sum to ~1, got ${mSum}`);
  const uSum = Object.values(weights.f2_artifactJaccard).reduce((sum, entry) => sum + entry.u, 0);
  assert.ok(Math.abs(uSum - 1) < 0.01, `u-values should sum to ~1, got ${uSum}`);
});

test("estimateWeights: a seed feature never observed in the sample at all is carried over rather than dropped", () => {
  const emptyTally = { counts: new Map(), observedLevels: new Map(), sameTotal: 0, differentTotal: 0, vetoedSkipped: 0 };
  const { weights, report } = estimateWeights(emptyTally, 20);
  for (const feature of Object.keys(SEED_WEIGHTS.weights)) {
    assert.deepEqual(weights[feature], SEED_WEIGHTS.weights[feature]);
  }
  assert.ok(report.every((row) => row.status === "kept-seed (unobserved)"));
});
