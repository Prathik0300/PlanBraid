/**
 * Domain-logic tests for proposal deduplication.
 *
 * These cover the pairs that decide whether the feature is safe to run automatically:
 * the ones where wording alone is misleading, and where a false merge would silently
 * lose an agent's work.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildSignature, compareSubsystems, deriveSubsystem, extractAction, extractArtifacts, extractCriteria, fingerprint, jaccard } from "../lib/dedup/signature.ts";
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

test("veto: opposite actions on the SAME concrete artifact is a conflict, not plain distinct (E4, fixes F3)", async () => {
  const decision = adjudicate(
    await proposalOf("Add lib/auth/middleware.ts"),
    await candidateOf("Remove lib/auth/middleware.ts"),
  );
  assert.equal(decision.verdict, "conflict");
  assert.equal(decision.method, "conflict");
  assert.match(decision.reason, /Opposite actions/);
  assert.match(decision.reason, /middleware\.ts/);
});

test("veto: a conflict verdict outranks a merely-possible match in bestMatch", async () => {
  const proposal = await proposalOf("Remove lib/auth/middleware.ts");
  const conflicting = await candidateOf("Add lib/auth/middleware.ts", { itemKey: "#1" });
  const lexicallySimilar = await candidateOf("Remove the old middleware config", { itemKey: "#2" });
  const winner = bestMatch({ signature: proposal.signature, fingerprintValue: proposal.fingerprintValue }, [conflicting, lexicallySimilar]);
  assert.equal(winner.verdict, "conflict");
  assert.equal(winner.candidate.itemKey, "#1");
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

// ── E2 — signature v2: synonym lexicon, qualifiers, criteria, subsystem ────────────────

test("signature v2: a synonym pair canonicalizes to one object token", () => {
  const full = buildSignature("Fix the authentication bug");
  const short = buildSignature("Fix the auth bug");
  assert.deepEqual(full.objectTokens, short.objectTokens);
  assert.ok(full.objectTokens.includes("auth"), `expected canonicalized 'auth', got ${JSON.stringify(full.objectTokens)}`);
});

test("signature v2: an unrelated word is never accidentally canonicalized", () => {
  const signature = buildSignature("Fix the authorization bug");
  // authorization -> authz is a real, distinct pair from authentication -> auth; the two
  // must never collapse into each other just because both start with 'auth'.
  assert.ok(signature.objectTokens.includes("authz"));
  assert.ok(!signature.objectTokens.includes("auth"));
});

test("signature v2: qualifiers are extracted and pulled out of the object-token bag", () => {
  const signature = buildSignature("Add dark mode on mobile");
  assert.deepEqual(signature.qualifiers, ["mobile"]);
  assert.ok(!signature.objectTokens.includes("mobile"), "a qualifier must not also count as ordinary lexical overlap");
});

test("signature v2: no qualifier present is an empty array, not undefined or a crash", () => {
  const signature = buildSignature("Add dark mode");
  assert.deepEqual(signature.qualifiers, []);
});

test("signature v2: a qualifier is real scope information — two titles differing only by one get different fingerprints", async () => {
  const withoutScope = buildSignature("Add dark mode");
  const withScope = buildSignature("Add dark mode on mobile");
  assert.notEqual(await fingerprint(withoutScope), await fingerprint(withScope));
});

test("signature v2: multiple qualifiers are all captured, sorted and deduplicated", () => {
  const signature = buildSignature("Test the mobile and web staging builds");
  assert.deepEqual(signature.qualifiers, ["mobile", "staging", "web"]);
});

test("signature v2: extractCriteria reads a markdown checklist", () => {
  const criteria = extractCriteria("Implementation notes.\n- [ ] Token is rejected after expiry\n- [x] Refresh endpoint returns 401 on reuse\n");
  assert.deepEqual(criteria, ["token is rejected after expiry", "refresh endpoint returns 401 on reuse"]);
});

test("signature v2: extractCriteria reads Given/When/Then lines anywhere in the text", () => {
  const criteria = extractCriteria("Some context first.\nGiven an expired token\nWhen the client calls /refresh\nThen the server returns 401\n");
  assert.deepEqual(criteria, ["given an expired token", "when the client calls /refresh", "then the server returns 401"]);
});

test("signature v2: extractCriteria reads a bullet list under a recognized heading", () => {
  const criteria = extractCriteria("Add pagination.\n\nAcceptance criteria:\n- Page size defaults to 20\n- Cursor is opaque to the client\n\nNotes: ship behind a flag.");
  assert.deepEqual(criteria, ["page size defaults to 20", "cursor is opaque to the client"]);
});

test("signature v2: extractCriteria reads a numbered list under a heading", () => {
  const criteria = extractCriteria("Requirements:\n1. Must not block the main thread\n2) Falls back gracefully offline\n");
  assert.deepEqual(criteria, ["must not block the main thread", "falls back gracefully offline"]);
});

test("signature v2: a plain bullet list with no recognized heading is not mistaken for criteria", () => {
  const criteria = extractCriteria("Some background.\n- this is just a list\n- not acceptance criteria at all\n");
  assert.deepEqual(criteria, []);
});

test("signature v2: no description at all yields no criteria, not a crash", () => {
  assert.deepEqual(extractCriteria(""), []);
  assert.deepEqual(buildSignature("Add dark mode").criteria, []);
});

test("signature v2: a blank line ends a heading-triggered criteria section", () => {
  const criteria = extractCriteria("Acceptance criteria:\n- First one\n\n- This bullet is after the blank line and must not count\n");
  assert.deepEqual(criteria, ["first one"]);
});

test("signature v2: deriveSubsystem picks the directory shared by an item's own file artifacts", () => {
  assert.equal(deriveSubsystem(["apps/web/lib/dedup/blocking.ts", "apps/web/lib/dedup/signature.ts"]), "apps/web");
});

test("signature v2: deriveSubsystem returns null when there is no file-kind artifact at all", () => {
  assert.equal(deriveSubsystem(["/api/login", "DATABASE_URL", "refreshAccessToken"]), null);
});

test("signature v2: deriveSubsystem is null for a bare filename with no directory information", () => {
  assert.equal(deriveSubsystem(["signature.ts"]), null);
});

test("signature v2: deriveSubsystem breaks a genuine tie deterministically", () => {
  assert.equal(deriveSubsystem(["apps/web/a.ts", "lib/dedup/b.ts"]), "apps/web");
});

test("signature v2: compareSubsystems — same, adjacent, different, and unknown", () => {
  assert.equal(compareSubsystems("apps/web", "apps/web"), "same");
  assert.equal(compareSubsystems("apps/web", "apps/web/lib"), "adjacent");
  assert.equal(compareSubsystems("apps/web/lib", "apps/web"), "adjacent");
  assert.equal(compareSubsystems("apps/web", "lib/dedup"), "different");
  assert.equal(compareSubsystems(null, "apps/web"), "unknown");
  assert.equal(compareSubsystems("apps/web", null), "unknown");
  assert.equal(compareSubsystems(null, null), "unknown");
});

test("signature v2: buildSignature wires subsystem end to end from title artifacts", () => {
  const signature = buildSignature("Fix the token refresh in apps/web/lib/dedup/blocking.ts");
  assert.equal(signature.subsystem, "apps/web");
});

test("signature v2: normalized includes the new fields, so two items differing only in criteria fingerprint differently", async () => {
  const withoutCriteria = buildSignature("Add refresh tokens", "");
  const withCriteria = buildSignature("Add refresh tokens", "Acceptance criteria:\n- Expires after 30 days\n");
  assert.notEqual(await fingerprint(withoutCriteria), await fingerprint(withCriteria));
});

test("signature v2: fingerprints for two items with identical title, description, and no new-field content are unaffected — no spurious drift", async () => {
  const a = buildSignature("Add rate limiting to /api/login");
  const b = buildSignature("Add rate limiting to /api/login");
  assert.equal(await fingerprint(a), await fingerprint(b));
});
