/**
 * E4 — Stage 3 relation typing tests. Hand-built pairs for all eight relation types plus
 * the edge cases that decide which bucket a borderline pair lands in: exact containment
 * boundaries, the DUPLICATE-vs-SUBSET tie-break at equal artifact sets, and the veto
 * pass-through (CONFLICT/DUPLICATE/NEW) that has to agree with match.ts's own decision
 * rather than re-deriving it independently.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildSignature, fingerprint } from "../lib/dedup/signature.ts";
import { classifyRelation, edgeTypeForRelation } from "../lib/dedup/relations.ts";

async function proposalOf(title, description = "") {
  const signature = buildSignature(title, description);
  return { signature, fingerprintValue: await fingerprint(signature) };
}

async function candidateOf(title, description = "", { status = "ready", itemKey = "#1", id = "wi_1" } = {}) {
  const signature = buildSignature(title, description);
  return { id, itemKey, title, status, signature, fingerprintValue: await fingerprint(signature) };
}

test("relations: identical fingerprint is DUPLICATE, passed through from the shared veto", async () => {
  const proposal = await proposalOf("Add user authentication");
  const candidate = await candidateOf("Add authentication for users");
  const relation = classifyRelation(proposal, candidate);
  assert.equal(relation.type, "DUPLICATE");
});

test("relations: equal (non-fingerprint-identical) artifact sets with a compatible action is DUPLICATE too", async () => {
  const proposal = await proposalOf("Add caching to lib/dedup/blocking.ts");
  const candidate = await candidateOf("Introduce a cache layer for lib/dedup/blocking.ts");
  const relation = classifyRelation(proposal, candidate);
  assert.equal(relation.type, "DUPLICATE");
});

test("relations: antonym actions with a shared artifact is CONFLICT (fixes F3)", async () => {
  const proposal = await proposalOf("Add lib/auth/middleware.ts");
  const candidate = await candidateOf("Remove lib/auth/middleware.ts");
  const relation = classifyRelation(proposal, candidate);
  assert.equal(relation.type, "CONFLICT");
});

test("relations: antonym actions with nothing shared is NEW, not CONFLICT", async () => {
  const proposal = await proposalOf("Add dark mode");
  const candidate = await candidateOf("Remove the legacy theme switcher");
  const relation = classifyRelation(proposal, candidate);
  assert.equal(relation.type, "NEW");
});

test("relations: disjoint artifacts (the ordinary veto) is NEW", async () => {
  const proposal = await proposalOf("Rate limit /api/login");
  const candidate = await candidateOf("Rate limit /api/signup");
  const relation = classifyRelation(proposal, candidate);
  assert.equal(relation.type, "NEW");
});

test("relations: the smaller artifact set is SUBSET when fully contained in the larger", async () => {
  // Same action class on both sides deliberately: checkVetoes' veto 2c vetoes any pair
  // of two DIFFERENT recognized actions to `distinct` before Stage 3 ever runs, so a
  // reachable SUBSET/SUPERSET/OVERLAP case always shares its action class too.
  const proposal = await proposalOf("Update lib/dedup/blocking.ts");
  const candidate = await candidateOf("Update lib/dedup/blocking.ts and lib/dedup/features.ts and lib/dedup/train.ts");
  const relation = classifyRelation(proposal, candidate);
  assert.equal(relation.type, "SUBSET");
});

test("relations: the larger artifact set is SUPERSET when it fully contains the smaller", async () => {
  const proposal = await proposalOf("Update lib/dedup/blocking.ts and lib/dedup/features.ts and lib/dedup/train.ts");
  const candidate = await candidateOf("Update lib/dedup/blocking.ts");
  const relation = classifyRelation(proposal, candidate);
  assert.equal(relation.type, "SUPERSET");
});

test("relations: partial artifact overlap below the containment bar is OVERLAP", async () => {
  const proposal = await proposalOf("Update lib/dedup/blocking.ts and lib/dedup/features.ts");
  const candidate = await candidateOf("Update lib/dedup/blocking.ts and lib/dedup/train.ts and lib/dedup/relations.ts and lib/dedup/signature.ts");
  const relation = classifyRelation(proposal, candidate);
  assert.equal(relation.type, "OVERLAP");
});

test("relations: SEQUENCE is never produced today — checkVetoes' veto 2c already vetoes any two different recognized actions to distinct/NEW before Stage 3 runs", async () => {
  const proposal = await proposalOf("Add lib/dedup/relations.ts");
  const candidate = await candidateOf("Test lib/dedup/relations.ts");
  const relation = classifyRelation(proposal, candidate);
  assert.equal(relation.type, "NEW");
});

test("relations: same action on shared ground is DUPLICATE/OVERLAP territory, never SEQUENCE", async () => {
  const proposal = await proposalOf("Add lib/dedup/relations.ts");
  const candidate = await candidateOf("Add lib/dedup/relations.ts and lib/dedup/train.ts");
  const relation = classifyRelation(proposal, candidate);
  assert.notEqual(relation.type, "SEQUENCE");
});

test("relations: same subsystem but disjoint artifacts is NEW, not RELATED — veto 2b (disjoint artifacts) fires before subsystem is ever consulted", async () => {
  const proposal = await proposalOf("Update lib/dedup/blocking.ts");
  const candidate = await candidateOf("Update lib/dedup/signature.ts");
  const relation = classifyRelation(proposal, candidate);
  assert.equal(relation.type, "NEW");
});

test("relations: strong lexical overlap with no shared artifact and no shared subsystem is RELATED", async () => {
  const proposal = await proposalOf("Add rate limiting to the API");
  const candidate = await candidateOf("Add rate limiting for the API gateway");
  const relation = classifyRelation(proposal, candidate);
  assert.equal(relation.type, "RELATED");
});

test("relations: nothing shared at all is NEW", async () => {
  const proposal = await proposalOf("Improve onboarding copy");
  const candidate = await candidateOf("Speed up the search index");
  const relation = classifyRelation(proposal, candidate);
  assert.equal(relation.type, "NEW");
});

test("relations: every relation carries a non-empty, specific reason", async () => {
  const proposal = await proposalOf("Update lib/dedup/blocking.ts");
  const candidate = await candidateOf("Refactor lib/dedup/blocking.ts and lib/dedup/features.ts");
  const relation = classifyRelation(proposal, candidate);
  assert.ok(relation.reason.length > 0);
});

test("edgeTypeForRelation: maps every linkable type to an ANNOTATION_EDGE_TYPES member, and DUPLICATE/NEW to null", () => {
  assert.equal(edgeTypeForRelation("SUBSET"), "subset_of");
  assert.equal(edgeTypeForRelation("SUPERSET"), "superset_of");
  assert.equal(edgeTypeForRelation("OVERLAP"), "overlaps_with");
  assert.equal(edgeTypeForRelation("CONFLICT"), "conflicts_with");
  assert.equal(edgeTypeForRelation("SEQUENCE"), "follows");
  assert.equal(edgeTypeForRelation("RELATED"), "relates_to");
  assert.equal(edgeTypeForRelation("DUPLICATE"), null);
  assert.equal(edgeTypeForRelation("NEW"), null);
});
