#!/usr/bin/env node
/**
 * E0's evaluation harness: replays the golden set against the current matcher and prints
 * a measured baseline. Every later reconciliation milestone (E1–E7 in
 * RECONCILIATION_ARCHITECTURE.md) is judged against the numbers this prints, not against
 * a claim — that is the whole reason this exists before any of them do.
 *
 * Run with:
 *   npm run reconcile:eval [-- --project=prj_xyz]
 *
 * Needs DATABASE_URL pointed at a real database; the golden set only has labels once
 * people have actually merged, split, or dismissed something (see lib/dedup/labels.ts for
 * where those get captured). An empty label set is not a failure — it prints as much and
 * exits 0, since there is nothing yet to contradict.
 *
 * Exit code is 1 only when falseMerges > 0. That is the one number
 * `DEDUPLICATION_ARCHITECTURE.md §6.3`'s asymmetry says can veto a release: every other
 * metric here is informational.
 */
import { env } from "@/lib/runtime-env.ts";
import { evaluateReconciliation, snapshotAdjudication } from "@/lib/dedup/labels.ts";
import { measureBlockingRecall } from "@/lib/dedup/blocking-eval.ts";
import { snapshotAdjudicationFs } from "@/lib/dedup/fellegi-sunter.ts";

function parseArgs(argv) {
  const projectId = argv.find((arg) => arg.startsWith("--project="))?.slice("--project=".length);
  return { projectId };
}

async function loadLabels(db, projectId) {
  const clause = projectId ? "WHERE project_id = ?" : "";
  const rows = await db.prepare(`SELECT * FROM reconciliation_labels ${clause} ORDER BY created_at`).bind(...(projectId ? [projectId] : [])).all();
  return rows.results.map((row) => ({
    leftItemId: String(row.left_item_id),
    rightItemId: String(row.right_item_id),
    verdict: String(row.verdict),
    confidence: String(row.confidence),
    source: String(row.label_source),
    recordedFeatures: JSON.parse(String(row.features ?? "{}")),
  }));
}

async function loadItems(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await db.prepare("SELECT id, title, description FROM work_items WHERE id = ANY(?::text[])").bind(ids).all();
  for (const row of rows.results) map.set(String(row.id), { title: String(row.title ?? ""), description: String(row.description ?? "") });
  return map;
}

/** measureBlockingRecall needs project_id and created_at too, which the scoring-stage
 * loadItems above deliberately doesn't fetch — kept separate so the two harnesses stay
 * legible about what each one actually needs from a row. */
async function loadBlockingItems(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await db.prepare("SELECT id, project_id, title, description, created_at FROM work_items WHERE id = ANY(?::text[])").bind(ids).all();
  for (const row of rows.results) map.set(String(row.id), { projectId: String(row.project_id), title: String(row.title ?? ""), description: String(row.description ?? ""), createdAt: String(row.created_at) });
  return map;
}

/** Planbraid is single-user per organization (§9 decision 4 in the roadmap) — one
 * deployment's golden set never genuinely spans more than one organization, so resolving
 * a single organization_id to evaluate against is correct, not a simplification that
 * happens to work for now. */
async function loadOrganizationId(db, projectId) {
  if (projectId) {
    const row = await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(projectId).first();
    return row ? String(row.organization_id) : null;
  }
  const row = await db.prepare("SELECT organization_id FROM reconciliation_labels LIMIT 1").first();
  return row ? String(row.organization_id) : null;
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

async function main() {
  const { projectId } = parseArgs(process.argv.slice(2));
  const db = env.DB;

  const labels = await loadLabels(db, projectId);
  console.log(`Reconciliation evaluation${projectId ? ` — project ${projectId}` : " — all projects"}`);
  console.log(`Golden set: ${labels.length} label${labels.length === 1 ? "" : "s"}`);
  if (!labels.length) {
    console.log("\nNothing to evaluate yet — labels accumulate as people merge, split, or dismiss findings.");
    process.exit(0);
  }

  const ids = [...new Set(labels.flatMap((label) => [label.leftItemId, label.rightItemId]))];
  const items = await loadItems(db, ids);
  const missing = labels.filter((label) => !items.has(label.leftItemId) || !items.has(label.rightItemId)).length;
  if (missing) console.log(`(${missing} label${missing === 1 ? "" : "s"} skipped — an item they reference no longer exists)`);

  const report = evaluateReconciliation(labels, items, (left, right) => snapshotAdjudication(left, right));
  const fsReport = evaluateReconciliation(labels, items, (left, right) => snapshotAdjudicationFs(left, right));

  const organizationId = await loadOrganizationId(db, projectId);
  let blockingReport = null;
  if (organizationId) {
    const blockingItems = await loadBlockingItems(db, ids);
    blockingReport = await measureBlockingRecall(db, organizationId, labels, blockingItems);
  }

  console.log("\n── E1: blocking recall (must be ≥99%) ──");
  if (!blockingReport) {
    console.log("Skipped — could not resolve an organization for this label set.");
  } else {
    console.log(`Evaluated: ${blockingReport.total} same-labelled pair${blockingReport.total === 1 ? "" : "s"}`);
    console.log(`Blocking recall@50: ${formatPct(blockingReport.recall)}`);
    for (const miss of blockingReport.missed) {
      console.log(`  - MISSED: blocking for ${miss.newerItemId} never retrieved ${miss.olderItemId} (project ${miss.olderProjectId})`);
    }
  }

  console.log(`\n── E0: scoring recall/precision ──`);
  console.log(`Evaluated: ${report.total}`);
  console.log(`Recall (true duplicates the matcher collapses):    ${formatPct(report.recall)}`);
  console.log(`Precision (collapses that are actually the same):  ${formatPct(report.precision)}`);
  console.log(`Split true duplicates (correct, but only 'possible', never collapsed): ${report.splitTrueDuplicates}`);
  console.log(`\nFalse merges (must be zero): ${report.falseMerges}`);
  for (const example of report.falseMergeExamples) {
    console.log(`  - ${example.leftItemId} / ${example.rightItemId} — matcher said '${example.matcherVerdict}', a person had said different`);
  }

  console.log("\n── E3: Fellegi-Sunter scorer vs. the live cascade (informational — not yet the production path) ──");
  console.log(`Cascade  — recall ${formatPct(report.recall)}, precision ${formatPct(report.precision)}, false merges ${report.falseMerges}, split true duplicates ${report.splitTrueDuplicates}`);
  console.log(`FS (seed weights) — recall ${formatPct(fsReport.recall)}, precision ${formatPct(fsReport.precision)}, false merges ${fsReport.falseMerges}, split true duplicates ${fsReport.splitTrueDuplicates}`);
  for (const example of fsReport.falseMergeExamples) {
    console.log(`  - FS false merge: ${example.leftItemId} / ${example.rightItemId} — FS said '${example.matcherVerdict}', a person had said different`);
  }
  const fsBeatsBaseline = fsReport.falseMerges === 0 && fsReport.recall >= report.recall && fsReport.precision >= report.precision;
  console.log(fsBeatsBaseline
    ? "FS beats the cascade baseline on this golden set (E3's own gate, §13) — still gated on real training data before cutover, per SEED_WEIGHTS's own caveat."
    : "FS does not yet beat the cascade baseline on this golden set — expected with hand-guessed seed weights; run `npm run reconcile:train` once enough labels exist and re-check.");

  console.log("\nBy label source:");
  for (const [source, bucket] of Object.entries(report.bySource)) {
    if (!bucket.total) continue;
    console.log(`  ${source}: ${bucket.total} labels, recall ${formatPct(bucket.recall)}`);
  }

  let failed = false;
  if (report.falseMerges > 0) {
    console.log(`\nFAIL: ${report.falseMerges} false merge${report.falseMerges === 1 ? "" : "s"} — a person explicitly corrected this pair and the current matcher would collapse it anyway.`);
    failed = true;
  }
  if (blockingReport && blockingReport.total > 0 && blockingReport.recall < 0.99) {
    console.log(`\nFAIL: blocking recall@50 is ${formatPct(blockingReport.recall)}, below E1's 99% gate (RECONCILIATION_ARCHITECTURE.md §13) — ${blockingReport.missed.length} true duplicate${blockingReport.missed.length === 1 ? "" : "s"} would never even reach the scorer.`);
    failed = true;
  }
  if (failed) process.exit(1);
  console.log("\nOK: no false merges, blocking recall at or above gate.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
