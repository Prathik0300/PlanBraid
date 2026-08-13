import { ensureSchema } from "@/db/setup";
import type { PgD1, PgD1PreparedStatement } from "@/db/pg-d1";
import { AGENT_WRITABLE_MATURITIES, MATURITIES, RESOLUTIONS, type Authority, type Command, type DashboardState, type Maturity, type Resolution, type WorkItem, type WorkStatus } from "@/lib/contracts";
import type { Proposal } from "@/lib/dedup/match.ts";
import { aliasStatement, resolveProposals } from "@/lib/dedup/resolve.ts";
import { edgeTypeForRelation } from "@/lib/dedup/relations.ts";
import { backfillBlockingIndex, blockingIndexStatements, retrieveCandidates } from "@/lib/dedup/blocking.ts";
import { captureLabelStatement, snapshotAdjudication } from "@/lib/dedup/labels.ts";
import { appendPlanOp, type AuthorKind } from "@/lib/ops/log.ts";
import { opPayloadFrom } from "@/lib/ops/hash.ts";
import { DAG_EDGE_TYPES, DAG_EDGE_TYPE_SQL_LIST, isDagEdgeType } from "@/lib/graph/edges.ts";
import { accountDisplayName, agentAccountKey, normalizeAccountLabel, providerFamily } from "@/lib/providers.ts";
import { provenanceFor, type Provenance } from "@/lib/trust/provenance.ts";
import { mapAlias, mapClaim, mapDependency, mapEvent, mapEvidence, mapItem, mapNotification, mapProject, mapSource, nullable, number, parseJson, text, type Row } from "@/lib/read/rows.ts";
import { itemKeysFor } from "@/lib/read/project-view.ts";

export type Principal = {
  userId: string;
  email: string;
  displayName: string;
  scopes?: string[];
  /**
   * How this request authenticated. Required, not optional: it is what decides whether the
   * caller may accept work or only propose it (see isHumanPrincipal), and a path that
   * forgot to set it would silently get one answer or the other. Making it mandatory moves
   * that from a convention to a compile error.
   */
  authentication: "browser" | "personal_token" | "oauth" | "local";
  /** The credential the request authenticated with, and the agent login it stands for.
   * Set for token/OAuth connections; absent for browser sessions, which are the person
   * themselves rather than one of their agents. */
  credentialId?: string;
  agentAccountId?: string;
  agentAccountLabel?: string;
};

const ALLOWED_TRANSITIONS: Record<WorkStatus, WorkStatus[]> = {
  proposed: ["planned", "ready", "cancelled"],
  planned: ["ready", "blocked", "cancelled"],
  ready: ["in_progress", "blocked", "cancelled"],
  in_progress: ["blocked", "in_review", "done", "cancelled"],
  blocked: ["ready", "in_progress", "cancelled"],
  in_review: ["done", "in_progress", "blocked", "cancelled"],
  done: ["ready", "in_progress", "cancelled"],
  cancelled: ["proposed", "planned"],
};

/** A resolved item can never leave anything blocked on it. Cancelled counts as resolved
 * exactly like done: if it didn't, cancelling an upstream task would deadlock its whole
 * downstream subtree permanently and invisibly. */
const RESOLVED_STATUSES = new Set<WorkStatus>(["done", "cancelled"]);

/**
 * A signed-in person acting in the web UI, as opposed to one of their agents holding a
 * token. This is the whole of the agent-permission model: an agent may propose, and only a
 * person may decide. See PLANNING_INTELLIGENCE_ROADMAP.md D1.
 */
function isHumanPrincipal(principal: Principal) {
  return principal.authentication === "browser";
}

function authorKindOf(principal: Principal): AuthorKind {
  return isHumanPrincipal(principal) ? "human" : "agent";
}

/**
 * Where a promotion's authority came from. An agent reporting "the user said yes" is real
 * evidence and worth recording, but it is not the same evidence as the user clicking
 * accept, and collapsing the two would make the distinction unrecoverable later.
 */
function authorityFor(principal: Principal, statedBy?: string): Authority {
  if (isHumanPrincipal(principal)) return "human_approved";
  return statedBy?.trim() ? "human_stated" : "agent_proposed";
}

/** The maturity a newly proposed item starts at, by who is proposing it. A person typing
 * a task in the UI is deciding; an agent listing tasks is suggesting. */
function defaultMaturity(principal: Principal): Maturity {
  return isHumanPrincipal(principal) ? "accepted" : "proposal";
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function digest(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}


export async function organizationFor(db: PgD1, principal: Principal) {
  await ensureSchema(db);
  const existing = await db.prepare("SELECT id FROM organizations WHERE owner_user_id = ?").bind(principal.userId).first<{ id: string }>();
  const suffix = (await digest(principal.userId)).slice(0, 10);
  const organizationId = `org_${suffix}`;

  if (existing) {
    await removeLegacyDemoData(db, existing.id, suffix);
    await removeGeneratedProjectShorthands(db, existing.id);
    await resetUnearnedVerification(db, existing.id);
    return existing.id;
  }

  // organizationId is deterministic per user, and Postgres genuinely runs concurrent
  // requests in parallel (unlike D1, which serializes every query against a database) —
  // two near-simultaneous first-load requests for a brand-new user can both reach this
  // point believing no organization exists yet. ON CONFLICT DO NOTHING makes the losing
  // insert a no-op instead of an unhandled unique-violation.
  await db.batch([
    db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING").bind(organizationId, `${principal.displayName}'s workspace`, principal.userId),
    db.prepare("INSERT INTO data_migrations (organization_id, migration_key) VALUES (?, ?) ON CONFLICT (organization_id, migration_key) DO NOTHING").bind(organizationId, LEGACY_DEMO_MIGRATION),
    db.prepare("INSERT INTO data_migrations (organization_id, migration_key) VALUES (?, ?) ON CONFLICT (organization_id, migration_key) DO NOTHING").bind(organizationId, PROJECT_SHORTHAND_MIGRATION),
    // A brand-new organization has nothing to correct, so the marker is written up front
    // rather than making every future load re-check an empty table.
    db.prepare("INSERT INTO data_migrations (organization_id, migration_key) VALUES (?, ?) ON CONFLICT (organization_id, migration_key) DO NOTHING").bind(organizationId, VERIFICATION_HONESTY_MIGRATION),
  ]);
  return organizationId;
}

const LEGACY_DEMO_MIGRATION = "2026-08-10-remove-built-in-demo-data";
const PROJECT_SHORTHAND_MIGRATION = "2026-08-10-remove-generated-project-shorthands";
const VERIFICATION_HONESTY_MIGRATION = "2026-08-13-verification-status-is-not-status";

/**
 * Undoes finding F4's damage to existing data.
 *
 * Every item ever moved to done was stamped verification_status='passed' and
 * completion_confidence='verified' purely because of the move, with nothing having checked
 * anything. Leaving those values would mean the trust layer's first act is to report
 * fabricated verification, so they are reset for every item with no evidence at all.
 *
 * Items that do carry evidence keep 'supported': something was attached, even if nothing
 * has machine-checked it yet. That is what M16's verifier will upgrade.
 */
async function resetUnearnedVerification(db: PgD1, organizationId: string) {
  const alreadyApplied = await db.prepare("SELECT 1 FROM data_migrations WHERE organization_id = ? AND migration_key = ?").bind(organizationId, VERIFICATION_HONESTY_MIGRATION).first();
  if (alreadyApplied) return;
  await db.batch([
    db.prepare("UPDATE work_items SET verification_status = 'pending', completion_confidence = 'reported' WHERE organization_id = ? AND NOT EXISTS (SELECT 1 FROM evidence WHERE evidence.work_item_id = work_items.id)").bind(organizationId),
    db.prepare("UPDATE work_items SET verification_status = 'pending', completion_confidence = 'supported' WHERE organization_id = ? AND verification_status = 'passed' AND EXISTS (SELECT 1 FROM evidence WHERE evidence.work_item_id = work_items.id)").bind(organizationId),
    db.prepare("INSERT INTO data_migrations (organization_id, migration_key) VALUES (?, ?) ON CONFLICT (organization_id, migration_key) DO NOTHING").bind(organizationId, VERIFICATION_HONESTY_MIGRATION),
  ]);
}

async function removeLegacyDemoData(db: PgD1, organizationId: string, suffix: string) {
  const alreadyApplied = await db.prepare("SELECT 1 FROM data_migrations WHERE organization_id = ? AND migration_key = ?").bind(organizationId, LEGACY_DEMO_MIGRATION).first();
  if (alreadyApplied) return;

  const relayProjectId = `prj_${suffix}_relay`;
  const emberProjectId = `prj_${suffix}_ember`;
  const projectIds = [relayProjectId, emberProjectId] as const;
  const statements = [
    db.prepare("DELETE FROM notifications WHERE organization_id = ? AND project_id IN (?, ?)").bind(organizationId, ...projectIds),
    db.prepare("DELETE FROM evidence WHERE organization_id = ? AND project_id IN (?, ?)").bind(organizationId, ...projectIds),
    db.prepare("DELETE FROM dependencies WHERE organization_id = ? AND project_id IN (?, ?)").bind(organizationId, ...projectIds),
    db.prepare("DELETE FROM work_claims WHERE work_item_id IN (SELECT id FROM work_items WHERE organization_id = ? AND project_id IN (?, ?))").bind(organizationId, ...projectIds),
    db.prepare("DELETE FROM work_events WHERE organization_id = ? AND project_id IN (?, ?)").bind(organizationId, ...projectIds),
    db.prepare("DELETE FROM interactions WHERE organization_id = ? AND project_id IN (?, ?)").bind(organizationId, ...projectIds),
    db.prepare("DELETE FROM work_items WHERE organization_id = ? AND project_id IN (?, ?)").bind(organizationId, ...projectIds),
    db.prepare("DELETE FROM sources WHERE organization_id = ? AND project_id IN (?, ?)").bind(organizationId, ...projectIds),
    db.prepare("DELETE FROM coding_spaces WHERE organization_id = ? AND project_id IN (?, ?)").bind(organizationId, ...projectIds),
    db.prepare("DELETE FROM projects WHERE organization_id = ? AND id IN (?, ?)").bind(organizationId, ...projectIds),
    db.prepare("INSERT INTO data_migrations (organization_id, migration_key) VALUES (?, ?) ON CONFLICT (organization_id, migration_key) DO NOTHING").bind(organizationId, LEGACY_DEMO_MIGRATION),
  ];
  await db.batch(statements);
}

async function removeGeneratedProjectShorthands(db: PgD1, organizationId: string) {
  const alreadyApplied = await db.prepare("SELECT 1 FROM data_migrations WHERE organization_id = ? AND migration_key = ?").bind(organizationId, PROJECT_SHORTHAND_MIGRATION).first();
  if (alreadyApplied) return;
  await db.batch([
    db.prepare("UPDATE work_events SET summary = (SELECT replace(work_events.summary, work_items.item_key, '#' || work_items.sequence) FROM work_items WHERE work_items.id = work_events.work_item_id) WHERE organization_id = ? AND work_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM work_items WHERE work_items.id = work_events.work_item_id)").bind(organizationId),
    db.prepare("UPDATE notifications SET title = (SELECT replace(notifications.title, work_items.item_key, '#' || work_items.sequence) FROM work_items WHERE work_items.id = notifications.work_item_id), body = (SELECT replace(notifications.body, work_items.item_key, '#' || work_items.sequence) FROM work_items WHERE work_items.id = notifications.work_item_id) WHERE organization_id = ? AND work_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM work_items WHERE work_items.id = notifications.work_item_id)").bind(organizationId),
    db.prepare("UPDATE work_items SET item_key = '#' || sequence WHERE organization_id = ?").bind(organizationId),
    db.prepare("UPDATE projects SET project_key = id WHERE organization_id = ?").bind(organizationId),
    db.prepare("INSERT INTO data_migrations (organization_id, migration_key) VALUES (?, ?) ON CONFLICT (organization_id, migration_key) DO NOTHING").bind(organizationId, PROJECT_SHORTHAND_MIGRATION),
  ]);
}

export async function loadDashboard(db: PgD1, principal: Principal): Promise<DashboardState> {
  const organizationId = await organizationFor(db, principal);
  const [projects, spaces, sources, items, events, notifications, dependencies, evidenceRows, aliasRows, importRequestRows, claimRows] = await db.batch([
    db.prepare("SELECT * FROM projects WHERE organization_id = ? ORDER BY updated_at DESC").bind(organizationId),
    db.prepare("SELECT * FROM coding_spaces WHERE organization_id = ? ORDER BY last_seen_at DESC").bind(organizationId),
    db.prepare("SELECT * FROM sources WHERE organization_id = ? ORDER BY last_seen_at DESC").bind(organizationId),
    db.prepare("SELECT * FROM work_items WHERE organization_id = ? AND archived_at IS NULL ORDER BY updated_at DESC").bind(organizationId),
    db.prepare("SELECT * FROM work_events WHERE organization_id = ? ORDER BY created_at DESC, project_revision DESC LIMIT 250").bind(organizationId),
    db.prepare("SELECT * FROM notifications WHERE organization_id = ? AND recipient_user_id = ? ORDER BY created_at DESC LIMIT 100").bind(organizationId, principal.userId),
    db.prepare("SELECT * FROM dependencies WHERE organization_id = ?").bind(organizationId),
    db.prepare("SELECT * FROM evidence WHERE organization_id = ? ORDER BY created_at DESC").bind(organizationId),
    db.prepare("SELECT * FROM work_item_aliases WHERE organization_id = ? ORDER BY created_at DESC LIMIT 500").bind(organizationId),
    db.prepare("SELECT * FROM import_requests WHERE organization_id = ? AND status = 'pending' ORDER BY created_at DESC").bind(organizationId),
    // work_claims carries no organization_id of its own (F1's schema), so scoping goes
    // through work_items; only unexpired leases are ever worth shipping to a client.
    db.prepare("SELECT wc.* FROM work_claims wc JOIN work_items wi ON wi.id = wc.work_item_id WHERE wi.organization_id = ? AND wc.lease_expires_at > now()").bind(organizationId),
  ]);
  return {
    viewer: { id: principal.userId, name: principal.displayName, email: principal.email },
    projects: (projects.results as Row[]).map(mapProject),
    codingSpaces: (spaces.results as Row[]).map((row) => ({ id: text(row, "id"), projectId: text(row, "project_id"), label: text(row, "label"), safePath: text(row, "safe_path"), branch: text(row, "branch"), kind: text(row, "kind"), status: text(row, "status"), lastSeenAt: text(row, "last_seen_at") })),
    sources: (sources.results as Row[]).map(mapSource),
    workItems: (items.results as Row[]).map(mapItem),
    events: (events.results as Row[]).map(mapEvent),
    notifications: (notifications.results as Row[]).map(mapNotification),
    dependencies: (dependencies.results as Row[]).map(mapDependency),
    evidence: (evidenceRows.results as Row[]).map(mapEvidence),
    aliases: (aliasRows.results as Row[]).map(mapAlias),
    importRequests: (importRequestRows.results as Row[]).map((row) => ({ id: text(row, "id"), projectId: text(row, "project_id"), sourceId: text(row, "source_id"), createdAt: text(row, "created_at") })),
    claims: (claimRows.results as Row[]).map(mapClaim),
    serverTime: new Date().toISOString(),
  };
}

async function ownedProject(db: PgD1, organizationId: string, projectId: string) {
  const project = await db.prepare("SELECT * FROM projects WHERE id = ? AND organization_id = ?").bind(projectId, organizationId).first<Row>();
  if (!project) throw domainError("NOT_FOUND", "Project not found", 404);
  return project;
}

/**
 * Reduces any git remote spelling to `host/owner/repo` so the same repository compares
 * equal however it was written. These are all one repository:
 *   https://github.com/Owner/Repo      https://github.com/Owner/Repo.git
 *   git@github.com:Owner/Repo.git      https://user@github.com/owner/repo/
 * Real duplicates came from exactly this: the web UI stored the browse URL while the
 * agent read `.git`-suffixed origin out of the checkout.
 */
export function normalizeGitRemote(raw?: string | null) {
  const value = (raw ?? "").trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  if (!value) return "";
  const scp = /^[a-z0-9._-]+@([^:/]+):(.+)$/.exec(value);
  if (scp) return `${scp[1]}/${scp[2]}`;
  return value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^@/]+@/, "");
}

/** Trailing separators are the only meaningful noise in a path we are given verbatim. */
export function normalizeDirectory(raw?: string | null) {
  return (raw ?? "").trim().replace(/\/+$/, "");
}

export type ProjectMatch = { id: string; name: string; matchedOn: "git remote" | "directory" | "name" };

/**
 * Finds the project an incoming create/resolve refers to. Ordered strongest first: a
 * remote names one repository unambiguously, a working directory names one checkout,
 * and an identical name is a strong hint when neither is present.
 */
export async function findMatchingProject(db: PgD1, organizationId: string, input: { name?: string; directory?: string; gitRemote?: string }): Promise<ProjectMatch | null> {
  const rows = (await db.prepare("SELECT id, name, directory, git_remote FROM projects WHERE organization_id = ? AND status <> 'archived' ORDER BY created_at").bind(organizationId).all<Row>()).results;
  const remote = normalizeGitRemote(input.gitRemote);
  const directory = normalizeDirectory(input.directory);
  const name = (input.name ?? "").trim().toLowerCase();

  const byRemote = remote ? rows.find((row) => normalizeGitRemote(nullable(row, "git_remote")) === remote) : undefined;
  if (byRemote) return { id: text(byRemote, "id"), name: text(byRemote, "name"), matchedOn: "git remote" };

  // A remote names one repository, so a project carrying a different one is definitively
  // not this work and must not match on weaker evidence. Without this, acme/api and
  // contoso/api collapse into each other purely because both are called "api".
  const candidates = remote ? rows.filter((row) => { const found = normalizeGitRemote(nullable(row, "git_remote")); return !found || found === remote; }) : rows;

  const byDirectory = directory ? candidates.find((row) => normalizeDirectory(text(row, "directory")) === directory) : undefined;
  if (byDirectory) return { id: text(byDirectory, "id"), name: text(byDirectory, "name"), matchedOn: "directory" };
  const byName = name ? candidates.find((row) => text(row, "name").trim().toLowerCase() === name) : undefined;
  if (byName) return { id: text(byName, "id"), name: text(byName, "name"), matchedOn: "name" };
  return null;
}

function domainError(code: string, message: string, status = 422, details?: unknown) {
  return Object.assign(new Error(message), { code, status, details });
}

async function commitMutation(db: PgD1, statements: PgD1PreparedStatement[]) {
  try {
    return await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Postgres reports a unique-violation as error code 23505 with a message like
    // `duplicate key value violates unique constraint "..."`, not SQLite/D1's `UNIQUE
    // constraint failed`/`database is locked` text — check both so this still maps to
    // a 409 instead of leaking as a 500.
    const code = (error as { code?: string }).code;
    if (code === "23505" || /UNIQUE constraint failed|violates unique constraint|constraint failed|database is locked/i.test(message)) {
      throw domainError("CONCURRENT_MODIFICATION", "Project state changed while this operation was committing; reload and retry with the current version", 409, { retryable: true });
    }
    throw error;
  }
}

async function idempotentResult(db: PgD1, scope: string, key: string, requestHash: string) {
  const row = await db.prepare("SELECT request_hash, response FROM idempotency_records WHERE scope = ? AND idempotency_key = ?").bind(scope, key).first<{ request_hash: string; response: string }>();
  if (!row) return null;
  if (row.request_hash !== requestHash) throw domainError("IDEMPOTENCY_MISMATCH", "This idempotency key was already used for another request", 409);
  return { ...parseJson<Record<string, unknown>>(row.response, {}), idempotentReplay: true };
}

export async function executeCommand(db: PgD1, principal: Principal, command: Command) {
  const organizationId = await organizationFor(db, principal);
  const scope = `${organizationId}:${principal.userId}:${command.action}`;
  const requestHash = await digest(JSON.stringify(command));
  const replay = await idempotentResult(db, scope, command.idempotencyKey, requestHash);
  if (replay) return replay;

  if (command.action === "mark_notification") {
    const now = new Date().toISOString();
    // Explicit ::timestamptz casts on both the timestamp literal and the untyped NULL: a
    // CASE mixing a bound text-looking parameter, a bare NULL, and a TIMESTAMPTZ column
    // reference leaves Postgres nothing but context to infer a type from, and this
    // pattern had zero test coverage in the whole suite — nothing had ever actually run
    // this query before. Real booleans (not 0/1 integers compared against a literal)
    // read as what they mean.
    const update = await db.prepare("UPDATE notifications SET read_at = CASE WHEN ?::boolean THEN ?::timestamptz ELSE NULL::timestamptz END, resolved_at = CASE WHEN ?::boolean THEN ?::timestamptz ELSE resolved_at END WHERE id = ? AND organization_id = ? AND recipient_user_id = ? RETURNING id").bind(command.read !== false, now, Boolean(command.resolved), now, command.notificationId, organizationId, principal.userId).first();
    if (!update) throw domainError("NOT_FOUND", "Notification not found", 404);
    const response = { notificationId: command.notificationId };
    await db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)).run();
    return response;
  }

  if (command.action === "create_project") {
    const cleanName = command.name.trim().slice(0, 120);
    if (!cleanName) throw domainError("VALIDATION_FAILED", "Project name is required");

    // The match read and the insert must be one atomic step, or two agents starting in
    // the same repository at once both read "no match" and both insert. The advisory
    // lock is per organization, held only for this transaction, and released by Postgres
    // on commit or rollback, so a failure part-way cannot strand it.
    return db.transaction(async (tx) => {
      await tx.lock(`planbraid:create_project:${organizationId}`);
      const projectId = id("prj");
      const now = new Date().toISOString();

      // Match before creating, the same contract create_work_items uses for tasks. One
      // repository opened from the web UI and from an agent is one project; without this
      // the two produced parallel projects that each held half the work.
      const existing = await findMatchingProject(tx, organizationId, { name: cleanName, directory: command.directory, gitRemote: command.gitRemote });
      if (existing) {
        const directory = normalizeDirectory(command.directory);
        const gitRemote = command.gitRemote?.trim().slice(0, 500);
        // A name is only a hint: two projects can legitimately share one. Report it as
        // uncertain and let the caller decide, rather than silently folding them
        // together the way a remote or directory match justifies.
        const decisive = existing.matchedOn !== "name";
        const adopted = decisive
          ? await tx.prepare("UPDATE projects SET directory = CASE WHEN directory = '' THEN COALESCE(?, directory) ELSE directory END, git_remote = COALESCE(git_remote, ?), updated_at = ? WHERE id = ? AND organization_id = ? RETURNING directory, git_remote")
            .bind(directory || null, gitRemote || null, now, existing.id, organizationId).first<Row>()
          : await tx.prepare("SELECT directory, git_remote FROM projects WHERE id = ?").bind(existing.id).first<Row>();

        const response = {
          projectId: existing.id,
          status: decisive ? ("matched" as const) : ("uncertain" as const),
          matchedOn: existing.matchedOn,
          project: { id: existing.id, name: existing.name, directory: text(adopted ?? {}, "directory"), gitRemote: nullable(adopted ?? {}, "git_remote") },
          warning: decisive
            ? `This is the existing project "${existing.name}", matched by ${existing.matchedOn}. Use it instead of creating another for the same work.`
            : `A project named "${existing.name}" already exists. If it is the same work, use this project_id. If it is genuinely separate, call create_project again with a distinct name.`,
        };
        await tx.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)).run();
        return response;
      }

      const response = { projectId, projectRevision: 1, status: "created" as const };
      await tx.prepare("INSERT INTO projects (id, organization_id, project_key, name, description, directory, git_remote, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)").bind(projectId, organizationId, projectId, cleanName, command.description?.trim().slice(0, 2000) ?? "", command.directory?.trim().slice(0, 500) ?? "", command.gitRemote?.trim().slice(0, 500) || null, now).run();
      await tx.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, actor_name, event_type, summary, created_at) VALUES (?, ?, ?, 1, ?, 'project.created', ?, ?)").bind(id("evt"), organizationId, projectId, principal.displayName, `${principal.displayName} created ${cleanName}`, now).run();
      await tx.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)).run();
      return response;
    });
  }

  const project = await ownedProject(db, organizationId, command.projectId);
  const currentRevision = number(project, "revision");
  const nextRevision = currentRevision + 1;
  const now = new Date().toISOString();

  if (command.action === "update_project") {
    // Every field is optional and COALESCE keeps the current value when one is omitted,
    // so an agent binding only its working directory cannot blank out the name or
    // description a person set in the UI.
    const cleanName = command.name?.trim().slice(0, 120);
    if (command.name !== undefined && !cleanName) throw domainError("VALIDATION_FAILED", "Project name cannot be empty");
    const directory = command.directory?.trim().slice(0, 500);
    const gitRemote = command.gitRemote?.trim().slice(0, 500);
    const changed = [cleanName && "name", command.description !== undefined && "description", directory && "directory", gitRemote && "remote", command.gateProposals !== undefined && "proposal gating"].filter(Boolean).join(", ") || "details";
    // Merged into the existing settings rather than replacing them, so adding a second
    // setting later cannot silently clear the first.
    const settings = command.gateProposals === undefined
      ? null
      : JSON.stringify({ ...parseJson<Record<string, unknown>>(text(project, "settings"), {}), gateProposals: command.gateProposals });
    const response = { projectId: command.projectId, projectRevision: nextRevision };
    await commitMutation(db, [
      db.prepare("UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), directory = COALESCE(?, directory), git_remote = COALESCE(?, git_remote), settings = COALESCE(?, settings), revision = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND revision = ?")
        .bind(cleanName ?? null, command.description?.trim().slice(0, 2000) ?? null, directory ?? null, gitRemote ?? null, settings, nextRevision, now, command.projectId, organizationId, currentRevision),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, actor_name, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?, 'project.updated', ?, ?)")
        .bind(id("evt"), organizationId, command.projectId, nextRevision, principal.displayName, `${principal.displayName} updated ${changed}`, now),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
    ]);
    return response;
  }

  if (command.action === "create_item") {
    const cleanTitle = command.title.trim().slice(0, 240);
    if (!cleanTitle) throw domainError("VALIDATION_FAILED", "Task title is required");
    const max = await db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM work_items WHERE project_id = ?").bind(command.projectId).first<{ sequence: number }>();
    const sequence = Number(max?.sequence ?? 0) + 1;
    const itemId = id("wi");
    const itemKey = `#${sequence}`;
    const status = command.status ?? "proposed";
    // An agent may not create work already accepted. Anything it asks for above its
    // ceiling is clamped rather than rejected: the item is still real and still recorded,
    // it just arrives as a proposal awaiting a person, which is the honest state.
    const requested = command.maturity && MATURITIES.includes(command.maturity) ? command.maturity : defaultMaturity(principal);
    const maturity: Maturity = isHumanPrincipal(principal) || AGENT_WRITABLE_MATURITIES.includes(requested) ? requested : "proposal";
    const actor = command.sourceId ? await sourceActor(db, organizationId, command.sourceId) : principal.displayName;
    const interactionId = await activeInteractionId(db, command.sourceId);
    const description = command.description?.trim().slice(0, 10000) ?? "";
    const itemType = command.type?.trim().slice(0, 40) || "task";
    const response = { itemId, itemKey, version: 1, projectRevision: nextRevision, maturity };
    await commitMutation(db, [
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND revision = ?").bind(nextRevision, now, command.projectId, organizationId, currentRevision),
      db.prepare("INSERT INTO work_items (id, organization_id, project_id, sequence, item_key, type, title, description, status, maturity, priority, source_id, content_fingerprint, status_provenance, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)").bind(itemId, organizationId, command.projectId, sequence, itemKey, itemType, cleanTitle, description, status, maturity, command.priority ?? "normal", command.sourceId ?? null, command.contentFingerprint ?? null, provenanceFor(principal), now, now),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, interaction_id, actor_name, event_type, summary, to_status, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'work_item.created', ?, ?, ?, ?)").bind(id("evt"), organizationId, command.projectId, nextRevision, itemId, command.sourceId ?? null, interactionId, actor, `${actor} created ${itemKey}: ${cleanTitle}`, status, provenanceFor(principal), now),
      // Indexed in the same batch as the insert, so an item is never visible to a reader
      // without being visible to the matcher that has to find it.
      ...blockingIndexStatements(db, { organizationId, projectId: command.projectId, workItemId: itemId, title: cleanTitle, description, now }),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
    ]);
    await appendPlanOp(db, { organizationId, projectId: command.projectId, type: command.action, payload: opPayloadFrom({ ...command, itemId }), authorKind: authorKindOf(principal), authorName: actor, sourceId: command.sourceId });
    return response;
  }

  if (command.action === "add_dependency") {
    if (command.fromWorkItemId === command.toWorkItemId) throw domainError("BLOCKING_CYCLE", "A task cannot block itself");
    const [from, to] = await db.batch([
      db.prepare("SELECT id, status FROM work_items WHERE id = ? AND project_id = ? AND organization_id = ?").bind(command.fromWorkItemId, command.projectId, organizationId),
      db.prepare("SELECT id, source_id FROM work_items WHERE id = ? AND project_id = ? AND organization_id = ?").bind(command.toWorkItemId, command.projectId, organizationId),
    ]);
    if (!from.results.length || !to.results.length) throw domainError("NOT_FOUND", "Dependency task not found", 404);
    const edgeType = command.type ?? "blocks";
    const actor = await resolveActor(db, organizationId, principal, command.sourceId, nullable(to.results[0], "source_id"));
    const dependencyInteractionId = await activeInteractionId(db, command.sourceId ?? nullable(to.results[0], "source_id"));
    // A duplicate edge is a no-op, not a conflict: two agents independently declaring
    // the same prerequisite agree with each other. Without this check the INSERT below
    // trips the UNIQUE(from, to, type) constraint and commitMutation's generic handler
    // reports it as CONCURRENT_MODIFICATION, which is the wrong signal for "this already
    // exists" versus a genuine concurrent write.
    const existing = await db.prepare("SELECT id FROM dependencies WHERE from_work_item_id = ? AND to_work_item_id = ? AND type = ? AND project_id = ?")
      .bind(command.fromWorkItemId, command.toWorkItemId, edgeType, command.projectId).first<{ id: string }>();
    if (existing) return { dependencyId: existing.id, projectRevision: currentRevision, idempotentReplay: true };
    // Cycle detection only matters for ordering edges; symmetric annotation edges
    // (relates_to, duplicates, supersedes) never participate in the DAG traversal, so
    // adding both directions of one is two true facts, not a cycle.
    const cycle = isDagEdgeType(edgeType) ? await dependencyWouldCycle(db, command.projectId, command.fromWorkItemId, command.toWorkItemId) : null;
    if (cycle) throw domainError("BLOCKING_CYCLE", "This dependency would create a cycle", 422, cycle);
    const dependencyId = id("dep");
    const response = { dependencyId, projectRevision: nextRevision };
    const statements = [
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(nextRevision, now, command.projectId, currentRevision),
      db.prepare("INSERT INTO dependencies (id, organization_id, project_id, from_work_item_id, to_work_item_id, type, reason) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(dependencyId, organizationId, command.projectId, command.fromWorkItemId, command.toWorkItemId, edgeType, command.reason?.slice(0, 1000) ?? ""),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, interaction_id, actor_name, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dependency.added', ?, ?)").bind(id("evt"), organizationId, command.projectId, nextRevision, command.toWorkItemId, command.sourceId ?? nullable(to.results[0], "source_id"), dependencyInteractionId, actor, `${actor} added a dependency`, now),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
    ];
    // Only a hard, unresolved prerequisite blocks anything. An edge to an already-done
    // or cancelled item, or an annotation edge, never increments the dependent's count.
    if (isDagEdgeType(edgeType) && !RESOLVED_STATUSES.has(text(from.results[0], "status") as WorkStatus)) {
      statements.push(db.prepare("UPDATE work_items SET blocking_count = blocking_count + 1, updated_at = ? WHERE id = ?").bind(now, command.toWorkItemId));
    }
    await commitMutation(db, statements);
    await appendPlanOp(db, { organizationId, projectId: command.projectId, type: command.action, payload: opPayloadFrom({ ...command, dependencyId }), authorKind: authorKindOf(principal), authorName: actor, sourceId: command.sourceId });
    return response;
  }

  if (command.action === "set_maturity") {
    if (!MATURITIES.includes(command.maturity)) throw domainError("VALIDATION_FAILED", `Unknown maturity: ${command.maturity}`);
    const itemIds = [...new Set(command.itemIds)].slice(0, 100);
    if (!itemIds.length) throw domainError("VALIDATION_FAILED", "At least one task is required");
    const statedBy = command.statedBy?.trim().slice(0, 120);
    const authority = authorityFor(principal, statedBy);
    // The agent-permission model in one branch: an agent may propose, and may *report* a
    // person's decision (naming them), but may not manufacture one. Without `statedBy`
    // there is nobody the acceptance can be attributed to, which is precisely the state
    // that must not become project policy.
    if (authority === "agent_proposed" && !AGENT_WRITABLE_MATURITIES.includes(command.maturity)) {
      throw domainError("AUTHORITY_REQUIRED", `Only a person can mark work ${command.maturity}. Pass stated_by naming who decided, or leave it as a proposal for them to accept.`, 403, { allowed: AGENT_WRITABLE_MATURITIES });
    }
    const rows = await db.prepare("SELECT id, item_key, maturity FROM work_items WHERE organization_id = ? AND project_id = ? AND archived_at IS NULL AND id = ANY(?::text[])")
      .bind(organizationId, command.projectId, itemIds).all<{ id: string; item_key: string; maturity: string }>();
    if (!rows.results.length) throw domainError("NOT_FOUND", "Task not found", 404);
    // Items already at the target maturity are dropped rather than rewritten, so a
    // repeated accept does not bump versions and invalidate every agent's expected_version.
    const changing = rows.results.filter((row) => row.maturity !== command.maturity);
    const keys = changing.map((row) => row.item_key);
    const actor = await resolveActor(db, organizationId, principal, command.sourceId, null);
    const maturityInteractionId = await activeInteractionId(db, command.sourceId);
    const response = { projectId: command.projectId, maturity: command.maturity, authority, changed: changing.map((row) => row.id), itemKeys: keys, unchanged: rows.results.length - changing.length, projectRevision: changing.length ? nextRevision : currentRevision };
    if (!changing.length) {
      await db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)).run();
      return response;
    }
    const summary = `${actor} marked ${keys.join(", ")} ${command.maturity}${statedBy ? `, as decided by ${statedBy}` : ""}${command.reason ? `: ${command.reason.slice(0, 300)}` : ""}`;
    await commitMutation(db, [
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND revision = ?").bind(nextRevision, now, command.projectId, organizationId, currentRevision),
      db.prepare("UPDATE work_items SET maturity = ?, version = version + 1, updated_at = ? WHERE organization_id = ? AND id = ANY(?::text[])").bind(command.maturity, now, organizationId, changing.map((row) => row.id)),
      // One aggregate event, not one per item: work_events has UNIQUE(project_id,
      // project_revision), so N events would need N revisions, and "accepted 6 tasks" is
      // also the sentence a person wants to read.
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, interaction_id, actor_name, event_type, summary, metadata, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'work_item.maturity_changed', ?, ?, ?, ?)")
        .bind(id("evt"), organizationId, command.projectId, nextRevision, changing.length === 1 ? changing[0].id : null, command.sourceId ?? null, maturityInteractionId, actor, summary, JSON.stringify({ maturity: command.maturity, authority, statedBy: statedBy ?? null, workItemIds: changing.map((row) => row.id), itemKeys: keys }), provenanceFor(principal, { statedBy }), now),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
    ]);
    await appendPlanOp(db, { organizationId, projectId: command.projectId, type: command.action, payload: opPayloadFrom({ ...command, itemIds: changing.map((row) => row.id) }), authorKind: authorKindOf(principal), authorName: actor, sourceId: command.sourceId });
    return response;
  }

  if (command.action === "split_alias") {
    const alias = await db.prepare(
      "SELECT a.*, wi.item_key AS target_item_key, wi.title AS target_title, wi.description AS target_description FROM work_item_aliases a JOIN work_items wi ON wi.id = a.work_item_id WHERE a.id = ? AND a.organization_id = ? AND a.project_id = ?",
    ).bind(command.aliasId, organizationId, command.projectId).first<Row>();
    if (!alias) throw domainError("NOT_FOUND", "Alias not found", 404);
    const cleanTitle = text(alias, "title").trim().slice(0, 240) || "Untitled task";
    // An alias created by a merge still points at the item it archived, so undoing that
    // merge restores the original task and its key rather than leaving a renumbered
    // copy next to the history that references the old one.
    const archivedItemId = nullable(alias, "archived_work_item_id");
    if (archivedItemId) {
      const archived = await db.prepare("SELECT id, item_key FROM work_items WHERE id = ? AND project_id = ? AND organization_id = ? AND archived_at IS NOT NULL").bind(archivedItemId, command.projectId, organizationId).first<{ id: string; item_key: string }>();
      if (archived) {
        const restored = { itemId: archived.id, itemKey: archived.item_key, version: 1, projectRevision: nextRevision, splitFromWorkItemId: text(alias, "work_item_id"), restored: true };
        await commitMutation(db, [
          db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND revision = ?").bind(nextRevision, now, command.projectId, organizationId, currentRevision),
          // artifacts_indexed_at back to NULL because merge_items deleted this item's index
          // rows; the next dedup call backfills them rather than this write recomputing a
          // signature it does not otherwise need.
          db.prepare("UPDATE work_items SET archived_at = NULL, artifacts_indexed_at = NULL, resolution = NULL, resolution_reason = NULL, version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ?").bind(now, archived.id, organizationId),
          db.prepare("DELETE FROM work_item_aliases WHERE id = ? AND organization_id = ?").bind(command.aliasId, organizationId),
          db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, actor_name, event_type, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'work_item.split_from_alias', ?, ?, ?)")
            .bind(id("evt"), organizationId, command.projectId, nextRevision, archived.id, nullable(alias, "source_id"), principal.displayName, `${principal.displayName} restored ${archived.item_key} out of ${text(alias, "target_item_key")}`, JSON.stringify({ splitFromWorkItemId: text(alias, "work_item_id"), splitFromItemKey: text(alias, "target_item_key"), restored: true }), now),
          db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(restored)),
          // E0's golden set: a person undoing a merge is a negative label — "these are
          // not the same" — the correction to whatever earlier positive label the merge
          // itself recorded. See lib/dedup/labels.ts.
          captureLabelStatement(db, {
            organizationId, projectId: command.projectId, leftItemId: text(alias, "work_item_id"), rightItemId: archived.id,
            verdict: "different", confidence: "high", source: "split",
            adjudication: snapshotAdjudication({ title: text(alias, "target_title"), description: text(alias, "target_description") }, { title: text(alias, "title"), description: text(alias, "description") }),
          }),
        ]);
        await recomputeBlockingCounts(db, organizationId, command.projectId);
        await appendPlanOp(db, { organizationId, projectId: command.projectId, type: command.action, payload: opPayloadFrom({ ...command, restoredItemId: archived.id }), authorKind: authorKindOf(principal), authorName: principal.displayName, sourceId: nullable(alias, "source_id") });
        return restored;
      }
    }
    const max = await db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM work_items WHERE project_id = ?").bind(command.projectId).first<{ sequence: number }>();
    const sequence = Number(max?.sequence ?? 0) + 1;
    const itemId = id("wi");
    const itemKey = `#${sequence}`;
    const aliasSourceId = nullable(alias, "source_id");
    const targetItemKey = text(alias, "target_item_key");
    const response = { itemId, itemKey, version: 1, projectRevision: nextRevision, splitFromWorkItemId: text(alias, "work_item_id") };
    await commitMutation(db, [
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND revision = ?").bind(nextRevision, now, command.projectId, organizationId, currentRevision),
      db.prepare("INSERT INTO work_items (id, organization_id, project_id, sequence, item_key, title, description, status, priority, source_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', 'normal', ?, 1, ?, ?)").bind(itemId, organizationId, command.projectId, sequence, itemKey, cleanTitle, text(alias, "description"), aliasSourceId, now, now),
      db.prepare("DELETE FROM work_item_aliases WHERE id = ? AND organization_id = ?").bind(command.aliasId, organizationId),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, actor_name, event_type, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'work_item.split_from_alias', ?, ?, ?)").bind(id("evt"), organizationId, command.projectId, nextRevision, itemId, aliasSourceId, principal.displayName, `${principal.displayName} split "${cleanTitle}" out from ${targetItemKey} as ${itemKey}`, JSON.stringify({ splitFromWorkItemId: text(alias, "work_item_id"), splitFromItemKey: targetItemKey }), now),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
      // Same negative label as the restore path above, for a match that was never a
      // merge — the structural matcher folded a fresh proposal into an existing item, and
      // a person is now saying it should not have.
      captureLabelStatement(db, {
        organizationId, projectId: command.projectId, leftItemId: text(alias, "work_item_id"), rightItemId: itemId,
        verdict: "different", confidence: "high", source: "split",
        adjudication: snapshotAdjudication({ title: text(alias, "target_title"), description: text(alias, "target_description") }, { title: cleanTitle, description: text(alias, "description") }),
      }),
    ]);
    await appendPlanOp(db, { organizationId, projectId: command.projectId, type: command.action, payload: opPayloadFrom({ ...command, newItemId: itemId }), authorKind: authorKindOf(principal), authorName: principal.displayName, sourceId: aliasSourceId });
    return response;
  }

  if (command.action === "merge_items") {
    if (command.winnerItemId === command.loserItemId) throw domainError("VALIDATION_FAILED", "A task cannot be merged into itself");
    const [winnerRow, loserRow] = await db.batch([
      db.prepare("SELECT * FROM work_items WHERE id = ? AND project_id = ? AND organization_id = ? AND archived_at IS NULL").bind(command.winnerItemId, command.projectId, organizationId),
      db.prepare("SELECT * FROM work_items WHERE id = ? AND project_id = ? AND organization_id = ? AND archived_at IS NULL").bind(command.loserItemId, command.projectId, organizationId),
    ]);
    const winner = winnerRow.results[0] as Row | undefined;
    const loser = loserRow.results[0] as Row | undefined;
    if (!winner || !loser) throw domainError("NOT_FOUND", "Task not found", 404);
    // Collapsing work somebody actually started would hide real history behind another
    // task's status. Those stay separate and get cancelled deliberately instead.
    if (["in_progress", "in_review", "done"].includes(text(loser, "status"))) {
      throw domainError("VALIDATION_FAILED", `${text(loser, "item_key")} has already been worked on and cannot be merged away`, 422, { status: text(loser, "status") });
    }
    const winnerKey = text(winner, "item_key");
    const loserKey = text(loser, "item_key");
    const actor = await resolveActor(db, organizationId, principal, command.sourceId, nullable(loser, "source_id"));
    const reason = command.reason?.trim().slice(0, 500) || `Merged ${loserKey} into ${winnerKey}`;
    const response = { winnerItemId: command.winnerItemId, loserItemId: command.loserItemId, itemKey: winnerKey, projectRevision: nextRevision };
    await commitMutation(db, [
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND revision = ?").bind(nextRevision, now, command.projectId, organizationId, currentRevision),
      // Edges between the two would become self-edges, and edges the winner already has
      // would trip dependencies' UNIQUE(from, to, type). Both are dropped before the
      // move rather than after, so the UPDATE below can never fail.
      db.prepare("DELETE FROM dependencies WHERE project_id = ? AND ((from_work_item_id = ? AND to_work_item_id = ?) OR (from_work_item_id = ? AND to_work_item_id = ?))").bind(command.projectId, command.loserItemId, command.winnerItemId, command.winnerItemId, command.loserItemId),
      db.prepare("DELETE FROM dependencies d WHERE d.project_id = ? AND d.from_work_item_id = ? AND EXISTS (SELECT 1 FROM dependencies e WHERE e.from_work_item_id = ? AND e.to_work_item_id = d.to_work_item_id AND e.type = d.type)").bind(command.projectId, command.loserItemId, command.winnerItemId),
      db.prepare("DELETE FROM dependencies d WHERE d.project_id = ? AND d.to_work_item_id = ? AND EXISTS (SELECT 1 FROM dependencies e WHERE e.to_work_item_id = ? AND e.from_work_item_id = d.from_work_item_id AND e.type = d.type)").bind(command.projectId, command.loserItemId, command.winnerItemId),
      db.prepare("UPDATE dependencies SET from_work_item_id = ? WHERE from_work_item_id = ? AND project_id = ?").bind(command.winnerItemId, command.loserItemId, command.projectId),
      db.prepare("UPDATE dependencies SET to_work_item_id = ? WHERE to_work_item_id = ? AND project_id = ?").bind(command.winnerItemId, command.loserItemId, command.projectId),
      // The loser's own corroboration history moves with it, so merging does not discard
      // the agents that had independently proposed it.
      db.prepare("UPDATE work_item_aliases SET work_item_id = ? WHERE work_item_id = ? AND organization_id = ?").bind(command.winnerItemId, command.loserItemId, organizationId),
      db.prepare(
        "INSERT INTO work_item_aliases (id, organization_id, project_id, work_item_id, title, description, source_id, match_score, match_method, match_reason, archived_work_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'merge', ?, ?)",
      ).bind(id("als"), organizationId, command.projectId, command.winnerItemId, text(loser, "title"), text(loser, "description"), nullable(loser, "source_id"), reason, command.loserItemId),
      // The loser is archived rather than cancelled, but it still carries why it ended:
      // "duplicate" is the answer to "what happened to #7", and split_alias can undo it.
      db.prepare("UPDATE work_items SET archived_at = ?, resolution = 'duplicate', resolution_reason = ?, updated_at = ? WHERE id = ? AND organization_id = ?").bind(now, reason, now, command.loserItemId, organizationId),
      // Retrieval already filters archived items, so leaving these would only be dead
      // weight — but split_alias can restore the loser, which re-indexes on the way back.
      db.prepare("DELETE FROM work_item_artifacts WHERE work_item_id = ? AND project_id = ?").bind(command.loserItemId, command.projectId),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, actor_name, event_type, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'work_item.merged', ?, ?, ?)")
        .bind(id("evt"), organizationId, command.projectId, nextRevision, command.winnerItemId, command.sourceId ?? nullable(loser, "source_id"), actor, `${actor} merged ${loserKey} into ${winnerKey}: ${text(loser, "title")}`, JSON.stringify({ loserItemId: command.loserItemId, loserItemKey: loserKey, reason }), now),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
      // E0's golden set: a person merging two items is a positive label — "these are the
      // same work" — captured at the moment of the decision, in the same commit as the
      // merge itself. See lib/dedup/labels.ts.
      captureLabelStatement(db, {
        organizationId, projectId: command.projectId, leftItemId: command.winnerItemId, rightItemId: command.loserItemId,
        verdict: "same", confidence: "high", source: "merge", justification: reason,
        adjudication: snapshotAdjudication({ title: text(winner, "title"), description: text(winner, "description") }, { title: text(loser, "title"), description: text(loser, "description") }),
      }),
    ]);
    // Moving edges changes who blocks whom; recompute rather than trying to track the
    // delta through three conditional deletes and two moves.
    await recomputeBlockingCounts(db, organizationId, command.projectId);
    await appendPlanOp(db, { organizationId, projectId: command.projectId, type: command.action, payload: opPayloadFrom(command), authorKind: authorKindOf(principal), authorName: actor, sourceId: command.sourceId });
    return response;
  }

  const item = await db.prepare("SELECT * FROM work_items WHERE id = ? AND project_id = ? AND organization_id = ? AND archived_at IS NULL").bind(command.itemId, command.projectId, organizationId).first<Row>();
  if (!item) throw domainError("NOT_FOUND", "Task not found", 404);
  const itemKey = text(item, "item_key");

  if (command.action === "add_note") {
    const summary = command.summary.trim().slice(0, 2000);
    if (!summary) throw domainError("VALIDATION_FAILED", "Progress update is required");
    const actor = await resolveActor(db, organizationId, principal, command.sourceId, nullable(item, "source_id"));
    const noteInteractionId = await activeInteractionId(db, command.sourceId);
    const response = { itemId: command.itemId, version: number(item, "version") + 1, projectRevision: nextRevision };
    await commitMutation(db, [
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(nextRevision, now, command.projectId, currentRevision),
      db.prepare("UPDATE work_items SET version = version + 1, updated_at = ? WHERE id = ?").bind(now, command.itemId),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, interaction_id, actor_name, event_type, summary, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'work_item.progress_reported', ?, ?, ?)").bind(id("evt"), organizationId, command.projectId, nextRevision, command.itemId, command.sourceId ?? null, noteInteractionId, actor, summary, provenanceFor(principal), now),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
    ]);
    await appendPlanOp(db, { organizationId, projectId: command.projectId, type: command.action, payload: opPayloadFrom(command), authorKind: authorKindOf(principal), authorName: actor, sourceId: command.sourceId });
    return response;
  }

  if (command.action === "add_evidence") {
    const evidenceId = id("evd");
    const response = { evidenceId, itemId: command.itemId, projectRevision: nextRevision };
    // report_completion's evidence array frequently omits source_id even when the same
    // call's summary note includes it, so falling back to the work item's own bound
    // source (rather than jumping straight to the generic principal display name) is
    // what actually resolves "Connected agent attached evidence" to the real agent.
    const actor = await resolveActor(db, organizationId, principal, command.sourceId, nullable(item, "source_id"));
    const evidenceInteractionId = await activeInteractionId(db, command.sourceId);
    await commitMutation(db, [
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(nextRevision, now, command.projectId, currentRevision),
      db.prepare("INSERT INTO evidence (id, organization_id, project_id, work_item_id, type, label, uri, result, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(evidenceId, organizationId, command.projectId, command.itemId, command.type.slice(0, 40), command.label.slice(0, 300), command.uri?.slice(0, 2000) ?? null, command.result?.slice(0, 500) ?? null, command.sourceId ?? null, now),
      db.prepare("UPDATE work_items SET completion_confidence = 'supported', version = version + 1, updated_at = ? WHERE id = ?").bind(now, command.itemId),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, interaction_id, actor_name, event_type, summary, metadata, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'evidence.attached', ?, ?, ?, ?)").bind(id("evt"), organizationId, command.projectId, nextRevision, command.itemId, command.sourceId ?? null, evidenceInteractionId, actor, `${actor} attached ${command.type} evidence: ${command.label}`, JSON.stringify({ evidenceId }), provenanceFor(principal), now),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
    ]);
    await appendPlanOp(db, { organizationId, projectId: command.projectId, type: command.action, payload: opPayloadFrom({ ...command, evidenceId }), authorKind: authorKindOf(principal), authorName: actor, sourceId: command.sourceId });
    return response;
  }

  if (command.expectedVersion !== number(item, "version")) throw domainError("VERSION_CONFLICT", `Task changed since version ${command.expectedVersion}`, 409, { currentVersion: number(item, "version"), current: mapItem(item) });

  if (command.action === "update_item") {
    const title = command.title == null ? text(item, "title") : command.title.trim().slice(0, 240);
    if (!title) throw domainError("VALIDATION_FAILED", "Task title is required");
    const description = command.description == null ? text(item, "description") : command.description.trim().slice(0, 10000);
    const priority = command.priority ?? text(item, "priority");
    const assignee = command.assignee === undefined ? nullable(item, "assignee") : command.assignee;
    const actor = await resolveActor(db, organizationId, principal, command.sourceId, nullable(item, "source_id"));
    const updateInteractionId = await activeInteractionId(db, command.sourceId ?? nullable(item, "source_id"));
    const response = { itemId: command.itemId, version: command.expectedVersion + 1, projectRevision: nextRevision };
    await commitMutation(db, [
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(nextRevision, now, command.projectId, currentRevision),
      db.prepare("UPDATE work_items SET title = ?, description = ?, priority = ?, assignee = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").bind(title, description, priority, assignee, now, command.itemId, command.expectedVersion),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, interaction_id, actor_name, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'work_item.updated', ?, ?)").bind(id("evt"), organizationId, command.projectId, nextRevision, command.itemId, command.sourceId ?? nullable(item, "source_id"), updateInteractionId, actor, `${actor} updated ${itemKey}`, now),
      // Re-indexed rather than appended to: an edited title can *drop* an artifact, and an
      // index that only grows keeps matching a file the task no longer mentions.
      ...blockingIndexStatements(db, { organizationId, projectId: command.projectId, workItemId: command.itemId, title, description, now }),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
    ]);
    await appendPlanOp(db, { organizationId, projectId: command.projectId, type: command.action, payload: opPayloadFrom(command), authorKind: authorKindOf(principal), authorName: actor, sourceId: command.sourceId });
    return response;
  }

  const currentStatus = text(item, "status") as WorkStatus;
  if (!ALLOWED_TRANSITIONS[currentStatus].includes(command.status) && currentStatus !== command.status) throw domainError("INVALID_TRANSITION", `Cannot move ${itemKey} from ${currentStatus} to ${command.status}`, 422, { allowed: ALLOWED_TRANSITIONS[currentStatus] });
  const actor = await resolveActor(db, organizationId, principal, command.sourceId, nullable(item, "source_id"));
  const transitionInteractionId = await activeInteractionId(db, command.sourceId ?? nullable(item, "source_id"));
  const blockerReason = command.status === "blocked" ? command.reason?.trim().slice(0, 2000) || "Blocked without a reason" : null;
  const startedAt = command.status === "in_progress" && !item.started_at ? now : nullable(item, "started_at");
  const completedAt = command.status === "done" ? now : command.status === "in_progress" || command.status === "ready" ? null : nullable(item, "completed_at");
  // F4: neither of these is written from `status` any more. Moving a card to done said
  // nothing about whether anything was verified, yet it set verification_status='passed'
  // and completion_confidence='verified' — which made the product's central distinction
  // ("an agent says it finished" versus "the implementation exists") unrepresentable even
  // though both columns existed. They now change only when evidence changes.
  const verification = text(item, "verification_status");
  const confidence = text(item, "completion_confidence");
  if (command.resolution && !RESOLUTIONS.includes(command.resolution)) throw domainError("VALIDATION_FAILED", `Unknown resolution: ${command.resolution}`);
  const enteringTerminal = RESOLVED_STATUSES.has(command.status);
  // Completing a task resolves it as completed; cancelling one without saying why is
  // recorded as 'unspecified' rather than guessed at. "Nobody wrote down the reason" is
  // itself a fact worth keeping, and inventing 'abandoned' or 'rejected' would assert
  // something no actor said.
  const resolution: Resolution | null = enteringTerminal
    ? command.resolution ?? (command.status === "done" ? "completed" : "unspecified")
    : null;
  const resolutionReason = enteringTerminal ? command.resolutionReason?.trim().slice(0, 1000) ?? command.reason?.trim().slice(0, 1000) ?? null : null;
  // Deferral is cleared by starting or finishing the work: an item somebody is actively
  // holding is not "not now", whatever date was on it.
  const deferredUntil = command.deferredUntil !== undefined
    ? command.deferredUntil
    : ["in_progress", "in_review", "done", "cancelled"].includes(command.status) ? null : nullable(item, "deferred_until");
  const statusProvenance: Provenance = provenanceFor(principal);
  const eventType = transitionEvent(command.status);
  const summary = `${actor} moved ${itemKey} from ${currentStatus.replaceAll("_", " ")} to ${command.status.replaceAll("_", " ")}${command.reason ? `: ${command.reason.slice(0, 500)}` : ""}`;
  const notificationId = id("ntf");
  const requiresAction = ["blocked", "in_review"].includes(command.status) ? 1 : 0;

  // Resolving (done/cancelled) frees every hard-downstream item whose last blocker this
  // was; reopening puts that block back. Both are computed before the batch (which item
  // is "about to cross the threshold" needs a read), then applied and reported inside
  // the same atomic batch as the transition itself. See GRAPH_ARCHITECTURE.md §4.4/§8.
  const wasResolved = RESOLVED_STATUSES.has(currentStatus);
  const willBeResolved = RESOLVED_STATUSES.has(command.status);
  // Every hard-downstream item is decremented/incremented unconditionally (a task with
  // two blockers must still drop from 2 to 1 when only one resolves). "Crossing" is the
  // subset actually reaching the threshold that flips their derived column: 2 -> 1 is
  // silent, 1 -> 0 is what the aggregate event and its extra revision are for.
  const downstream = wasResolved === willBeResolved ? [] : await downstreamOf(db, organizationId, command.projectId, command.itemId);
  const crossing = downstream.filter((entry) => entry.blockingCount === (willBeResolved ? 1 : 0));
  // Freeing items needs its own revision: work_events has UNIQUE(project_id, revision),
  // so the aggregate propagation event cannot share the main transition's revision.
  const propagationRevision = crossing.length ? nextRevision + 1 : null;
  const finalRevision = propagationRevision ?? nextRevision;

  const response = { itemId: command.itemId, version: command.expectedVersion + 1, projectRevision: finalRevision, notificationId };
  const statements = [
    db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(finalRevision, now, command.projectId, currentRevision),
    db.prepare("UPDATE work_items SET status = ?, blocker_reason = ?, started_at = ?, completed_at = ?, verification_status = ?, completion_confidence = ?, resolution = ?, resolution_reason = ?, deferred_until = ?, status_provenance = ?, source_id = COALESCE(?, source_id), version = version + 1, updated_at = ? WHERE id = ? AND version = ?").bind(command.status, blockerReason, startedAt, completedAt, verification, confidence, resolution, resolutionReason, deferredUntil, statusProvenance, command.sourceId ?? null, now, command.itemId, command.expectedVersion),
    db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, interaction_id, actor_name, event_type, summary, from_status, to_status, provenance, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id("evt"), organizationId, command.projectId, nextRevision, command.itemId, command.sourceId ?? nullable(item, "source_id"), transitionInteractionId, actor, eventType, summary, currentStatus, command.status, statusProvenance, command.reason?.trim().slice(0, 1000) ?? resolutionReason, now),
    db.prepare("INSERT INTO notifications (id, organization_id, recipient_user_id, project_id, work_item_id, source_id, event_type, priority, title, body, deep_link, dedupe_key, requires_action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(notificationId, organizationId, principal.userId, command.projectId, command.itemId, command.sourceId ?? nullable(item, "source_id"), eventType, command.status === "blocked" ? "high" : "normal", `${itemKey} · ${command.status.replaceAll("_", " ")}`, summary, `/?project=${command.projectId}&item=${command.itemId}`, `${eventType}:${command.itemId}:${nextRevision}`, requiresAction, now),
    db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
  ];

  if (downstream.length) {
    const placeholders = downstream.map(() => "?").join(", ");
    const propagationUpdate = willBeResolved
      // Stamp unblocked_at only on the ones actually reaching 0; an item with another
      // remaining blocker (2 -> 1) isn't unblocked yet, so its timestamp stays unset.
      ? db.prepare(`UPDATE work_items SET blocking_count = blocking_count - 1, unblocked_at = CASE WHEN blocking_count - 1 <= 0 THEN ? ELSE unblocked_at END, updated_at = ? WHERE organization_id = ? AND id IN (${placeholders})`)
        .bind(now, now, organizationId, ...downstream.map((entry) => entry.id))
      // Reopening puts the block back, so a stale "was unblocked at" timestamp from
      // before must be cleared rather than left to imply the item is still ready.
      : db.prepare(`UPDATE work_items SET blocking_count = blocking_count + 1, unblocked_at = NULL, updated_at = ? WHERE organization_id = ? AND id IN (${placeholders})`)
        .bind(now, organizationId, ...downstream.map((entry) => entry.id));
    statements.push(propagationUpdate);
  }

  if (crossing.length) {
    const verb = willBeResolved ? (command.status === "done" ? "completed" : "cancelled") : "reopened";
    const keys = crossing.map((entry) => entry.itemKey);
    // Deliberately not "work_item.unblocked": transitionEvent() above already uses that
    // exact string for "this item itself moved to ready." This event is about OTHER
    // items reacting to this one, so it needs a distinct name or the two are
    // indistinguishable to anything consuming the event stream.
    const propagationEventType = willBeResolved ? "work_item.downstream_unblocked" : "work_item.downstream_reblocked";
    const propagationSummary = willBeResolved
      ? `${actor} ${verb} ${itemKey}, unblocking ${keys.length} task${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}`
      : `${actor} ${verb} ${itemKey}, which re-blocks ${keys.length} task${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}`;
    statements.push(
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, actor_name, event_type, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id("evt"), organizationId, command.projectId, propagationRevision, command.itemId, actor, propagationEventType, propagationSummary, JSON.stringify({ triggeredByWorkItemId: command.itemId, triggeredByItemKey: itemKey, workItemIds: crossing.map((entry) => entry.id), itemKeys: keys }), now),
      db.prepare("INSERT INTO notifications (id, organization_id, recipient_user_id, project_id, work_item_id, event_type, priority, title, body, deep_link, dedupe_key, requires_action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id("ntf"), organizationId, principal.userId, command.projectId, command.itemId, propagationEventType, "normal", willBeResolved ? `${keys.length} task${keys.length === 1 ? "" : "s"} now ready` : `${keys.length} task${keys.length === 1 ? "" : "s"} blocked again`, propagationSummary, `/?project=${command.projectId}`, `${propagationEventType}:${command.itemId}:${propagationRevision}`, 0, now),
    );
  }

  await commitMutation(db, statements);
  await appendPlanOp(db, { organizationId, projectId: command.projectId, type: command.action, payload: opPayloadFrom(command), authorKind: authorKindOf(principal), authorName: actor, sourceId: command.sourceId });
  return response;
}

/** Hard-downstream items (via DAG_EDGE_TYPES) of `itemId`, with their current blocking_count. */
async function downstreamOf(db: PgD1, organizationId: string, projectId: string, itemId: string) {
  const rows = await db.prepare(
    `SELECT wi.id AS id, wi.item_key AS "itemKey", wi.blocking_count AS "blockingCount" FROM dependencies d
       JOIN work_items wi ON wi.id = d.to_work_item_id
      WHERE d.from_work_item_id = ? AND d.project_id = ? AND wi.organization_id = ?
        AND d.type IN (${DAG_EDGE_TYPE_SQL_LIST})`,
  ).bind(itemId, projectId, organizationId, ...DAG_EDGE_TYPES).all<{ id: string; itemKey: string; blockingCount: number }>();
  return rows.results;
}

/**
 * How many items each of `itemIds` is the *last* remaining blocker for — the greedy
 * scheduling signal `get_ready_work` ranks on.
 *
 * One grouped query rather than a `downstreamOf` per candidate: the loop version issued a
 * query for every ready item on every "what next" call, and this is the hottest read path
 * an agent has. Items with no downstream simply do not appear in the result, so callers
 * default to 0.
 */
async function unlockCountsFor(db: PgD1, organizationId: string, projectId: string, itemIds: string[]) {
  const counts = new Map<string, number>();
  if (!itemIds.length) return counts;
  const rows = await db.prepare(
    `SELECT d.from_work_item_id AS id, COUNT(*) AS "unlockCount" FROM dependencies d
       JOIN work_items wi ON wi.id = d.to_work_item_id
      WHERE d.project_id = ? AND wi.organization_id = ? AND d.type IN (${DAG_EDGE_TYPE_SQL_LIST})
        AND wi.blocking_count = 1 AND d.from_work_item_id = ANY(?::text[])
      GROUP BY d.from_work_item_id`,
  ).bind(projectId, organizationId, ...DAG_EDGE_TYPES, itemIds).all<{ id: string; unlockCount: number }>();
  for (const row of rows.results) counts.set(row.id, Number(row.unlockCount));
  return counts;
}

/**
 * Recomputes blocking_count for every item in a project from the dependency table,
 * correcting any drift. Not wired to a scheduler yet (see IMPLEMENTATION_PLAN.md M3),
 * but safe to call any time, including from an ad hoc maintenance script.
 */
export async function recomputeBlockingCounts(db: PgD1, organizationId: string, projectId: string) {
  await db.prepare(
    `UPDATE work_items SET blocking_count = (
       SELECT COUNT(*) FROM dependencies d
         JOIN work_items u ON u.id = d.from_work_item_id
        WHERE d.to_work_item_id = work_items.id AND d.type IN (${DAG_EDGE_TYPE_SQL_LIST}) AND u.status NOT IN ('done', 'cancelled') AND u.archived_at IS NULL
     )
     WHERE project_id = ? AND organization_id = ?`,
  ).bind(...DAG_EDGE_TYPES, projectId, organizationId).run();
}

/**
 * The name an event is recorded under. Events are a permanent log read long after the
 * fact, so this names the *account*, not just the model: with two logins for one model
 * connected, "Claude" on every row would be exactly as useless as the "Connected agent"
 * it replaced.
 */
export function actorNameFor(provider: string, accountLabel?: string | null) {
  return accountDisplayName(provider, accountLabel);
}

async function sourceActor(db: PgD1, organizationId: string, sourceId: string) {
  const row = await db.prepare("SELECT provider, agent_account_label FROM sources WHERE id = ? AND organization_id = ?").bind(sourceId, organizationId).first<{ provider: string; agent_account_label: string | null }>();
  if (!row) throw domainError("NOT_FOUND", "Source not found", 404);
  return actorNameFor(row.provider, row.agent_account_label);
}

/**
 * Who to record an event under, most specific first.
 *
 * Not every per-item tool call repeats source_id (report_completion's evidence array in
 * particular often omits it), so there has to be a fallback. It cannot be the work
 * item's own source, though, except as a last resort: that names whoever *created* the
 * item, which with two logins for one model connected is regularly not whoever is
 * acting now. The authenticated connection is, and it carries a real name.
 */
/**
 * The interaction currently open for a source, if any — what every mutation event should
 * be tagged with, so reconciliation can ask "which events happened during this exact
 * interaction" instead of guessing from a timestamp window (finding F9).
 *
 * A timestamp window cannot answer that question correctly once two interactions from the
 * same source overlap: `created_at >= started_at` with no matching upper bound counts
 * every later interaction's events too, and a source with two interactions genuinely open
 * at once has no way to tell, from time alone, which one produced which event. Tagging the
 * event itself at write time removes the ambiguity instead of narrowing the window.
 *
 * Most sources have at most one 'started' interaction at a time — the normal
 * begin/complete-per-turn pattern — so this is a single indexed lookup, not a scan. If more
 * than one is somehow open (a retried begin_interaction, a client bug), the most recently
 * started one is treated as current: it is the one most likely to actually be receiving new
 * mutations right now.
 */
async function activeInteractionId(db: PgD1, sourceId: string | null | undefined) {
  if (!sourceId) return null;
  const row = await db.prepare("SELECT id FROM interactions WHERE source_id = ? AND status = 'started' ORDER BY started_at DESC LIMIT 1").bind(sourceId).first<{ id: string }>();
  return row?.id ?? null;
}

async function resolveActor(db: PgD1, organizationId: string, principal: Principal, sourceId: string | null | undefined, itemSourceId: string | null | undefined) {
  if (sourceId) return sourceActor(db, organizationId, sourceId);
  if (principal.agentAccountId) return principal.displayName;
  // Only for connections with no identity of their own to offer; a signed-in person is
  // already named by displayName and must not be relabelled as one of their agents.
  if (itemSourceId && principal.authentication !== "browser") return sourceActor(db, organizationId, itemSourceId);
  return principal.displayName;
}

function transitionEvent(status: WorkStatus) {
  if (status === "in_progress") return "work_item.started";
  if (status === "blocked") return "work_item.blocked";
  if (status === "in_review") return "work_item.completion_reported";
  if (status === "done") return "work_item.completion_verified";
  if (status === "ready") return "work_item.unblocked";
  if (status === "cancelled") return "work_item.cancelled";
  return "work_item.status_changed";
}

/** Matches GRAPH_ARCHITECTURE.md §4.5's bound: enough for any real project, cheap to exhaust on a malformed graph. */
const CYCLE_CHECK_MAX_DEPTH = 64;

/**
 * Would adding edge `fromId -> toId` create a cycle? Equivalent to asking: does a
 * path already exist from `toId` back to `fromId`? Walks forward from `toId` along
 * existing DAG edges (`dependencies.type` filtered to DAG_EDGE_TYPES, so symmetric
 * annotation edges like `relates_to` never trip this) via a depth-bounded recursive
 * CTE, so cost is proportional to the downstream reachable set rather than the
 * whole project's edge count.
 */
async function dependencyWouldCycle(db: PgD1, projectId: string, fromId: string, toId: string) {
  const row = await db.prepare(
    `WITH RECURSIVE downstream(id, path, depth) AS (
       SELECT ? AS id, ? AS path, 0 AS depth
       UNION
       SELECT d.to_work_item_id, downstream.path || ',' || d.to_work_item_id, downstream.depth + 1
         FROM dependencies d
         JOIN downstream ON d.from_work_item_id = downstream.id
        WHERE d.project_id = ? AND d.type IN (${DAG_EDGE_TYPE_SQL_LIST}) AND downstream.depth < ?
     )
     SELECT path FROM downstream WHERE id = ? LIMIT 1`,
  ).bind(toId, toId, projectId, ...DAG_EDGE_TYPES, CYCLE_CHECK_MAX_DEPTH, fromId).first<{ path: string }>();
  return row ? row.path.split(",") : null;
}

export function errorResponse(error: unknown) {
  const typed = error as Error & { code?: string; status?: number; details?: unknown };
  return Response.json({ error: { code: typed.code ?? "INTERNAL_ERROR", message: typed.code ? typed.message : "Unexpected server error", details: typed.details, requestId: crypto.randomUUID() } }, { status: typed.status ?? 500 });
}

export async function createMcpToken(db: PgD1, principal: Principal, name: string) {
  const organizationId = await organizationFor(db, principal);
  const tokenId = id("tok");
  const tokenName = name.trim().slice(0, 120) || "Agent connection";
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Array.from(secretBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const token = `pbd_${secret}`;
  await db.prepare("INSERT INTO mcp_tokens (id, organization_id, owner_user_id, name, token_hash) VALUES (?, ?, ?, ?, ?)").bind(tokenId, organizationId, principal.userId, tokenName, await digest(token)).run();
  return { id: tokenId, name: tokenName, token, endpoint: "/mcp", scopes: ["work:read", "work:write"] };
}

export async function listMcpTokens(db: PgD1, principal: Principal) {
  const organizationId = await organizationFor(db, principal);
  const rows = await db.prepare("SELECT id, name, scopes, last_used_at, created_at FROM mcp_tokens WHERE organization_id = ? AND owner_user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 100")
    .bind(organizationId, principal.userId).all<{ id: string; name: string; scopes: string; last_used_at: string | null; created_at: string }>();
  return rows.results.map((row) => ({ id: row.id, name: row.name, scopes: row.scopes.split(/[ ,]+/).filter(Boolean), lastUsedAt: row.last_used_at, createdAt: row.created_at }));
}

export async function revokeMcpToken(db: PgD1, principal: Principal, tokenId: string) {
  const organizationId = await organizationFor(db, principal);
  const revoked = await db.prepare("UPDATE mcp_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND owner_user_id = ? AND revoked_at IS NULL RETURNING id")
    .bind(tokenId, organizationId, principal.userId).first<{ id: string }>();
  if (!revoked) throw domainError("NOT_FOUND", "MCP connection not found", 404);
  return { id: revoked.id, revoked: true };
}

/**
 * `agentMarker` is the optional `?agent=` value from the MCP URL, which is how two CLI
 * aliases sharing one credential tell themselves apart. It is caller-supplied, so it
 * only ever labels work within an already-authenticated account — it grants nothing.
 *
 * Both branches name the connection after its credential rather than the old fixed
 * "Connected agent" / "OAuth-connected agent" strings: that name is the one thing about
 * an agent connection the owner actually chose, and every write falls back to
 * principal.displayName when a command carries no source of its own.
 */
export async function principalFromBearer(db: PgD1, authorization: string | null, resource?: string, agentMarker?: string | null): Promise<Principal | null> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  const tokenHash = await digest(token);
  const marker = normalizeAccountLabel(agentMarker);
  const identify = (credentialId: string, credentialName: string) => ({
    credentialId,
    agentAccountId: agentAccountKey(credentialId, marker) ?? undefined,
    agentAccountLabel: marker ?? credentialName,
    displayName: marker ? `${credentialName} (${marker})` : credentialName,
  });
  const personal = await db.prepare("SELECT id, name, owner_user_id, scopes FROM mcp_tokens WHERE token_hash = ? AND revoked_at IS NULL").bind(tokenHash).first<{ id: string; name: string; owner_user_id: string; scopes: string }>();
  if (personal) {
    await db.prepare("UPDATE mcp_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?").bind(tokenHash).run();
    return { userId: personal.owner_user_id, email: `${personal.owner_user_id}@planbraid.agent`, scopes: personal.scopes.split(/[ ,]+/).filter(Boolean), authentication: "personal_token", ...identify(personal.id, personal.name || "Connected agent") };
  }
  if (!resource) return null;
  // COALESCE so a renamed connection wins over the name the client registered itself
  // under — every Claude Code install self-registers as the same client_name.
  const oauth = await db.prepare("SELECT access.owner_user_id, access.scopes, family.id AS family_id, COALESCE(family.label, client.client_name) AS connection_name FROM oauth_access_tokens access JOIN oauth_token_families family ON family.id = access.family_id JOIN oauth_clients client ON client.id = access.client_id WHERE access.token_hash = ? AND access.resource = ? AND access.revoked_at IS NULL AND family.revoked_at IS NULL AND access.expires_at > ?")
    .bind(tokenHash, resource, new Date().toISOString()).first<{ owner_user_id: string; scopes: string; family_id: string; connection_name: string }>();
  if (!oauth) return null;
  await db.prepare("UPDATE oauth_access_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?").bind(tokenHash).run();
  return { userId: oauth.owner_user_id, email: `${oauth.owner_user_id}@planbraid.agent`, scopes: oauth.scopes.split(/\s+/).filter(Boolean), authentication: "oauth", ...identify(oauth.family_id, oauth.connection_name || "OAuth-connected agent") };
}

export async function recordInteraction(db: PgD1, principal: Principal, input: { projectId: string; sourceId: string; externalId: string; outcome?: string; summary?: string; event?: "started" | "completed"; sequence?: number }) {
  const organizationId = await organizationFor(db, principal);
  const project = await ownedProject(db, organizationId, input.projectId);
  const source = await db.prepare("SELECT * FROM sources WHERE id = ? AND project_id = ? AND organization_id = ?").bind(input.sourceId, input.projectId, organizationId).first<Row>();
  if (!source) throw domainError("NOT_FOUND", "Source not found", 404);
  const existing = await db.prepare("SELECT id, status FROM interactions WHERE source_id = ? AND external_id = ?").bind(input.sourceId, input.externalId).first<{ id: string; status: string }>();
  const interactionId = existing?.id ?? id("int");
  const event = input.event ?? "completed";
  if (event === "started") {
    if (!existing) {
      // Two concurrent begin_interaction calls for the same external_id (a retried
      // tool call, e.g.) can both see no existing row under Postgres's real
      // concurrency; the loser's insert hits UNIQUE(source_id, external_id), not the
      // id primary key, so fall back to the winner's row instead of throwing.
      const inserted = await db.prepare("INSERT INTO interactions (id, organization_id, project_id, source_id, external_id, sequence, status) VALUES (?, ?, ?, ?, ?, ?, 'started') ON CONFLICT (source_id, external_id) DO NOTHING RETURNING id")
        .bind(interactionId, organizationId, input.projectId, input.sourceId, input.externalId, input.sequence ?? null).first<{ id: string }>();
      if (!inserted) {
        const winner = await db.prepare("SELECT id FROM interactions WHERE source_id = ? AND external_id = ?").bind(input.sourceId, input.externalId).first<{ id: string }>();
        return { interactionId: winner!.id, status: "started" };
      }
    }
    return { interactionId, status: "started" };
  }
  const now = new Date().toISOString();
  const currentRevision = number(project, "revision");
  const nextRevision = currentRevision + 1;
  const summary = input.summary?.trim().slice(0, 2000) || `${text(source, "provider")} interaction completed with no todo summary`;
  // F9: a source with two interactions genuinely open at once could not be told apart by a
  // timestamp window — `created_at >= started_at` with no upper bound at all counted every
  // later interaction's events too, so two overlapping turns from one source each saw the
  // other's mutations as their own. Every mutation event is now tagged with the interaction
  // that was open when it was written (see activeInteractionId), so when this interaction
  // really did have a begin_interaction call, reconciliation is an exact match: no window,
  // no ambiguity, no cross-attribution regardless of what else was happening concurrently.
  let reconciliation: string;
  if (existing) {
    const exact = await db.prepare("SELECT COUNT(*) AS count FROM work_events WHERE interaction_id = ?").bind(interactionId).first<{ count: number }>();
    reconciliation = Number(exact?.count ?? 0) > 0 ? "todos_changed" : "no_todo_change";
  } else {
    // No begin_interaction was ever recorded for this turn, so nothing could have been
    // tagged with this id while it happened — there was no 'started' row for
    // activeInteractionId to find. Falls back to the old best-effort window, but now with
    // a genuine upper bound (this call's own timestamp) instead of none at all, so it can
    // no longer reach into events produced by a later, unrelated interaction.
    const windowed = await db.prepare("SELECT COUNT(*) AS count FROM work_events WHERE source_id = ? AND created_at >= now() - interval '1 hour' AND created_at <= ?").bind(input.sourceId, now).first<{ count: number }>();
    reconciliation = Number(windowed?.count ?? 0) > 0 ? "todos_changed" : "no_todo_change";
  }
  const notificationId = id("ntf");
  await commitMutation(db, [
    existing
      ? db.prepare("UPDATE interactions SET status = 'completed', outcome = ?, summary = ?, reconciliation = ?, completed_at = ?, updated_at = ? WHERE id = ?").bind(input.outcome ?? "success", summary, reconciliation, now, now, interactionId)
      : db.prepare("INSERT INTO interactions (id, organization_id, project_id, source_id, external_id, sequence, status, outcome, summary, reconciliation, started_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)").bind(interactionId, organizationId, input.projectId, input.sourceId, input.externalId, input.sequence ?? null, input.outcome ?? "success", summary, reconciliation, now, now, now),
    db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(nextRevision, now, input.projectId, currentRevision),
    db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, source_id, interaction_id, actor_name, event_type, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'interaction.completed', ?, ?, ?)").bind(id("evt"), organizationId, input.projectId, nextRevision, input.sourceId, interactionId, actorNameFor(text(source, "provider"), nullable(source, "agent_account_label")), summary, JSON.stringify({ reconciliation, outcome: input.outcome ?? "success" }), now),
    db.prepare("INSERT INTO notifications (id, organization_id, recipient_user_id, project_id, source_id, interaction_id, event_type, priority, title, body, deep_link, dedupe_key, requires_action, created_at) VALUES (?, ?, ?, ?, ?, ?, 'interaction.completed', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING").bind(notificationId, organizationId, principal.userId, input.projectId, input.sourceId, interactionId, input.outcome === "failed" || input.outcome === "blocked" ? "high" : "normal", `${text(source, "provider")} interaction ${input.outcome ?? "completed"}`, summary, `/?project=${input.projectId}&source=${input.sourceId}`, `interaction:${interactionId}`, input.outcome === "blocked" ? 1 : 0, now),
  ]);
  return { interactionId, notificationId, reconciliation, projectRevision: nextRevision };
}

/** Is there an open "report everything you know" request waiting for this source? */
async function pendingImportForSource(db: PgD1, projectId: string, sourceId: string) {
  const row = await db.prepare("SELECT id, created_at FROM import_requests WHERE project_id = ? AND source_id = ? AND status = 'pending'").bind(projectId, sourceId).first<{ id: string; created_at: string }>();
  return row ? { id: row.id, requestedAt: row.created_at } : null;
}

/**
 * Asks one connected agent to report everything it knows about a project. Planbraid
 * cannot reach into a live agent conversation (MCP here is request/response with no
 * server-to-client channel), so this is deliberately a durable request rather than an
 * action: it is picked up the next time that exact source calls registerSourceSession
 * (see pendingImportRequest below) or resolved directly by a create_work_items batch
 * that names it (see createWorkItemsDeduplicated's importRequestId handling) —
 * whichever happens first. The partial unique index on (project_id, source_id) WHERE
 * status = 'pending' is what makes re-clicking the same agent idempotent instead of
 * piling up duplicate requests.
 */
export async function requestImport(db: PgD1, principal: Principal, input: { projectId: string; sourceId: string }) {
  const organizationId = await organizationFor(db, principal);
  await ownedProject(db, organizationId, input.projectId);
  const source = await db.prepare("SELECT id FROM sources WHERE id = ? AND project_id = ? AND organization_id = ?").bind(input.sourceId, input.projectId, organizationId).first<{ id: string }>();
  if (!source) throw domainError("NOT_FOUND", "Source not found", 404);
  const existing = await pendingImportForSource(db, input.projectId, input.sourceId);
  if (existing) return { importRequestId: existing.id, status: "already_pending" as const };
  const importRequestId = id("imp");
  try {
    await db.prepare("INSERT INTO import_requests (id, organization_id, project_id, source_id, requested_by) VALUES (?, ?, ?, ?, ?)")
      .bind(importRequestId, organizationId, input.projectId, input.sourceId, principal.userId).run();
    return { importRequestId, status: "created" as const };
  } catch (error) {
    // A second click landed in the narrow window between the check above and this
    // insert; the partial unique index caught it, so reuse the request that won
    // rather than surface a race the user did nothing wrong to trigger.
    const code = (error as { code?: string }).code;
    if (code !== "23505") throw error;
    const winner = await pendingImportForSource(db, input.projectId, input.sourceId);
    if (winner) return { importRequestId: winner.id, status: "already_pending" as const };
    throw error;
  }
}

export async function registerSourceSession(db: PgD1, principal: Principal, input: { projectId: string; provider: string; externalId: string; title?: string; model?: string; codingSpaceId?: string; assurance?: string; accountLabel?: string }) {
  const organizationId = await organizationFor(db, principal);
  await ownedProject(db, organizationId, input.projectId);
  const provider = input.provider.trim().slice(0, 80);
  const requestedExternalId = input.externalId.trim().slice(0, 240);
  if (!provider || !requestedExternalId) throw domainError("VALIDATION_FAILED", "Provider and external session ID are required");
  // Precedence: the credential (and any ?agent= marker) the request authenticated with
  // outranks anything the model declares, since only the former is something the owner
  // configured. An agent-declared label is the last resort, for connections that carry
  // no distinguishing credential at all.
  const accountId = principal.agentAccountId ?? null;
  const accountLabel = principal.agentAccountLabel ?? normalizeAccountLabel(input.accountLabel);
  let externalId = requestedExternalId;
  const existing = await db.prepare("SELECT id, agent_account_id FROM sources WHERE project_id = ? AND provider = ? AND external_id = ?").bind(input.projectId, provider, externalId).first<{ id: string; agent_account_id: string | null }>();
  if (existing) {
    // Same conversation id, different agent login. sources' UNIQUE key predates agent
    // accounts and cannot separate them, so rather than let one account silently adopt
    // another's session, fork onto a deterministic id derived from the account. Only
    // reachable when a client reuses a fixed session id across accounts; per-conversation
    // UUIDs never collide here.
    if (accountId && existing.agent_account_id && existing.agent_account_id !== accountId) {
      externalId = `${requestedExternalId}::${accountId}`.slice(0, 240);
    } else {
      await db.prepare("UPDATE sources SET status = 'active', last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, title = COALESCE(?, title), model = COALESCE(?, model), agent_account_id = COALESCE(?, agent_account_id), agent_account_label = COALESCE(?, agent_account_label) WHERE id = ?").bind(input.title ?? null, input.model ?? null, accountId, accountLabel, existing.id).run();
      return { sourceId: existing.id, idempotentReplay: true, pendingImportRequest: await pendingImportForSource(db, input.projectId, existing.id) };
    }
  }
  const forked = await db.prepare("SELECT id FROM sources WHERE project_id = ? AND provider = ? AND external_id = ?").bind(input.projectId, provider, externalId).first<{ id: string }>();
  if (forked) {
    await db.prepare("UPDATE sources SET status = 'active', last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, title = COALESCE(?, title), model = COALESCE(?, model), agent_account_label = COALESCE(?, agent_account_label) WHERE id = ?").bind(input.title ?? null, input.model ?? null, accountLabel, forked.id).run();
    return { sourceId: forked.id, idempotentReplay: true, pendingImportRequest: await pendingImportForSource(db, input.projectId, forked.id) };
  }
  const sourceId = id("src");
  // Two concurrent register_agent_session calls for the same (project, provider,
  // external_id) can both reach here believing no source exists yet (Postgres runs
  // them in true parallel, unlike D1 which serialized every query). The losing insert
  // hits sources' UNIQUE(project_id, provider, external_id), not the id primary key, so
  // re-select on conflict rather than assume this insert is the row that landed.
  const inserted = await db.prepare("INSERT INTO sources (id, organization_id, project_id, coding_space_id, provider, external_id, title, model, status, assurance, agent_account_id, agent_account_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?) ON CONFLICT (project_id, provider, external_id) DO NOTHING RETURNING id")
    .bind(sourceId, organizationId, input.projectId, input.codingSpaceId ?? null, provider, externalId, input.title?.slice(0, 240) || `${provider} session`, input.model?.slice(0, 120) ?? null, input.assurance ?? "instructed", accountId, accountLabel).first<{ id: string }>();
  if (inserted) return { sourceId: inserted.id, idempotentReplay: false, pendingImportRequest: await pendingImportForSource(db, input.projectId, inserted.id) };
  const winner = await db.prepare("SELECT id FROM sources WHERE project_id = ? AND provider = ? AND external_id = ?").bind(input.projectId, provider, externalId).first<{ id: string }>();
  return { sourceId: winner!.id, idempotentReplay: true, pendingImportRequest: await pendingImportForSource(db, input.projectId, winner!.id) };
}

/**
 * Creates proposed work, collapsing anything that restates work the project already
 * has. Nothing is ever discarded: a collapsed proposal is stored as an alias carrying
 * its original wording and the agent that authored it, so provenance survives and a
 * wrong match stays reversible.
 */
/**
 * Closes out an import_requests row from inside the same create_work_items batch that
 * reports the content it asked for, instead of a separate "resolve" tool an agent could
 * forget to call. A stale or mismatched id (an old prompt pasted twice, a request
 * someone else already resolved) is silently a no-op rather than an error: the work
 * items this batch created are real either way, so a bookkeeping row that no longer
 * applies must never fail the whole call.
 */
async function completeImportRequest(db: PgD1, organizationId: string, projectId: string, sourceId: string, importRequestId: string, reportedCount: number, actor: string) {
  const request = await db.prepare("SELECT id FROM import_requests WHERE id = ? AND project_id = ? AND source_id = ? AND status = 'pending'").bind(importRequestId, projectId, sourceId).first<{ id: string }>();
  if (!request) return;
  const project = await db.prepare("SELECT revision FROM projects WHERE id = ?").bind(projectId).first<{ revision: number }>();
  if (!project) return;
  const nextRevision = project.revision + 1;
  const now = new Date().toISOString();
  try {
    await db.batch([
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(nextRevision, now, projectId, project.revision),
      db.prepare("UPDATE import_requests SET status = 'completed', reported_count = ?, completed_at = ? WHERE id = ?").bind(reportedCount, now, importRequestId),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, source_id, actor_name, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, 'import.completed', ?, ?)")
        .bind(id("evt"), organizationId, projectId, nextRevision, sourceId, actor, `${actor} imported ${reportedCount} task${reportedCount === 1 ? "" : "s"}`, now),
    ]);
  } catch {
    // Lost a revision race to another concurrent write. The import itself already
    // succeeded via the caller's create_work_items batch; only this activity-log
    // entry is skipped, which is an acceptable silent degrade.
  }
}

export async function createWorkItemsDeduplicated(
  db: PgD1,
  principal: Principal,
  input: { projectId: string; proposals: Proposal[]; sourceId?: string; importRequestId?: string; idempotencyKey: string },
) {
  const organizationId = await organizationFor(db, principal);
  await ownedProject(db, organizationId, input.projectId);
  // Items written before the artifact index existed carry no index rows, so they would be
  // reachable only through retrieval's recency arm — exactly the gap this replaces. Bounded
  // per call; a large project converges over a few writes and degrades to the old behaviour
  // meanwhile rather than to a wrong one.
  await backfillBlockingIndex(db, organizationId, input.projectId);
  const existingItems = await retrieveCandidates(db, organizationId, input.projectId, input.proposals);
  const outcomes = await resolveProposals({ proposals: input.proposals, existingItems });

  const results: Record<string, unknown>[] = [];
  const annotations: PgD1PreparedStatement[] = [];
  const createdByIndex = new Map<number, { itemId: string; itemKey: string }>();
  // Every outcome's final target (its own new item, or the canonical item it matched
  // into), keyed by batch index. Built for the depends_on resolution pass below, which
  // needs to know what every ref in this batch ultimately resolved to.
  const targetByIndex = new Map<number, { itemId: string; itemKey: string }>();
  let created = 0;
  let matched = 0;

  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.create) {
      const record = await executeCommand(db, principal, {
        action: "create_item", projectId: input.projectId, title: outcome.title, description: outcome.description,
        status: outcome.status as WorkStatus | undefined, priority: outcome.priority as WorkItem["priority"] | undefined,
        // Left to create_item's own default, which is the point of the ladder: an agent
        // batch arrives as proposals, a person's own entry arrives accepted.
        sourceId: input.sourceId, contentFingerprint: outcome.fingerprintValue, idempotencyKey: `${input.idempotencyKey}:${index}`,
      }) as unknown as { itemId: string; itemKey: string; maturity: Maturity };
      createdByIndex.set(index, record);
      targetByIndex.set(index, record);
      created += 1;

      const entry: Record<string, unknown> = { ref: outcome.ref, status: "created", workItemId: record.itemId, itemKey: record.itemKey, maturity: record.maturity };
      // Said out loud rather than left to be inferred from a field: an agent that believes
      // it just created accepted work will report it that way to the user.
      if (record.maturity === "proposal") entry.note = "Recorded as a proposal awaiting acceptance. Ask the user to accept it, then call accept_work_items naming who decided.";
      // Resembles existing work but not conclusively. The item is created either way;
      // the resemblance is a note, not a decision the agent has to make.
      if (outcome.match) entry.resembles = { itemKey: outcome.match.itemKey, workItemId: outcome.match.workItemId, note: outcome.match.explanation };

      // E4 — Stage 3/4: a typed relation becomes a real edge here, including CONFLICT
      // (the direct new-item↔existing-item `conflicts_with` fact). The route handler
      // additionally raises a *decision* for CONFLICT once this returns
      // (`lib/planning/decisions.ts`'s `recordDecision` sits above this module and
      // itself calls back into `executeCommand`, so calling it from here would be a
      // circular import) — that decision gets its own two `conflicts_with` edges from
      // the decision to each option, a separate M19 fact from this direct item-to-item
      // one. This module reports the relation either way, so the caller always has what
      // it needs to act on it.
      if (outcome.relation) {
        const edgeType = edgeTypeForRelation(outcome.relation.type);
        if (edgeType) {
          await executeCommand(db, principal, {
            action: "add_dependency", projectId: input.projectId, fromWorkItemId: record.itemId, toWorkItemId: outcome.match!.workItemId,
            type: edgeType, reason: outcome.relation.reason, sourceId: input.sourceId, idempotencyKey: `${input.idempotencyKey}:relation:${index}`,
          });
        }
        entry.relation = {
          type: outcome.relation.type, reason: outcome.relation.reason,
          workItemId: outcome.match!.workItemId, itemKey: outcome.match!.itemKey,
        };
      }
      results.push(entry);
      continue;
    }

    // Collapsed. Resolve against an item created earlier in this same batch when the
    // agent repeated itself inside one call.
    const inBatch = outcome.batchIndex === undefined ? null : createdByIndex.get(outcome.batchIndex);
    const target = inBatch ?? { itemId: outcome.match!.workItemId, itemKey: outcome.match!.itemKey };
    targetByIndex.set(index, target);
    matched += 1;

    annotations.push(aliasStatement(db, {
      organizationId, projectId: input.projectId, workItemId: target.itemId,
      title: outcome.title, description: outcome.description, sourceId: input.sourceId,
      score: outcome.match!.score, method: outcome.match!.method, reason: outcome.match!.explanation,
    }));

    const entry: Record<string, unknown> = {
      ref: outcome.ref, status: "matched", workItemId: target.itemId, itemKey: target.itemKey,
      matchScore: outcome.match!.score, matchMethod: outcome.match!.method, explanation: outcome.match!.explanation,
    };
    // A proposal restating already-completed work is the most valuable thing this
    // path can report: it prevents redundant work, not merely a redundant card.
    if (["done", "cancelled"].includes(outcome.match!.status)) entry.warning = outcome.match!.explanation;
    if (outcome.delta.length) entry.deltaCaptured = outcome.delta;
    results.push(entry);

    if (outcome.delta.length) {
      await executeCommand(db, principal, {
        action: "add_note", projectId: input.projectId, itemId: target.itemId, sourceId: input.sourceId,
        summary: `Also proposed here with additional scope: ${outcome.delta.join(" ")}`.slice(0, 2000),
        idempotencyKey: `${input.idempotencyKey}:delta:${index}`,
      });
    }
  }

  if (annotations.length) await db.batch(annotations);

  // Resolve depends_on refs against final targets, after dedup has run. A ref must
  // resolve to the canonical item a matched proposal collapsed into, not a dead ref to
  // an ID that was never created. This pass runs after every outcome has a target so
  // that ordering never matters. Unlike a bad blocker ID in block_work (one deliberate
  // action, fails loudly), a bad depends_on entry here degrades to a warning: losing an
  // otherwise-valid batch of items over one mistyped edge reference would be the
  // expensive error, and the missing edge is easy to see and add later.
  if (outcomes.some((outcome) => outcome.dependsOn?.length)) {
    const refIndex = new Map<string, { itemId: string; itemKey: string }>();
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.ref) { const resolved = targetByIndex.get(index); if (resolved) refIndex.set(outcome.ref, resolved); }
    }
    // A literal depends_on value that isn't a batch ref is an existing item's id, and its
    // display key has to be looked up directly rather than read off `existingItems` — that
    // array is E1's blocking candidate set now (RECONCILIATION_ARCHITECTURE.md §5), scoped
    // to what plausibly duplicates one of *these* proposals, not "every item this batch
    // might reference by id". A prerequisite named by id is routinely unrelated in wording
    // to the item that depends on it (a database-provisioning task and the migration that
    // needs it share no vocabulary at all), so it would almost never appear there.
    const literalRefs = [...new Set(outcomes.flatMap((outcome) => (outcome.dependsOn ?? []).filter((ref) => !refIndex.has(ref))))];
    const existingKeyById = await itemKeysFor(db, organizationId, literalRefs);

    for (const [index, outcome] of outcomes.entries()) {
      if (!outcome.dependsOn?.length) continue;
      const target = targetByIndex.get(index);
      if (!target) continue;
      const linked: string[] = [];
      const warnings: string[] = [];
      for (const [depIndex, rawRef] of outcome.dependsOn.entries()) {
        const prerequisite = refIndex.get(rawRef) ?? { itemId: rawRef, itemKey: existingKeyById.get(rawRef) ?? rawRef };
        if (prerequisite.itemId === target.itemId) { warnings.push(`Skipped: ${target.itemKey} cannot depend on itself.`); continue; }
        try {
          await executeCommand(db, principal, {
            action: "add_dependency", projectId: input.projectId, fromWorkItemId: prerequisite.itemId, toWorkItemId: target.itemId,
            type: "blocks", sourceId: input.sourceId, idempotencyKey: `${input.idempotencyKey}:dep:${index}:${depIndex}`,
          });
          linked.push(prerequisite.itemKey);
        } catch (error) {
          const typed = error as Error & { code?: string };
          const why = typed.code === "NOT_FOUND" ? "that task was not found" : typed.code === "BLOCKING_CYCLE" ? "it would create a dependency cycle" : "the link could not be recorded";
          warnings.push(`Could not link "${rawRef}" as a prerequisite of ${target.itemKey}: ${why}.`);
        }
      }
      if (linked.length) results[index].linkedDependencies = linked;
      if (warnings.length) results[index].dependencyWarnings = warnings;
    }
  }

  if (input.importRequestId && input.sourceId) {
    const actor = await sourceActor(db, organizationId, input.sourceId);
    await completeImportRequest(db, organizationId, input.projectId, input.sourceId, input.importRequestId, created + matched, actor);
  }

  return { results, summary: { created, matched } };
}

const PRIORITY_RANK: Record<WorkItem["priority"], number> = { urgent: 4, high: 3, normal: 2, low: 1, none: 0 };

/**
 * Work that is actually actionable right now, ranked so an agent can ask "what next"
 * and get a graph-aware answer instead of a flat list. This is the payoff of the whole
 * dependency-graph effort: `list_work_items` returns everything; this returns what's
 * genuinely safe and useful to start.
 *
 * Two exclusions any todo tool could do (blocked, and, via avoidCollisions, already
 * claimed by another live session) plus a ranking no single-agent tool can, because
 * only this system tracks which agent sessions are live and what they currently hold:
 * unlock count first (how many other items this one is the last blocker for), so
 * finishing the highest-ranked item does the most to free up the rest of the graph.
 */
export async function getReadyWork(
  db: PgD1,
  principal: Principal,
  input: { projectId: string; sourceId?: string; limit?: number; avoidCollisions?: boolean },
) {
  const organizationId = await organizationFor(db, principal);
  const project = await ownedProject(db, organizationId, input.projectId);
  const avoidCollisions = input.avoidCollisions !== false;
  const limit = Math.min(Math.max(Number(input.limit ?? 5), 1), 50);
  // With gating on, work no person has accepted is not handed to an agent to start. Off by
  // default so turning the ladder on does not silently empty a working queue.
  const gateProposals = parseJson<{ gateProposals?: boolean }>(text(project, "settings"), {}).gateProposals === true;
  const maturityClause = gateProposals ? " AND maturity IN ('accepted', 'committed')" : "";

  const [itemRows, sourceRows, aliasRows, claimRows] = await db.batch([
    // `deferred_until` is compared in SQL rather than filtered afterwards so a deferral
    // simply expires: the item comes back on its date with no job to run and no write.
    db.prepare(`SELECT * FROM work_items WHERE project_id = ? AND organization_id = ? AND archived_at IS NULL AND status = 'ready' AND blocking_count = 0 AND (deferred_until IS NULL OR deferred_until <= now())${maturityClause}`).bind(input.projectId, organizationId),
    db.prepare("SELECT * FROM sources WHERE project_id = ? AND organization_id = ?").bind(input.projectId, organizationId),
    db.prepare("SELECT * FROM work_item_aliases WHERE project_id = ? AND organization_id = ?").bind(input.projectId, organizationId),
    // Live leases (finding F1): unlike sources.current_task_ids, a lease expires on its
    // own, so a crashed session's claim stops blocking anything without a scheduler or a
    // person having to notice and clear it. Skipped entirely when collisions aren't wanted.
    avoidCollisions
      ? db.prepare("SELECT DISTINCT wc.work_item_id AS id FROM work_claims wc JOIN work_items wi ON wi.id = wc.work_item_id WHERE wi.project_id = ? AND wi.organization_id = ? AND wc.lease_expires_at > now() AND wc.source_id <> ?").bind(input.projectId, organizationId, input.sourceId ?? "")
      : db.prepare("SELECT NULL AS id WHERE false"),
  ]);
  const candidates = itemRows.results.map(mapItem);
  // The SQL predicate above is the same rule deriveColumn applies for a "ready" item, so
  // this list can never diverge from what the board shows in the Ready column.
  const sources = sourceRows.results.map(mapSource);
  const aliases = aliasRows.results.map(mapAlias);
  const claimed = new Set((claimRows.results as Array<{ id: string }>).map((row) => row.id));

  const actionable = candidates.filter((item) => !claimed.has(item.id));
  const excludedByCollision = candidates.length - actionable.length;
  // One grouped query for every candidate's unlock count, rather than one `downstreamOf`
  // per candidate inside the loop (finding F5). `blocking_count = 1` is the same
  // "would reach zero" predicate the per-item version filtered on.
  const unlockCounts = await unlockCountsFor(db, organizationId, input.projectId, actionable.map((item) => item.id));

  const ranked = [];
  for (const item of actionable) {
    const unlockCount = unlockCounts.get(item.id) ?? 0;
    // Keyed by model family, not by the raw provider string or the agent account: two
    // accounts of one model reason near-identically, so counting them as two would
    // outrank a task Claude and Codex genuinely arrived at separately. The UI still
    // shows every distinct account — provenance and evidence strength are different
    // questions, and conflating them is what made this number dishonest before.
    const providers = new Set<string>();
    const ownSource = sources.find((source) => source.id === item.sourceId);
    if (ownSource) providers.add(providerFamily(ownSource.provider));
    for (const alias of aliases) {
      if (alias.workItemId !== item.id) continue;
      const aliasSource = sources.find((source) => source.id === alias.sourceId);
      if (aliasSource) providers.add(providerFamily(aliasSource.provider));
    }
    ranked.push({ item, unlockCount, corroboration: providers.size, priorityRank: PRIORITY_RANK[item.priority] });
  }

  ranked.sort((a, b) => b.unlockCount - a.unlockCount || b.priorityRank - a.priorityRank || b.corroboration - a.corroboration || a.item.sequence - b.item.sequence);

  return {
    workItems: ranked.slice(0, limit).map(({ item, unlockCount, corroboration }) => ({
      ...item,
      unlockCount,
      corroboration,
      reason: unlockCount > 0 ? `Finishing this frees ${unlockCount} other task${unlockCount === 1 ? "" : "s"}.` : "Unblocked and ready.",
    })),
    excludedByCollision,
  };
}

/** How long a claim survives without a fresh heartbeat. A crashed or forgotten session's
 * hold on a task expires on its own after this, with no scheduler needed — readers simply
 * filter on `lease_expires_at > now()`. Long enough for a real task, short enough that an
 * abandoned session stops mattering before anyone notices. See finding F1. */
const CLAIM_LEASE_MS = 45 * 60 * 1000;

/**
 * Keeps `work_claims` in sync with a heartbeat's reported task IDs — the write side of
 * finding F1. The table existed with the right columns from the start; the only thing
 * missing was anything that wrote to it, so `getReadyWork`'s collision check fell back to
 * `sources.current_task_ids`, which has no expiry at all.
 *
 * A crashed agent's claim now heals itself: its lease simply stops being renewed and
 * expires, instead of blocking the item forever until a person notices and manually clears
 * it (which nothing in the product today lets them do).
 */
async function syncClaims(db: PgD1, sourceId: string, taskIds: string[], ended: boolean) {
  if (ended) {
    await db.prepare("DELETE FROM work_claims WHERE source_id = ?").bind(sourceId).run();
    return;
  }
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
  const statements: PgD1PreparedStatement[] = [
    // Anything this source held before and is not reporting any more is released
    // immediately, not left to expire — a task an agent has visibly moved off of should
    // stop showing as claimed right away.
    taskIds.length
      ? db.prepare("DELETE FROM work_claims WHERE source_id = ? AND NOT (work_item_id = ANY(?::text[]))").bind(sourceId, taskIds)
      : db.prepare("DELETE FROM work_claims WHERE source_id = ?").bind(sourceId),
  ];
  for (const taskId of taskIds) {
    statements.push(
      db.prepare(
        "INSERT INTO work_claims (id, work_item_id, source_id, mode, lease_expires_at, heartbeat_at) VALUES (?, ?, ?, 'exclusive', ?, ?) " +
        "ON CONFLICT (work_item_id, source_id) DO UPDATE SET lease_expires_at = excluded.lease_expires_at, heartbeat_at = excluded.heartbeat_at, version = work_claims.version + 1",
      ).bind(id("clm"), taskId, sourceId, expiresAt, now),
    );
  }
  await db.batch(statements);
}

export async function updateSourceHeartbeat(db: PgD1, principal: Principal, input: { sourceId: string; state?: string; currentTaskIds?: string[]; end?: boolean }) {
  const organizationId = await organizationFor(db, principal);
  const taskIds = (input.currentTaskIds ?? []).slice(0, 100);
  const result = await db.prepare("UPDATE sources SET status = ?, current_task_ids = ?, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? RETURNING id").bind(input.end ? "ended" : input.state ?? "active", JSON.stringify(taskIds), input.sourceId, organizationId).first();
  if (!result) throw domainError("NOT_FOUND", "Source session not found", 404);
  // input.currentTaskIds is undefined (as opposed to []) when a heartbeat only updates
  // presence and says nothing about current work; claims are left untouched in that case
  // rather than being wiped by an update that never meant to report on them.
  if (input.end || input.currentTaskIds !== undefined) await syncClaims(db, input.sourceId, taskIds, Boolean(input.end));
  return { sourceId: input.sourceId, status: input.end ? "ended" : input.state ?? "active" };
}

/**
 * M14's other half of `start_work`, alongside collision.ts's artifact check: an exclusive
 * lease taken and enforced at the moment work actually starts, not only whenever a
 * heartbeat happens to follow. Before this, `start_work` moved an item to `in_progress`
 * with no lease check at all — two sessions could both "start" the same item, and neither
 * would know about the other until a heartbeat eventually raced to write `work_claims`.
 * `force: true` is the intentional override (a person reassigning stuck work), and is
 * recorded in the transition's own reason rather than silently overwriting the claim.
 */
export async function startWork(db: PgD1, principal: Principal, input: { projectId: string; itemId: string; expectedVersion: number; reason?: string; sourceId?: string; force?: boolean; idempotencyKey: string }) {
  const organizationId = await organizationFor(db, principal);
  let takeoverNote = "";
  if (input.sourceId) {
    const holder = await db.prepare(
      "SELECT wc.source_id, wc.lease_expires_at, s.provider, s.agent_account_label FROM work_claims wc " +
      "JOIN sources s ON s.id = wc.source_id AND s.organization_id = ? WHERE wc.work_item_id = ? AND wc.lease_expires_at > now() AND wc.source_id <> ?",
    ).bind(organizationId, input.itemId, input.sourceId).first<{ source_id: string; lease_expires_at: string; provider: string; agent_account_label: string | null }>();
    if (holder) {
      const holderLabel = holder.agent_account_label ? `${holder.provider} · ${holder.agent_account_label}` : holder.provider;
      if (!input.force) {
        throw domainError("WORK_LEASED", `Already claimed by ${holderLabel}, lease expires ${holder.lease_expires_at}`, 409, {
          holderSourceId: holder.source_id, provider: holder.provider, accountLabel: holder.agent_account_label, leaseExpiresAt: holder.lease_expires_at,
        });
      }
      takeoverNote = ` (forced takeover from ${holderLabel})`;
    }
  }

  const response = await executeCommand(db, principal, {
    action: "transition_item", projectId: input.projectId, itemId: input.itemId, expectedVersion: input.expectedVersion, status: "in_progress",
    reason: `${input.reason ?? "Started"}${takeoverNote}`, sourceId: input.sourceId, idempotencyKey: input.idempotencyKey,
  });

  if (input.sourceId) {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
    // work_claims' conflict target is (work_item_id, source_id), not work_item_id alone —
    // inserting this session's row would sit *alongside* another source's still-present
    // claim rather than replace it, since the two never collide on that composite key.
    // Exclusive mode means exactly one holder, so any other row on this item is cleared
    // first: an expired one is stale bookkeeping nothing was reading anyway, and a live
    // one only survives to this point at all because `force` was just used to override it.
    await db.prepare("DELETE FROM work_claims WHERE work_item_id = ? AND source_id <> ?").bind(input.itemId, input.sourceId).run();
    await db.prepare(
      "INSERT INTO work_claims (id, work_item_id, source_id, mode, lease_expires_at, heartbeat_at) VALUES (?, ?, ?, 'exclusive', ?, ?) " +
      "ON CONFLICT (work_item_id, source_id) DO UPDATE SET lease_expires_at = excluded.lease_expires_at, heartbeat_at = excluded.heartbeat_at, version = work_claims.version + 1",
    ).bind(id("clm"), input.itemId, input.sourceId, expiresAt, now).run();
  }
  return response;
}
