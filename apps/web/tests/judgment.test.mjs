/**
 * E6 — Tier A pure-function tests: the question builder, the justification honesty
 * check, and the provider-agreement math. DB-backed request/answer flow is covered
 * separately in tests/judgment-integration.test.mjs.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildJudgmentQuestion, isAcceptableJustification } from "../lib/dedup/judgments.ts";
import { measureProviderAgreement } from "../lib/dedup/provider-agreement.ts";

test("buildJudgmentQuestion: names the specific candidate, not just 'a possible match'", () => {
  const question = buildJudgmentQuestion("Add refresh-token renewal", { itemKey: "#31", title: "Implement refresh-token rotation" });
  assert.equal(question, 'Is "Add refresh-token renewal" the same work as #31 "Implement refresh-token rotation"?');
});

test("isAcceptableJustification: rejects the doc's own example of a bare non-answer", () => {
  assert.equal(isAcceptableJustification("They're different"), false);
  assert.equal(isAcceptableJustification("different"), false);
  assert.equal(isAcceptableJustification("same"), false);
  assert.equal(isAcceptableJustification("Different."), false);
});

test("isAcceptableJustification: rejects text under the minimum length regardless of content", () => {
  assert.equal(isAcceptableJustification("nope"), false);
  assert.equal(isAcceptableJustification(""), false);
  assert.equal(isAcceptableJustification("   "), false);
});

test("isAcceptableJustification: accepts the doc's own example of a real justification", () => {
  assert.equal(isAcceptableJustification("different — #31 rotates the signing key, this renews the client's token"), true);
});

test("isAcceptableJustification: is case- and punctuation-insensitive for the trivial-phrase check", () => {
  assert.equal(isAcceptableJustification("THEY ARE DIFFERENT"), false);
  assert.equal(isAcceptableJustification("They are different!!!"), false);
});

test("measureProviderAgreement: a judgment matching the later human verdict on the same pair counts as agreement", () => {
  const report = measureProviderAgreement([
    { pairHash: "a::b", source: "judgment", verdict: "same", providerFamily: "claude", createdAt: "2026-01-01T00:00:00Z" },
    { pairHash: "a::b", source: "merge", verdict: "same", providerFamily: null, createdAt: "2026-01-02T00:00:00Z" },
  ]);
  assert.deepEqual(report.claude, { total: 1, agreements: 1, disagreements: 0, rate: 1 });
});

test("measureProviderAgreement: a judgment agreeing with a later split ('different') is counted as agreement, not just merges", () => {
  const report = measureProviderAgreement([
    { pairHash: "a::b", source: "judgment", verdict: "different", providerFamily: "codex", createdAt: "2026-01-01T00:00:00Z" },
    { pairHash: "a::b", source: "split", verdict: "different", providerFamily: null, createdAt: "2026-01-02T00:00:00Z" },
  ]);
  assert.deepEqual(report.codex, { total: 1, agreements: 1, disagreements: 0, rate: 1 });
});

test("measureProviderAgreement: a genuine disagreement is counted and lowers the rate", () => {
  const report = measureProviderAgreement([
    { pairHash: "a::b", source: "judgment", verdict: "different", providerFamily: "codex", createdAt: "2026-01-01T00:00:00Z" },
    { pairHash: "a::b", source: "merge", verdict: "same", providerFamily: null, createdAt: "2026-01-02T00:00:00Z" },
  ]);
  assert.deepEqual(report.codex, { total: 1, agreements: 0, disagreements: 1, rate: 0 });
});

test("measureProviderAgreement: the most RECENT human label is ground truth, not source priority — a later split overrides an earlier merge", () => {
  const report = measureProviderAgreement([
    { pairHash: "a::b", source: "merge", verdict: "same", providerFamily: null, createdAt: "2026-01-01T00:00:00Z" },
    { pairHash: "a::b", source: "judgment", verdict: "different", providerFamily: "claude", createdAt: "2026-01-02T00:00:00Z" },
    { pairHash: "a::b", source: "split", verdict: "different", providerFamily: null, createdAt: "2026-01-03T00:00:00Z" },
  ]);
  // The split (later, correcting the merge) is truth: 'different' matches the judgment.
  assert.deepEqual(report.claude, { total: 1, agreements: 1, disagreements: 0, rate: 1 });
});

test("measureProviderAgreement: a judgment with no human label on the same pair yet contributes nothing", () => {
  const report = measureProviderAgreement([
    { pairHash: "a::b", source: "judgment", verdict: "same", providerFamily: "claude", createdAt: "2026-01-01T00:00:00Z" },
  ]);
  assert.deepEqual(report, {});
});

test("measureProviderAgreement: a human label with no judgment for that pair contributes nothing", () => {
  const report = measureProviderAgreement([
    { pairHash: "a::b", source: "merge", verdict: "same", providerFamily: null, createdAt: "2026-01-01T00:00:00Z" },
  ]);
  assert.deepEqual(report, {});
});

test("measureProviderAgreement: separates providers and separates unrelated pairs correctly", () => {
  const report = measureProviderAgreement([
    { pairHash: "a::b", source: "judgment", verdict: "same", providerFamily: "claude", createdAt: "2026-01-01T00:00:00Z" },
    { pairHash: "a::b", source: "merge", verdict: "same", providerFamily: null, createdAt: "2026-01-02T00:00:00Z" },
    { pairHash: "c::d", source: "judgment", verdict: "same", providerFamily: "codex", createdAt: "2026-01-01T00:00:00Z" },
    { pairHash: "c::d", source: "split", verdict: "different", providerFamily: null, createdAt: "2026-01-02T00:00:00Z" },
  ]);
  assert.deepEqual(report.claude, { total: 1, agreements: 1, disagreements: 0, rate: 1 });
  assert.deepEqual(report.codex, { total: 1, agreements: 0, disagreements: 1, rate: 0 });
});

test("measureProviderAgreement: a null providerFamily buckets under 'unknown' rather than crashing", () => {
  const report = measureProviderAgreement([
    { pairHash: "a::b", source: "judgment", verdict: "same", providerFamily: null, createdAt: "2026-01-01T00:00:00Z" },
    { pairHash: "a::b", source: "merge", verdict: "same", providerFamily: null, createdAt: "2026-01-02T00:00:00Z" },
  ]);
  assert.deepEqual(report.unknown, { total: 1, agreements: 1, disagreements: 0, rate: 1 });
});
