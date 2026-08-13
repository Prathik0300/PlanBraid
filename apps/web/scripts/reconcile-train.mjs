#!/usr/bin/env node
/**
 * E3 training: supervised MLE re-estimation of Fellegi-Sunter m/u weights from
 * `reconciliation_labels` — the same golden set E0's harness reads. The counting and
 * smoothing math lives in `lib/dedup/train.ts` (tested in isolation); this script only
 * fetches labels/items from the database and prints the result.
 *
 * Classical Fellegi-Sunter estimates m/u via unsupervised EM because record-linkage
 * practice usually has no ground truth for which pairs are actually the same. Planbraid's
 * labels ARE ground truth — a person merged, split, or dismissed something — so counting
 * observed-level frequencies directly, split by the label's verdict, is the correct
 * closed-form MLE estimator for this problem, not an approximation of EM
 * (RECONCILIATION_ARCHITECTURE.md §4.2, §8.1).
 *
 * Run with:
 *   npm run reconcile:train [-- --project=prj_xyz] [--min-labels=20]
 *
 * Prints a WeightTable as JSON to stdout, and a plain-text summary to stderr. This is
 * deliberately NOT written back into fellegi-sunter.ts automatically — the roadmap's own
 * discipline ("no training runs in production... reviewed in a pull request") means a
 * human reviews the new numbers and decides whether to replace `SEED_WEIGHTS`, the same
 * way any other code change lands. To adopt a trained table: save this script's stdout to
 * a file and pass it explicitly to `adjudicateFs`/`decide`, rather than overwriting the
 * seed in place.
 *
 * Edge cases (see lib/dedup/train.ts for the implementation):
 *   - Pairs `checkVetoes` would catch never reach the Fellegi-Sunter scorer in
 *     production — excluded from every tally, or their observations would teach the
 *     model about cases it structurally never sees.
 *   - A feature with fewer than `--min-labels` supporting observations keeps its ENTIRE
 *     seed value rather than training only its well-supported levels.
 *   - The prior (λ) and cost ratio are NOT re-estimated from the label sample: the golden
 *     set is selection-biased toward pairs someone already looked at, which skews far
 *     more "same" than the true population of candidate pairs Stage 1 blocking retrieves,
 *     and cost ratio is a policy choice labels can't answer. Both carry over from
 *     `SEED_WEIGHTS` unchanged.
 */
import { env } from "@/lib/runtime-env.ts";
import { buildSignature, fingerprint } from "@/lib/dedup/signature.ts";
import { SEED_WEIGHTS } from "@/lib/dedup/fellegi-sunter.ts";
import { estimateWeights, tallyPairs } from "@/lib/dedup/train.ts";

function parseArgs(argv) {
  const projectId = argv.find((arg) => arg.startsWith("--project="))?.slice("--project=".length);
  const minLabelsArg = argv.find((arg) => arg.startsWith("--min-labels="))?.slice("--min-labels=".length);
  const minLabels = minLabelsArg ? Number(minLabelsArg) : 20;
  return { projectId, minLabels: Number.isFinite(minLabels) && minLabels > 0 ? minLabels : 20 };
}

async function loadLabels(db, projectId) {
  const clause = projectId ? "WHERE project_id = ?" : "";
  const rows = await db.prepare(`SELECT * FROM reconciliation_labels ${clause} ORDER BY created_at`).bind(...(projectId ? [projectId] : [])).all();
  return rows.results.map((row) => ({
    leftItemId: String(row.left_item_id),
    rightItemId: String(row.right_item_id),
    verdict: String(row.verdict),
  }));
}

async function loadItems(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await db.prepare("SELECT id, title, description FROM work_items WHERE id = ANY(?::text[])").bind(ids).all();
  for (const row of rows.results) map.set(String(row.id), { title: String(row.title ?? ""), description: String(row.description ?? "") });
  return map;
}

async function main() {
  const { projectId, minLabels } = parseArgs(process.argv.slice(2));
  const db = env.DB;

  const labels = await loadLabels(db, projectId);
  console.error(`Reconciliation training${projectId ? ` — project ${projectId}` : " — all projects"}`);
  console.error(`Label rows: ${labels.length}`);
  if (!labels.length) {
    console.error("\nNothing to train on yet — labels accumulate as people merge, split, or dismiss findings.");
    console.log(JSON.stringify(SEED_WEIGHTS, null, 2));
    process.exit(0);
  }

  const ids = [...new Set(labels.flatMap((label) => [label.leftItemId, label.rightItemId]))];
  const items = await loadItems(db, ids);
  const usable = labels.filter((label) => items.has(label.leftItemId) && items.has(label.rightItemId) && (label.verdict === "same" || label.verdict === "different"));
  const skippedMissing = labels.length - usable.length;
  if (skippedMissing) console.error(`(${skippedMissing} label${skippedMissing === 1 ? "" : "s"} skipped — a referenced item no longer exists, or an unrecognized verdict)`);

  const pairs = await Promise.all(usable.map(async (label) => {
    const left = items.get(label.leftItemId);
    const right = items.get(label.rightItemId);
    const leftSignature = buildSignature(left.title, left.description);
    const rightSignature = buildSignature(right.title, right.description);
    const proposal = { signature: leftSignature, fingerprintValue: await fingerprint(leftSignature) };
    const candidate = { id: label.rightItemId, itemKey: "", title: right.title, status: "", signature: rightSignature, fingerprintValue: await fingerprint(rightSignature) };
    return { proposal, candidate, verdict: label.verdict };
  }));

  const tallied = tallyPairs(pairs);
  console.error(`Pairs excluded because a veto would catch them before scoring: ${tallied.vetoedSkipped}`);
  console.error(`Pairs used for training: ${tallied.sameTotal} 'same', ${tallied.differentTotal} 'different'`);
  console.error(`Feature/level supported by fewer than ${minLabels} labels on either side keeps its seed value.\n`);

  const { weights, report } = estimateWeights(tallied, minLabels);
  for (const row of report) {
    console.error(`  ${row.feature}: ${row.status} (same=${row.sameObserved}, different=${row.differentObserved})`);
  }

  const table = { prior: SEED_WEIGHTS.prior, costRatio: SEED_WEIGHTS.costRatio, weights };
  console.error(`\nprior and costRatio carried over from SEED_WEIGHTS unchanged (see module comment for why).`);
  console.error("Review this table before adopting it — it does not get written back automatically.\n");
  console.log(JSON.stringify(table, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
