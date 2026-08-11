/**
 * Domain-logic tests for proposal deduplication.
 *
 * These cover the pairs that decide whether the feature is safe to run automatically:
 * the ones where wording alone is misleading, and where a false merge would silently
 * lose an agent's work.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildSignature, extractAction, extractArtifacts, fingerprint, jaccard } from "../lib/dedup/signature.ts";
import { adjudicate, bestMatch, explain } from "../lib/dedup/match.ts";

async function proposalOf(title, description = "") {
  const signature = buildSignature(title, description);
  return { signature, fingerprintValue: await fingerprint(signature) };
}

async function candidateOf(title, { status = "ready", itemKey = "#1", id = "wi_1", updatedAt } = {}) {
  const signature = buildSignature(title);
  return { id, itemKey, title, status, updatedAt, signature, fingerprintValue: await fingerprint(signature) };
}

test("signature: normalizes word order, stopwords, and plurals to one fingerprint", async () => {
  const a = buildSignature("Add user authentication");
  const b = buildSignature("Add authentication for users");
  assert.deepEqual(a.objectTokens, b.objectTokens);
  assert.equal(await fingerprint(a), await fingerprint(b));
});

test("signature: treats verbs in the same action class as equivalent", () => {
  assert.equal(extractAction("Implement the parser").action, "add");
  assert.equal(extractAction("Create the parser").action, "add");
  assert.equal(extractAction("Build the parser").action, "add");
  assert.equal(extractAction("Delete the parser").action, "remove");
  assert.equal(extractAction("Refactor the parser").action, "refactor");
  assert.equal(extractAction("Frobnicate the parser").action, "unknown");
});

test("signature: resolves multi-word verbs", () => {
  assert.equal(extractAction("Set up CI").action, "add");
  assert.equal(extractAction("Roll out the new pricing").action, "deploy");
  assert.equal(extractAction("Figure out why the build is slow").action, "investigate");
});

test("signature: extracts concrete artifacts and keeps them out of object tokens", () => {
  const { artifacts } = extractArtifacts("Add rate limiting to /api/login in lib/store.ts using MAX_ATTEMPTS");
  assert.ok(artifacts.includes("/api/login"), `expected endpoint, got ${artifacts}`);
  assert.ok(artifacts.includes("lib/store.ts"), `expected file path, got ${artifacts}`);
  assert.ok(artifacts.includes("max_attempts"), `expected env var, got ${artifacts}`);

  const signature = buildSignature("Add rate limiting to /api/login");
  assert.deepEqual(signature.objectTokens, ["limit", "rate"]);
});

test("signature: does not mistake ordinary prose for artifacts", () => {
  const { artifacts } = extractArtifacts("Add auth middleware for the dashboard");
  assert.deepEqual(artifacts, []);
});

// The pairs from DEDUPLICATION_ARCHITECTURE.md §4. Wording similarity gets the first
// three wrong; the structural vetoes are what make automatic matching safe.

test("veto: same action and wording, different endpoint, is not a duplicate", async () => {
  const decision = adjudicate(
    await proposalOf("Add rate limiting to /api/login"),
    await candidateOf("Add rate limiting to /api/signup"),
  );
  assert.equal(decision.verdict, "distinct");
  assert.match(decision.reason, /Different artifacts/);
});

test("veto: opposite actions on the same object are not a duplicate", async () => {
  const decision = adjudicate(
    await proposalOf("Add auth middleware"),
    await candidateOf("Remove auth middleware"),
  );
  assert.equal(decision.verdict, "distinct");
  assert.match(decision.reason, /Opposite actions/);
});

test("veto: different kinds of work on the same object are not a duplicate", async () => {
  const decision = adjudicate(
    await proposalOf("Test the parser"),
    await candidateOf("Fix the parser"),
  );
  assert.equal(decision.verdict, "distinct");
  assert.match(decision.reason, /Different actions/);
});

test("known limit: pure paraphrase with no shared vocabulary is split, not merged", async () => {
  // "throttling"/"sign-in route" and "rate limiting"/"login endpoint" share no tokens
  // and no artifacts. Splitting leaves one duplicate card a human can merge; merging
  // on a guess would point an agent at the wrong task. The cheap error is the default.
  const proposal = await proposalOf("Add rate limiting to the login endpoint");
  const candidate = await candidateOf("Implement throttling on the sign-in route");
  assert.equal(jaccard(proposal.signature.objectTokens, candidate.signature.objectTokens), 0);
  assert.equal(adjudicate(proposal, candidate).verdict, "distinct");
});

test("identical signatures match on fingerprint alone", async () => {
  const decision = adjudicate(
    await proposalOf("Set up CI for the worker"),
    await candidateOf("Set up CI for the worker"),
  );
  assert.equal(decision.verdict, "duplicate");
  assert.equal(decision.method, "fingerprint");
  assert.equal(decision.score, 1);
});

test("identical artifacts with a compatible action match on wording alone", async () => {
  const decision = adjudicate(
    await proposalOf("Add pagination to /api/state"),
    await candidateOf("Implement paging on /api/state"),
  );
  assert.equal(decision.verdict, "duplicate");
  assert.equal(decision.method, "artifact");
});

test("a more specific restatement is flagged as possible, not vetoed", async () => {
  const decision = adjudicate(
    await proposalOf("Add rate limiting"),
    await candidateOf("Add rate limiting to /api/login"),
  );
  assert.equal(decision.verdict, "possible");
});

test("unrelated work exits early as distinct", async () => {
  const decision = adjudicate(
    await proposalOf("Add rate limiting to the login endpoint"),
    await candidateOf("Upgrade the Tailwind dependency"),
  );
  assert.equal(decision.verdict, "distinct");
});

test("bestMatch prefers a conclusive match over a possible one", async () => {
  const proposal = await proposalOf("Set up CI for the worker");
  const match = bestMatch(proposal, [
    await candidateOf("Set up CI for the dashboard", { id: "wi_a", itemKey: "#2" }),
    await candidateOf("Set up CI for the worker", { id: "wi_b", itemKey: "#3" }),
  ]);
  assert.equal(match.candidate.id, "wi_b");
  assert.equal(match.verdict, "duplicate");
});

test("bestMatch returns null when nothing is close", async () => {
  const proposal = await proposalOf("Add rate limiting to /api/login");
  assert.equal(bestMatch(proposal, [await candidateOf("Upgrade the Tailwind dependency")]), null);
});

test("explanation warns when the matched item is already complete", async () => {
  const proposal = await proposalOf("Set up CI for the worker");
  const match = bestMatch(proposal, [await candidateOf("Set up CI for the worker", { status: "done", itemKey: "#3" })]);
  const message = explain(match);
  assert.match(message, /#3/);
  assert.match(message, /already done/);
  assert.match(message, /Reopen/);
});
