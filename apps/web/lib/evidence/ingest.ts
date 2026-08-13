/**
 * M15 — repository observations via the bridge.
 *
 * The bridge hook reports what actually happened in the working tree at turn end: a
 * commit sha, a branch, the paths that changed since the merge base, and the exit status
 * of whatever verification command the user configured, if any. Never file contents,
 * never diffs — the same "never opens provider transcript files" promise the bridge
 * already keeps for prompts extends to code here, and `integrations/README.md` states it
 * for exactly the same reason: what leaves the machine is metadata, not the work itself.
 *
 * The one piece of judgment this module makes: an observation only writes `result:
 * "verified"` evidence when a verification command was configured *and* it exited zero.
 * A commit merely touching a file is not proof the file is correct — lib/trust/confidence
 * already treats "verified" as the strongest tier (`verifiedEvidenceCount`), so writing it
 * for an unverified touch would be exactly the kind of fabricated trust signal M9 exists
 * to prevent. An observation with no configured command still attaches evidence — "this
 * file was touched, unverified" is real information — just never the word "verified".
 */
import { executeCommand, organizationFor, type Principal } from "@/lib/store.ts";
import { text, nullable, number, parseJson, type Row } from "@/lib/read/rows.ts";
import type { PgD1 } from "@/db/pg-d1";

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export type RepoObservationInput = {
  projectId: string;
  sourceId?: string;
  headSha: string;
  branch?: string;
  changedPaths: string[];
  /** Paths git reported as removed or renamed away — a subset of changedPaths. Feeds
   * M17's evidence_removed finding; never used for M15's own evidence-attachment, since a
   * file being deleted is not "touched" in the sense that attaches positive evidence. */
  deletedPaths?: string[];
  verificationCommand?: string;
  verificationExitCode?: number;
};

export type RepoObservationResult = {
  observationId: string;
  matchedItemIds: string[];
  idempotentReplay: boolean;
};

function normalizedPath(value: string) {
  return value.trim().toLowerCase().replace(/^\.\//, "");
}

/** A changed path "touches" an artifact if the artifact is the path itself or a
 * path-boundary-aligned suffix of it — an artifact extracted from prose is often a bare
 * filename ("signature.ts") while a changed path is always the full repo-relative one
 * ("apps/web/lib/dedup/signature.ts"), and the two have to be comparable. The boundary
 * check matters: without it, "backingstore.ts" would match the artifact "store.ts" on
 * plain character-suffix alone, a false positive between two unrelated files.
 *
 * Exported for M17's evidence_removed finding, which asks the identical question of
 * `deleted_paths` instead of `changed_paths` — the same matcher, a different path list. */
export function touchesArtifact(changedPath: string, artifact: string) {
  const path = normalizedPath(changedPath);
  return path === artifact || path.endsWith(`/${artifact}`);
}

export async function ingestRepoObservation(db: PgD1, principal: Principal, input: RepoObservationInput): Promise<RepoObservationResult> {
  const organizationId = await organizationFor(db, principal);
  const headSha = input.headSha.trim().slice(0, 100);
  if (!headSha) throw Object.assign(new Error("head_sha is required"), { code: "VALIDATION_FAILED", status: 422 });
  const changedPaths = [...new Set(input.changedPaths.map((path) => path.trim()).filter(Boolean))].slice(0, 200).map((path) => path.slice(0, 500));
  const deletedPaths = [...new Set((input.deletedPaths ?? []).map((path) => path.trim()).filter(Boolean))].slice(0, 200).map((path) => path.slice(0, 500));

  const inserted = await db.prepare(
    "INSERT INTO repo_observations (id, organization_id, project_id, source_id, head_sha, branch, changed_paths, deleted_paths, verification_command, verification_exit_code) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, head_sha) DO NOTHING RETURNING id",
  ).bind(id("robs"), organizationId, input.projectId, input.sourceId ?? null, headSha, input.branch?.slice(0, 200) ?? null, JSON.stringify(changedPaths), JSON.stringify(deletedPaths), input.verificationCommand?.slice(0, 500) ?? null, input.verificationExitCode ?? null).first<{ id: string }>();

  if (!inserted) {
    // Idempotent replay: this commit was already reported (a retried hook call, or two
    // sessions observing the same branch state). Evidence was already attached the first
    // time; attaching it again would double-count "who touched this" and inflate
    // completion_confidence's evidence count for no new information.
    const existing = await db.prepare("SELECT id FROM repo_observations WHERE project_id = ? AND head_sha = ?").bind(input.projectId, headSha).first<{ id: string }>();
    return { observationId: existing?.id ?? "", matchedItemIds: [], idempotentReplay: true };
  }

  // A deleted path is not positive evidence of anything — it is the opposite signal, and
  // M17's evidence_removed finding depends on being able to tell "confirmed present as of
  // this commit" from "removed by this commit". Attaching commit evidence for a path this
  // same observation deleted would refresh that confirmation at the exact moment the file
  // stopped existing, permanently masking the removal from ever being detected.
  const deletedSet = new Set(deletedPaths.map((path) => path.trim().toLowerCase()));
  const touchablePaths = changedPaths.filter((path) => !deletedSet.has(path.trim().toLowerCase()));
  if (!touchablePaths.length) return { observationId: inserted.id, matchedItemIds: [], idempotentReplay: false };

  const artifactRows = await db.prepare(
    "SELECT DISTINCT work_item_id, artifact FROM work_item_artifacts WHERE project_id = ? AND organization_id = ?",
  ).bind(input.projectId, organizationId).all<Row>();

  const matches = new Map<string, string[]>();
  for (const row of artifactRows.results) {
    const artifact = text(row, "artifact");
    const workItemId = text(row, "work_item_id");
    const touchedPaths = touchablePaths.filter((path) => touchesArtifact(path, artifact));
    if (!touchedPaths.length) continue;
    matches.set(workItemId, [...(matches.get(workItemId) ?? []), ...touchedPaths]);
  }

  const verified = input.verificationExitCode === 0 && Boolean(input.verificationCommand);
  const result = verified ? "verified" : input.verificationExitCode != null ? "failed" : undefined;
  const shortSha = headSha.slice(0, 7);

  for (const [workItemId, paths] of matches) {
    const uniquePaths = [...new Set(paths)];
    await executeCommand(db, principal, {
      action: "add_evidence", projectId: input.projectId, itemId: workItemId, type: "commit",
      label: `Commit ${shortSha} touched ${uniquePaths.slice(0, 3).join(", ")}${uniquePaths.length > 3 ? ` and ${uniquePaths.length - 3} more` : ""}`,
      result, sourceId: input.sourceId, idempotencyKey: `${inserted.id}:evidence:${workItemId}`,
    });
  }

  return { observationId: inserted.id, matchedItemIds: [...matches.keys()], idempotentReplay: false };
}

export type RepoObservation = {
  id: string; projectId: string; sourceId: string | null; headSha: string; branch: string | null;
  changedPaths: string[]; deletedPaths: string[]; verificationCommand: string | null; verificationExitCode: number | null; createdAt: string;
};

export function mapRepoObservation(row: Row): RepoObservation {
  return {
    id: text(row, "id"), projectId: text(row, "project_id"), sourceId: nullable(row, "source_id"),
    headSha: text(row, "head_sha"), branch: nullable(row, "branch"), changedPaths: parseJson<string[]>(text(row, "changed_paths"), []),
    deletedPaths: parseJson<string[]>(text(row, "deleted_paths"), []),
    verificationCommand: nullable(row, "verification_command"), verificationExitCode: row.verification_exit_code == null ? null : number(row, "verification_exit_code"),
    createdAt: text(row, "created_at"),
  };
}
