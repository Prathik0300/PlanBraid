/**
 * The full derivation table for deriveColumn, plus the started-while-blocked anomaly.
 * Pure function, no database needed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { deriveColumn, isStartedWhileBlocked } from "../lib/graph/column.ts";

const STATUSES = ["proposed", "planned", "ready", "in_progress", "blocked", "in_review", "done", "cancelled"];

test("an actor's assertion always wins over topology, regardless of blockingCount", async (t) => {
  for (const status of ["in_progress", "in_review", "done", "cancelled", "blocked"]) {
    await t.test(`${status} with blockingCount 0`, () => { assert.equal(deriveColumn({ status, blockingCount: 0 }), status); });
    await t.test(`${status} with blockingCount 3`, () => { assert.equal(deriveColumn({ status, blockingCount: 3 }), status); });
  }
});

test("proposed, planned, and ready are unaffected when nothing blocks them", () => {
  for (const status of ["proposed", "planned", "ready"]) {
    assert.equal(deriveColumn({ status, blockingCount: 0 }), status);
  }
});

test("proposed, planned, and ready all derive to blocked once blockingCount is positive", () => {
  for (const status of ["proposed", "planned", "ready"]) {
    assert.equal(deriveColumn({ status, blockingCount: 1 }), "blocked");
    assert.equal(deriveColumn({ status, blockingCount: 5 }), "blocked");
  }
});

test("the full 8-status x {0, >0} derivation table", () => {
  const assertionWins = new Set(["cancelled", "done", "in_review", "in_progress", "blocked"]);
  for (const status of STATUSES) {
    assert.equal(deriveColumn({ status, blockingCount: 0 }), status, `${status} @ 0`);
    assert.equal(deriveColumn({ status, blockingCount: 2 }), assertionWins.has(status) ? status : "blocked", `${status} @ 2`);
  }
});

test("isStartedWhileBlocked: true only for in_progress with a positive blockingCount", () => {
  assert.equal(isStartedWhileBlocked({ status: "in_progress", blockingCount: 1 }), true);
  assert.equal(isStartedWhileBlocked({ status: "in_progress", blockingCount: 0 }), false);
  assert.equal(isStartedWhileBlocked({ status: "ready", blockingCount: 1 }), false, "not in_progress, so not an anomaly even though blocked");
  assert.equal(isStartedWhileBlocked({ status: "blocked", blockingCount: 1 }), false, "already-blocked status is not the collision case");
  assert.equal(isStartedWhileBlocked({ status: "done", blockingCount: 1 }), false);
});

test("the anomaly reflects a real product scenario: work started, then its prerequisite reopened", () => {
  // Codex starts #7. Its prerequisite #3 later gets reopened (e.g. a test failure).
  // #7 should stay in_progress (Codex's claim is never silently overridden) but must
  // be flagged, since this is exactly the cross-agent collision the graph exists to catch.
  const item = { status: "in_progress", blockingCount: 1 };
  assert.equal(deriveColumn(item), "in_progress", "the column does not move out from under the agent");
  assert.equal(isStartedWhileBlocked(item), true, "but the collision must be visible");
});
