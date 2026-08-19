/**
 * The full derivation table for deriveColumn, plus the started-while-blocked anomaly.
 * Pure function, no database needed.
 *
 * Two axes matter here, not one. `status` says how far along the work is; `maturity` says
 * whether it is work at all yet. Readiness is the conjunction of both plus clear topology,
 * which is why it is derived rather than stored: nothing in the product ever wrote
 * 'ready' (agents create work as 'proposed', and acceptance only moves `maturity`), so a
 * stored-'ready' rule made every real project's queue permanently empty.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { deriveColumn, isStartedWhileBlocked } from "../lib/graph/column.ts";

const STATUSES = ["proposed", "planned", "ready", "in_progress", "blocked", "in_review", "done", "cancelled"];
const ASSERTION_WINS = new Set(["cancelled", "done", "in_review", "in_progress", "blocked"]);
/** An unratified item, so readiness never fires and `status` is what shows through. */
const raw = (status, blockingCount = 0) => ({ status, blockingCount, maturity: "proposal", deferredUntil: null });
const ratified = (status, blockingCount = 0) => ({ status, blockingCount, maturity: "accepted", deferredUntil: null });

test("an actor's assertion always wins over topology, regardless of blockingCount", async (t) => {
  for (const status of ["in_progress", "in_review", "done", "cancelled", "blocked"]) {
    await t.test(`${status} with blockingCount 0`, () => { assert.equal(deriveColumn(ratified(status, 0)), status); });
    await t.test(`${status} with blockingCount 3`, () => { assert.equal(deriveColumn(ratified(status, 3)), status); });
  }
});

test("unratified work is unaffected when nothing blocks it: it stays where its status says", () => {
  for (const status of ["proposed", "planned", "ready"]) {
    assert.equal(deriveColumn(raw(status, 0)), status);
  }
});

test("accepting unblocked work is what makes it ready, whatever its stored status says", () => {
  // The bug this replaced: set_maturity only ever writes `maturity`, and deriveColumn read
  // only {status, blockingCount}, so acceptance was computed from inputs it never touched
  // and provably could not move a single card.
  for (const status of ["proposed", "planned", "ready"]) {
    assert.equal(deriveColumn(raw(status, 0)), status, "a proposal is not ready no matter how clear the graph is");
    assert.equal(deriveColumn(ratified(status, 0)), "ready", "acceptance is what promotes it");
  }
  assert.equal(deriveColumn({ status: "proposed", blockingCount: 0, maturity: "committed", deferredUntil: null }), "ready", "committed counts as ratified too");
});

test("unscheduled work with prerequisites is not 'blocked' - it is just upstream", () => {
  // Reporting it as blocked put 54 of 58 items on a real project into one column, which
  // conveys nothing and reads as a false alarm. Blocked is an exception state.
  for (const status of ["proposed", "planned"]) {
    assert.equal(deriveColumn(raw(status, 1)), status);
    assert.equal(deriveColumn(ratified(status, 5)), status, "acceptance does not turn upstream work into an alarm either");
  }
});

test("only work somebody had already scheduled shows as blocked when a prerequisite reopens", () => {
  assert.equal(deriveColumn(ratified("ready", 1)), "blocked", "stored 'ready' means someone scheduled it, and it then lost a prerequisite");
  assert.equal(deriveColumn(raw("ready", 2)), "blocked");
});

test("a live deferral is never ready, however clear the graph is", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(deriveColumn({ status: "proposed", blockingCount: 0, maturity: "accepted", deferredUntil: future }), "proposed", "deferred work is not actionable");
  assert.equal(deriveColumn({ status: "proposed", blockingCount: 0, maturity: "accepted", deferredUntil: past }), "ready", "an expired deferral simply lapses, with no write");
});

test("the full 8-status derivation table across maturity and topology", () => {
  // The rule, stated once independently of the implementation: assertions win; then a
  // blocked prerequisite only alarms for work already scheduled; then acceptance promotes.
  function expected(status, blockingCount, ratifiedItem) {
    if (ASSERTION_WINS.has(status)) return status;
    if (blockingCount > 0) return status === "ready" ? "blocked" : status;
    return ratifiedItem ? "ready" : status;
  }
  for (const status of STATUSES) {
    for (const blockingCount of [0, 2]) {
      assert.equal(deriveColumn(raw(status, blockingCount)), expected(status, blockingCount, false), `${status} unratified @ ${blockingCount}`);
      assert.equal(deriveColumn(ratified(status, blockingCount)), expected(status, blockingCount, true), `${status} ratified @ ${blockingCount}`);
    }
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
  const item = ratified("in_progress", 1);
  assert.equal(deriveColumn(item), "in_progress", "the column does not move out from under the agent");
  assert.equal(isStartedWhileBlocked(item), true, "but the collision must be visible");
});
