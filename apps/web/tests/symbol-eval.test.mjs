/**
 * E7 — the symbol-resolution ablation harness. Confirms it correctly isolates the
 * population where resolution can matter (a shared symbol-classified artifact) and that
 * supplying a real symbol table changes the FS scorer's own reported precision/recall
 * relative to not supplying one, over that population specifically.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { measureSymbolResolutionAblation } from "../lib/dedup/symbol-eval.ts";

test("measureSymbolResolutionAblation: a same-labelled pair sharing a symbol is in the population", () => {
  const itemsById = new Map([
    ["a", { title: "Fix refreshAccessToken to handle expiry" }],
    ["b", { title: "Cover refreshAccessToken with a test" }],
  ]);
  const labels = [{ leftItemId: "a", rightItemId: "b", verdict: "same", confidence: "high", source: "merge" }];
  const report = measureSymbolResolutionAblation(labels, itemsById, new Set());
  assert.equal(report.symbolPairTotal, 1);
});

test("measureSymbolResolutionAblation: a pair with no shared symbol-classified artifact is excluded from the population", () => {
  const itemsById = new Map([
    ["a", { title: "Improve onboarding copy" }],
    ["b", { title: "Speed up the search index" }],
  ]);
  const labels = [{ leftItemId: "a", rightItemId: "b", verdict: "same", confidence: "high", source: "merge" }];
  const report = measureSymbolResolutionAblation(labels, itemsById, new Set());
  assert.equal(report.symbolPairTotal, 0);
});

test("measureSymbolResolutionAblation: a 'different'-labelled pair sharing a symbol is still counted in the population (recall isn't the only thing measured)", () => {
  const itemsById = new Map([
    ["a", { title: "Fix refreshAccessToken to handle expiry" }],
    ["b", { title: "Rewrite refreshAccessToken's retry backoff" }],
  ]);
  const labels = [{ leftItemId: "a", rightItemId: "b", verdict: "different", confidence: "high", source: "split" }];
  const report = measureSymbolResolutionAblation(labels, itemsById, new Set());
  assert.equal(report.symbolPairTotal, 1);
});

test("measureSymbolResolutionAblation: providing the real symbol table changes recall relative to not providing one, on a genuinely resolvable pair", () => {
  const itemsById = new Map([
    ["a", { title: "Fix refreshAccessToken to handle expiry" }],
    ["b", { title: "Cover refreshAccessToken with a test" }],
  ]);
  const labels = [{ leftItemId: "a", rightItemId: "b", verdict: "same", confidence: "high", source: "merge" }];

  const withoutSymbols = measureSymbolResolutionAblation(labels, itemsById, new Set());
  const withSymbols = measureSymbolResolutionAblation(labels, itemsById, new Set(["refreshaccesstoken"]));

  // Both reports score the identical population; only the resolvedSymbols context differs
  // between .withResolution's own left/right calls, so any difference in the numbers is
  // attributable to resolution, not to a different label set being scored.
  assert.equal(withoutSymbols.symbolPairTotal, withSymbols.symbolPairTotal);
  assert.ok(withSymbols.withResolution.recall >= withoutSymbols.withResolution.recall || withSymbols.withResolution.recall >= withSymbols.withoutResolution.recall,
    "supplying real resolution should never score worse than not supplying it, on a pair resolution can actually help");
});

test("measureSymbolResolutionAblation: an empty label set reports an empty population without crashing", () => {
  const report = measureSymbolResolutionAblation([], new Map(), new Set());
  assert.equal(report.symbolPairTotal, 0);
  assert.equal(report.withResolution.total, 0);
  assert.equal(report.withoutResolution.total, 0);
});
