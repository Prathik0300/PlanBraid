/**
 * E7 — repository grounding, Level 1: the server side of ingesting the bridge's optional
 * tree-sitter symbol report (`integrations/bridge/symbols.mjs`) into `repo_symbols`.
 * Genuine parsing is covered by `tests/bridge-symbols.test.mjs`; these tests are about
 * storage semantics — upsert, cleanup on deletion, idempotent replay, caps.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { setupProject } from "./support/fixtures.mjs";
import { ingestRepoObservation } from "@/lib/evidence/ingest.ts";
import { principal } from "./support/fixtures.mjs";
import { executeCommand } from "@/lib/store.ts";

test("symbols reported alongside a commit are stored in repo_symbols", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);

  await ingestRepoObservation(db, principal, {
    projectId, headSha: "a".repeat(40), changedPaths: ["lib/widget.ts"],
    symbols: [{ name: "computeWidgetTotal", kind: "function", file: "lib/widget.ts", line: 3 }],
  });

  const row = await db.prepare("SELECT symbol, kind, file, line FROM repo_symbols WHERE project_id = ? AND symbol = ?").bind(projectId, "computeWidgetTotal").first();
  assert.ok(row);
  assert.equal(row.kind, "function");
  assert.equal(row.file, "lib/widget.ts");
  assert.equal(row.line, 3);
});

test("re-reporting the same file's symbols upserts rather than duplicating", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);

  await ingestRepoObservation(db, principal, {
    projectId, headSha: "b".repeat(40), changedPaths: ["lib/widget.ts"],
    symbols: [{ name: "computeWidgetTotal", kind: "function", file: "lib/widget.ts", line: 3 }],
  });
  await ingestRepoObservation(db, principal, {
    projectId, headSha: "c".repeat(40), changedPaths: ["lib/widget.ts"],
    symbols: [{ name: "computeWidgetTotal", kind: "function", file: "lib/widget.ts", line: 5 }],
  });

  const rows = await db.prepare("SELECT line FROM repo_symbols WHERE project_id = ? AND symbol = ?").bind(projectId, "computeWidgetTotal").all();
  assert.equal(rows.results.length, 1, "a re-report of the same symbol must upsert, not duplicate");
  assert.equal(rows.results[0].line, 5, "the line should reflect the most recent report");
});

test("a symbol removed from a file (function deleted, file kept) disappears on re-report", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);

  await ingestRepoObservation(db, principal, {
    projectId, headSha: "d".repeat(40), changedPaths: ["lib/widget.ts"],
    symbols: [
      { name: "computeWidgetTotal", kind: "function", file: "lib/widget.ts", line: 3 },
      { name: "formatWidget", kind: "function", file: "lib/widget.ts", line: 10 },
    ],
  });
  // Re-report the same file with only one of the two symbols — formatWidget was removed.
  await ingestRepoObservation(db, principal, {
    projectId, headSha: "e".repeat(40), changedPaths: ["lib/widget.ts"],
    symbols: [{ name: "computeWidgetTotal", kind: "function", file: "lib/widget.ts", line: 3 }],
  });

  const rows = await db.prepare("SELECT symbol FROM repo_symbols WHERE project_id = ? AND file = ?").bind(projectId, "lib/widget.ts").all();
  assert.deepEqual(rows.results.map((r) => r.symbol), ["computeWidgetTotal"]);
});

test("a file reported as deleted has its symbols cleared, even with no new symbols in this report", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);

  await ingestRepoObservation(db, principal, {
    projectId, headSha: "f".repeat(40), changedPaths: ["lib/widget.ts"],
    symbols: [{ name: "computeWidgetTotal", kind: "function", file: "lib/widget.ts", line: 3 }],
  });
  await ingestRepoObservation(db, principal, {
    projectId, headSha: "g".repeat(40), changedPaths: ["lib/widget.ts"], deletedPaths: ["lib/widget.ts"],
  });

  const rows = await db.prepare("SELECT 1 FROM repo_symbols WHERE project_id = ? AND file = ?").bind(projectId, "lib/widget.ts").all();
  assert.equal(rows.results.length, 0);
});

test("reporting the same commit twice does not re-process symbols a second time (idempotent replay)", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const headSha = "h".repeat(40);

  const first = await ingestRepoObservation(db, principal, {
    projectId, headSha, changedPaths: ["lib/widget.ts"],
    symbols: [{ name: "computeWidgetTotal", kind: "function", file: "lib/widget.ts", line: 3 }],
  });
  const second = await ingestRepoObservation(db, principal, {
    projectId, headSha, changedPaths: ["lib/widget.ts"],
    symbols: [{ name: "computeWidgetTotal", kind: "function", file: "lib/widget.ts", line: 3 }],
  });
  assert.equal(first.idempotentReplay, false);
  assert.equal(second.idempotentReplay, true);

  const rows = await db.prepare("SELECT 1 FROM repo_symbols WHERE project_id = ? AND symbol = ?").bind(projectId, "computeWidgetTotal").all();
  assert.equal(rows.results.length, 1);
});

test("an observation with no symbols at all leaves repo_symbols untouched, without crashing", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const result = await ingestRepoObservation(db, principal, { projectId, headSha: "i".repeat(40), changedPaths: ["lib/widget.ts"] });
  assert.equal(result.idempotentReplay, false);
  const rows = await db.prepare("SELECT 1 FROM repo_symbols WHERE project_id = ?").bind(projectId).all();
  assert.equal(rows.results.length, 0);
});

test("symbols are scoped per project — an identical symbol name in another project never crosses over", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, principal, { action: "create_project", name: "Other", idempotencyKey: "repo-symbols-proj-b" })).projectId;

  await ingestRepoObservation(db, principal, {
    projectId: projectA, headSha: "j".repeat(40), changedPaths: ["lib/widget.ts"],
    symbols: [{ name: "computeWidgetTotal", kind: "function", file: "lib/widget.ts", line: 3 }],
  });

  const rowsB = await db.prepare("SELECT 1 FROM repo_symbols WHERE project_id = ? AND symbol = ?").bind(projectB, "computeWidgetTotal").all();
  assert.equal(rowsB.results.length, 0);
});

test("a symbol entry missing a name or file is skipped rather than stored blank", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);

  await ingestRepoObservation(db, principal, {
    projectId, headSha: "k".repeat(40), changedPaths: ["lib/widget.ts"],
    symbols: [
      { name: "", kind: "function", file: "lib/widget.ts", line: 1 },
      { name: "realSymbol", kind: "function", file: "", line: 2 },
      { name: "goodSymbol", kind: "function", file: "lib/widget.ts", line: 3 },
    ],
  });

  const rows = await db.prepare("SELECT symbol FROM repo_symbols WHERE project_id = ?").bind(projectId).all();
  assert.deepEqual(rows.results.map((r) => r.symbol), ["goodSymbol"]);
});
