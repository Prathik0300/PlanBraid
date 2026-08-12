import { ensureSchema } from "@/db/setup";
import type { PgD1, PgD1PreparedStatement } from "@/db/pg-d1";
import type { Command, DashboardState, Notification, Project, Source, WorkEvent, WorkItem, WorkStatus } from "@/lib/contracts";
import type { Proposal } from "@/lib/dedup/match.ts";
import { aliasStatement, resolveProposals } from "@/lib/dedup/resolve.ts";
import { DAG_EDGE_TYPES, DAG_EDGE_TYPE_SQL_LIST, isDagEdgeType } from "@/lib/graph/edges.ts";

export type Principal = { userId: string; email: string; displayName: string; scopes?: string[]; authentication?: "browser" | "personal_token" | "oauth" | "local" };

type Row = Record<string, unknown>;

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

export function isLocalRequest(request: Request) {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function principalFromHeaders(headers: Headers, allowLocalDemo = false): Principal {
  const authenticatedUserId = headers.get("oai-authenticated-user-id");
  if (!authenticatedUserId && !allowLocalDemo) {
    throw Object.assign(new Error("Authentication required"), { code: "AUTHENTICATION_REQUIRED", status: 401 });
  }
  const userId = authenticatedUserId ?? "local-demo-user";
  const email = headers.get("oai-authenticated-user-email") ?? "you@planbraid.local";
  const encodedName = headers.get("oai-authenticated-user-full-name");
  let displayName = email.split("@")[0] || "You";
  if (encodedName && headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") {
    try { displayName = decodeURIComponent(encodedName); } catch { /* display fallback */ }
  }
  return { userId, email, displayName };
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function digest(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function text(row: Row, key: string) { return String(row[key] ?? ""); }
function nullable(row: Row, key: string) { return row[key] == null ? null : String(row[key]); }
function number(row: Row, key: string) { return Number(row[key] ?? 0); }

export async function organizationFor(db: PgD1, principal: Principal) {
  await ensureSchema(db);
  const existing = await db.prepare("SELECT id FROM organizations WHERE owner_user_id = ?").bind(principal.userId).first<{ id: string }>();
  const suffix = (await digest(principal.userId)).slice(0, 10);
  const organizationId = `org_${suffix}`;

  if (existing) {
    await removeLegacyDemoData(db, existing.id, suffix);
    await removeGeneratedProjectShorthands(db, existing.id);
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
  ]);
  return organizationId;
}

const LEGACY_DEMO_MIGRATION = "2026-08-10-remove-built-in-demo-data";
const PROJECT_SHORTHAND_MIGRATION = "2026-08-10-remove-generated-project-shorthands";

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

function mapProject(row: Row): Project {
  return { id: text(row, "id"), name: text(row, "name"), description: text(row, "description"), directory: text(row, "directory"), gitRemote: nullable(row, "git_remote"), defaultBranch: text(row, "default_branch"), revision: number(row, "revision"), status: text(row, "status"), updatedAt: text(row, "updated_at") };
}
function mapSource(row: Row): Source {
  return { id: text(row, "id"), projectId: text(row, "project_id"), codingSpaceId: nullable(row, "coding_space_id"), provider: text(row, "provider") as Source["provider"], externalId: text(row, "external_id"), title: text(row, "title"), model: nullable(row, "model"), status: text(row, "status"), assurance: text(row, "assurance") as Source["assurance"], currentTaskIds: parseJson(text(row, "current_task_ids"), []), lastSeenAt: text(row, "last_seen_at") };
}
function mapItem(row: Row): WorkItem {
  return { id: text(row, "id"), projectId: text(row, "project_id"), sequence: number(row, "sequence"), itemKey: text(row, "item_key"), parentId: nullable(row, "parent_id"), type: text(row, "type"), title: text(row, "title"), description: text(row, "description"), status: text(row, "status") as WorkStatus, priority: text(row, "priority") as WorkItem["priority"], assignee: nullable(row, "assignee"), sourceId: nullable(row, "source_id"), codingSpaceId: nullable(row, "coding_space_id"), completionConfidence: text(row, "completion_confidence"), verificationStatus: text(row, "verification_status"), blockerReason: nullable(row, "blocker_reason"), blockingCount: number(row, "blocking_count"), unblockedAt: nullable(row, "unblocked_at"), version: number(row, "version"), startedAt: nullable(row, "started_at"), completedAt: nullable(row, "completed_at"), createdAt: text(row, "created_at"), updatedAt: text(row, "updated_at") };
}
function mapEvent(row: Row): WorkEvent {
  return { id: text(row, "id"), projectId: text(row, "project_id"), projectRevision: number(row, "project_revision"), workItemId: nullable(row, "work_item_id"), sourceId: nullable(row, "source_id"), interactionId: nullable(row, "interaction_id"), actorName: text(row, "actor_name"), eventType: text(row, "event_type"), summary: text(row, "summary"), fromStatus: nullable(row, "from_status") as WorkStatus | null, toStatus: nullable(row, "to_status") as WorkStatus | null, metadata: parseJson(text(row, "metadata"), {}), createdAt: text(row, "created_at") };
}
function mapNotification(row: Row): Notification {
  return { id: text(row, "id"), projectId: text(row, "project_id"), workItemId: nullable(row, "work_item_id"), sourceId: nullable(row, "source_id"), interactionId: nullable(row, "interaction_id"), eventType: text(row, "event_type"), priority: text(row, "priority"), title: text(row, "title"), body: text(row, "body"), deepLink: text(row, "deep_link"), requiresAction: Boolean(row.requires_action), readAt: nullable(row, "read_at"), resolvedAt: nullable(row, "resolved_at"), createdAt: text(row, "created_at") };
}
function mapAlias(row: Row) {
  return { id: text(row, "id"), workItemId: text(row, "work_item_id"), title: text(row, "title"), description: text(row, "description"), sourceId: nullable(row, "source_id"), matchMethod: text(row, "match_method"), matchReason: text(row, "match_reason"), createdAt: text(row, "created_at") };
}

export async function loadDashboard(db: PgD1, principal: Principal): Promise<DashboardState> {
  const organizationId = await organizationFor(db, principal);
  const [projects, spaces, sources, items, events, notifications, dependencies, evidenceRows, aliasRows] = await db.batch([
    db.prepare("SELECT * FROM projects WHERE organization_id = ? ORDER BY updated_at DESC").bind(organizationId),
    db.prepare("SELECT * FROM coding_spaces WHERE organization_id = ? ORDER BY last_seen_at DESC").bind(organizationId),
    db.prepare("SELECT * FROM sources WHERE organization_id = ? ORDER BY last_seen_at DESC").bind(organizationId),
    db.prepare("SELECT * FROM work_items WHERE organization_id = ? AND archived_at IS NULL ORDER BY updated_at DESC").bind(organizationId),
    db.prepare("SELECT * FROM work_events WHERE organization_id = ? ORDER BY created_at DESC, project_revision DESC LIMIT 250").bind(organizationId),
    db.prepare("SELECT * FROM notifications WHERE organization_id = ? AND recipient_user_id = ? ORDER BY created_at DESC LIMIT 100").bind(organizationId, principal.userId),
    db.prepare("SELECT * FROM dependencies WHERE organization_id = ?").bind(organizationId),
    db.prepare("SELECT * FROM evidence WHERE organization_id = ? ORDER BY created_at DESC").bind(organizationId),
    db.prepare("SELECT * FROM work_item_aliases WHERE organization_id = ? ORDER BY created_at DESC LIMIT 500").bind(organizationId),
  ]);
  return {
    viewer: { id: principal.userId, name: principal.displayName, email: principal.email },
    projects: (projects.results as Row[]).map(mapProject),
    codingSpaces: (spaces.results as Row[]).map((row) => ({ id: text(row, "id"), projectId: text(row, "project_id"), label: text(row, "label"), safePath: text(row, "safe_path"), branch: text(row, "branch"), kind: text(row, "kind"), status: text(row, "status"), lastSeenAt: text(row, "last_seen_at") })),
    sources: (sources.results as Row[]).map(mapSource),
    workItems: (items.results as Row[]).map(mapItem),
    events: (events.results as Row[]).map(mapEvent),
    notifications: (notifications.results as Row[]).map(mapNotification),
    dependencies: (dependencies.results as Row[]).map((row) => ({ id: text(row, "id"), fromWorkItemId: text(row, "from_work_item_id"), toWorkItemId: text(row, "to_work_item_id"), type: text(row, "type"), reason: text(row, "reason") })),
    evidence: (evidenceRows.results as Row[]).map((row) => ({ id: text(row, "id"), workItemId: text(row, "work_item_id"), type: text(row, "type"), label: text(row, "label"), uri: nullable(row, "uri"), result: nullable(row, "result"), createdAt: text(row, "created_at") })),
    aliases: (aliasRows.results as Row[]).map(mapAlias),
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
    const update = await db.prepare("UPDATE notifications SET read_at = CASE WHEN ? = 1 THEN ? ELSE NULL END, resolved_at = CASE WHEN ? = 1 THEN ? ELSE resolved_at END WHERE id = ? AND organization_id = ? AND recipient_user_id = ? RETURNING id").bind(command.read === false ? 0 : 1, now, command.resolved ? 1 : 0, now, command.notificationId, organizationId, principal.userId).first();
    if (!update) throw domainError("NOT_FOUND", "Notification not found", 404);
    const response = { notificationId: command.notificationId };
    await db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)).run();
    return response;
  }

  if (command.action === "create_project") {
    const projectId = id("prj");
    const cleanName = command.name.trim().slice(0, 120);
    if (!cleanName) throw domainError("VALIDATION_FAILED", "Project name is required");
    const now = new Date().toISOString();

    // Match before creating, the same contract create_work_items uses for tasks. One
    // repository opened from the web UI and from an agent is one project; without this
    // the two produced parallel projects that each held half the work.
    const existing = await findMatchingProject(db, organizationId, { name: cleanName, directory: command.directory, gitRemote: command.gitRemote });
    if (existing) {
      // Adopt identifying details the existing project is missing, so a project created
      // in the browser (no directory) gains the agent's checkout path on first contact
      // and resolves directly from then on.
      const directory = normalizeDirectory(command.directory);
      const gitRemote = command.gitRemote?.trim().slice(0, 500);
      const adopted = await db.prepare("UPDATE projects SET directory = CASE WHEN directory = '' THEN COALESCE(?, directory) ELSE directory END, git_remote = COALESCE(git_remote, ?), updated_at = ? WHERE id = ? AND organization_id = ? RETURNING directory, git_remote")
        .bind(directory || null, gitRemote || null, now, existing.id, organizationId).first<Row>();
      const matchedResponse = {
        projectId: existing.id, status: "matched" as const, matchedOn: existing.matchedOn,
        project: { id: existing.id, name: existing.name, directory: text(adopted ?? {}, "directory"), gitRemote: nullable(adopted ?? {}, "git_remote") },
        warning: `Matched the existing project "${existing.name}" by ${existing.matchedOn}; use this project instead of creating another for the same work.`,
      };
      await db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(matchedResponse)).run();
      return matchedResponse;
    }

    const response = { projectId, projectRevision: 1, status: "created" as const };
    await commitMutation(db, [
      db.prepare("INSERT INTO projects (id, organization_id, project_key, name, description, directory, git_remote, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)").bind(projectId, organizationId, projectId, cleanName, command.description?.trim().slice(0, 2000) ?? "", command.directory?.trim().slice(0, 500) ?? "", command.gitRemote?.trim().slice(0, 500) || null, now),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, actor_name, event_type, summary, created_at) VALUES (?, ?, ?, 1, ?, 'project.created', ?, ?)").bind(id("evt"), organizationId, projectId, principal.displayName, `${principal.displayName} created ${cleanName}`, now),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
    ]);
    return response;
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
    const changed = [cleanName && "name", command.description !== undefined && "description", directory && "directory", gitRemote && "remote"].filter(Boolean).join(", ") || "details";
    const response = { projectId: command.projectId, projectRevision: nextRevision };
    await commitMutation(db, [
      db.prepare("UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), directory = COALESCE(?, directory), git_remote = COALESCE(?, git_remote), revision = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND revision = ?")
        .bind(cleanName ?? null, command.description?.trim().slice(0, 2000) ?? null, directory ?? null, gitRemote ?? null, nextRevision, now, command.projectId, organizationId, currentRevision),
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
    const actor = command.sourceId ? await sourceActor(db, organizationId, command.sourceId) : principal.displayName;
    const response = { itemId, itemKey, version: 1, projectRevision: nextRevision };
    await commitMutation(db, [
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND revision = ?").bind(nextRevision, now, command.projectId, organizationId, currentRevision),
      db.prepare("INSERT INTO work_items (id, organization_id, project_id, sequence, item_key, title, description, status, priority, source_id, content_fingerprint, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)").bind(itemId, organizationId, command.projectId, sequence, itemKey, cleanTitle, command.description?.trim().slice(0, 10000) ?? "", status, command.priority ?? "normal", command.sourceId ?? null, command.contentFingerprint ?? null, now, now),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, actor_name, event_type, summary, to_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'work_item.created', ?, ?, ?)").bind(id("evt"), organizationId, command.projectId, nextRevision, itemId, command.sourceId ?? null, actor, `${actor} created ${itemKey}: ${cleanTitle}`, status, now),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
    ]);
    return response;
  }

  if (command.action === "add_dependency") {
    if (command.fromWorkItemId === command.toWorkItemId) throw domainError("BLOCKING_CYCLE", "A task cannot block itself");
    const [from, to] = await db.batch([
      db.prepare("SELECT id, status FROM work_items WHERE id = ? AND project_id = ? AND organization_id = ?").bind(command.fromWorkItemId, command.projectId, organizationId),
      db.prepare("SELECT id FROM work_items WHERE id = ? AND project_id = ? AND organization_id = ?").bind(command.toWorkItemId, command.projectId, organizationId),
    ]);
    if (!from.results.length || !to.results.length) throw domainError("NOT_FOUND", "Dependency task not found", 404);
    const edgeType = command.type ?? "blocks";
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
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, actor_name, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, 'dependency.added', ?, ?)").bind(id("evt"), organizationId, command.projectId, nextRevision, command.toWorkItemId, principal.displayName, "Dependency added", now),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
    ];
    // Only a hard, unresolved prerequisite blocks anything. An edge to an already-done
    // or cancelled item, or an annotation edge, never increments the dependent's count.
    if (isDagEdgeType(edgeType) && !RESOLVED_STATUSES.has(text(from.results[0], "status") as WorkStatus)) {
      statements.push(db.prepare("UPDATE work_items SET blocking_count = blocking_count + 1, updated_at = ? WHERE id = ?").bind(now, command.toWorkItemId));
    }
    await commitMutation(db, statements);
    return response;
  }

  if (command.action === "split_alias") {
    const alias = await db.prepare(
      "SELECT a.*, wi.item_key AS target_item_key FROM work_item_aliases a JOIN work_items wi ON wi.id = a.work_item_id WHERE a.id = ? AND a.organization_id = ? AND a.project_id = ?",
    ).bind(command.aliasId, organizationId, command.projectId).first<Row>();
    if (!alias) throw domainError("NOT_FOUND", "Alias not found", 404);
    const cleanTitle = text(alias, "title").trim().slice(0, 240) || "Untitled task";
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
    ]);
    return response;
  }

  const item = await db.prepare("SELECT * FROM work_items WHERE id = ? AND project_id = ? AND organization_id = ? AND archived_at IS NULL").bind(command.itemId, command.projectId, organizationId).first<Row>();
  if (!item) throw domainError("NOT_FOUND", "Task not found", 404);
  const itemKey = text(item, "item_key");

  if (command.action === "add_note") {
    const summary = command.summary.trim().slice(0, 2000);
    if (!summary) throw domainError("VALIDATION_FAILED", "Progress update is required");
    const actor = command.sourceId ? await sourceActor(db, organizationId, command.sourceId) : principal.displayName;
    const response = { itemId: command.itemId, version: number(item, "version") + 1, projectRevision: nextRevision };
    await commitMutation(db, [
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(nextRevision, now, command.projectId, currentRevision),
      db.prepare("UPDATE work_items SET version = version + 1, updated_at = ? WHERE id = ?").bind(now, command.itemId),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, actor_name, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'work_item.progress_reported', ?, ?)").bind(id("evt"), organizationId, command.projectId, nextRevision, command.itemId, command.sourceId ?? null, actor, summary, now),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
    ]);
    return response;
  }

  if (command.action === "add_evidence") {
    const evidenceId = id("evd");
    const response = { evidenceId, itemId: command.itemId, projectRevision: nextRevision };
    await commitMutation(db, [
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(nextRevision, now, command.projectId, currentRevision),
      db.prepare("INSERT INTO evidence (id, organization_id, project_id, work_item_id, type, label, uri, result, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(evidenceId, organizationId, command.projectId, command.itemId, command.type.slice(0, 40), command.label.slice(0, 300), command.uri?.slice(0, 2000) ?? null, command.result?.slice(0, 500) ?? null, command.sourceId ?? null, now),
      db.prepare("UPDATE work_items SET completion_confidence = 'supported', version = version + 1, updated_at = ? WHERE id = ?").bind(now, command.itemId),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, actor_name, event_type, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'evidence.attached', ?, ?, ?)").bind(id("evt"), organizationId, command.projectId, nextRevision, command.itemId, command.sourceId ?? null, principal.displayName, `${command.type}: ${command.label}`, JSON.stringify({ evidenceId }), now),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
    ]);
    return response;
  }

  if (command.expectedVersion !== number(item, "version")) throw domainError("VERSION_CONFLICT", `Task changed since version ${command.expectedVersion}`, 409, { currentVersion: number(item, "version"), current: mapItem(item) });

  if (command.action === "update_item") {
    const title = command.title == null ? text(item, "title") : command.title.trim().slice(0, 240);
    if (!title) throw domainError("VALIDATION_FAILED", "Task title is required");
    const description = command.description == null ? text(item, "description") : command.description.trim().slice(0, 10000);
    const priority = command.priority ?? text(item, "priority");
    const assignee = command.assignee === undefined ? nullable(item, "assignee") : command.assignee;
    const response = { itemId: command.itemId, version: command.expectedVersion + 1, projectRevision: nextRevision };
    await commitMutation(db, [
      db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(nextRevision, now, command.projectId, currentRevision),
      db.prepare("UPDATE work_items SET title = ?, description = ?, priority = ?, assignee = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").bind(title, description, priority, assignee, now, command.itemId, command.expectedVersion),
      db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, actor_name, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, 'work_item.updated', ?, ?)").bind(id("evt"), organizationId, command.projectId, nextRevision, command.itemId, principal.displayName, `${principal.displayName} updated ${itemKey}`, now),
      db.prepare("INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES (?, ?, ?, ?)").bind(scope, command.idempotencyKey, requestHash, JSON.stringify(response)),
    ]);
    return response;
  }

  const currentStatus = text(item, "status") as WorkStatus;
  if (!ALLOWED_TRANSITIONS[currentStatus].includes(command.status) && currentStatus !== command.status) throw domainError("INVALID_TRANSITION", `Cannot move ${itemKey} from ${currentStatus} to ${command.status}`, 422, { allowed: ALLOWED_TRANSITIONS[currentStatus] });
  const actor = command.sourceId ? await sourceActor(db, organizationId, command.sourceId) : principal.displayName;
  const blockerReason = command.status === "blocked" ? command.reason?.trim().slice(0, 2000) || "Blocked without a reason" : null;
  const startedAt = command.status === "in_progress" && !item.started_at ? now : nullable(item, "started_at");
  const completedAt = command.status === "done" ? now : command.status === "in_progress" || command.status === "ready" ? null : nullable(item, "completed_at");
  const verification = command.status === "done" ? "passed" : text(item, "verification_status");
  const confidence = command.status === "done" ? "verified" : text(item, "completion_confidence");
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
    db.prepare("UPDATE work_items SET status = ?, blocker_reason = ?, started_at = ?, completed_at = ?, verification_status = ?, completion_confidence = ?, source_id = COALESCE(?, source_id), version = version + 1, updated_at = ? WHERE id = ? AND version = ?").bind(command.status, blockerReason, startedAt, completedAt, verification, confidence, command.sourceId ?? null, now, command.itemId, command.expectedVersion),
    db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, work_item_id, source_id, actor_name, event_type, summary, from_status, to_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id("evt"), organizationId, command.projectId, nextRevision, command.itemId, command.sourceId ?? nullable(item, "source_id"), actor, eventType, summary, currentStatus, command.status, now),
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
 * Recomputes blocking_count for every item in a project from the dependency table,
 * correcting any drift. Not wired to a scheduler yet (see IMPLEMENTATION_PLAN.md M3),
 * but safe to call any time, including from an ad hoc maintenance script.
 */
export async function recomputeBlockingCounts(db: PgD1, organizationId: string, projectId: string) {
  await db.prepare(
    `UPDATE work_items SET blocking_count = (
       SELECT COUNT(*) FROM dependencies d
         JOIN work_items u ON u.id = d.from_work_item_id
        WHERE d.to_work_item_id = work_items.id AND d.type IN (${DAG_EDGE_TYPE_SQL_LIST}) AND u.status NOT IN ('done', 'cancelled')
     )
     WHERE project_id = ? AND organization_id = ?`,
  ).bind(...DAG_EDGE_TYPES, projectId, organizationId).run();
}

async function sourceActor(db: PgD1, organizationId: string, sourceId: string) {
  const row = await db.prepare("SELECT provider FROM sources WHERE id = ? AND organization_id = ?").bind(sourceId, organizationId).first<{ provider: string }>();
  if (!row) throw domainError("NOT_FOUND", "Source not found", 404);
  return row.provider.charAt(0).toUpperCase() + row.provider.slice(1);
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

export async function principalFromBearer(db: PgD1, authorization: string | null, resource?: string): Promise<Principal | null> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  const tokenHash = await digest(token);
  const personal = await db.prepare("SELECT owner_user_id, scopes FROM mcp_tokens WHERE token_hash = ? AND revoked_at IS NULL").bind(tokenHash).first<{ owner_user_id: string; scopes: string }>();
  if (personal) {
    await db.prepare("UPDATE mcp_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?").bind(tokenHash).run();
    return { userId: personal.owner_user_id, email: `${personal.owner_user_id}@planbraid.agent`, displayName: "Connected agent", scopes: personal.scopes.split(/[ ,]+/).filter(Boolean), authentication: "personal_token" };
  }
  if (!resource) return null;
  const oauth = await db.prepare("SELECT access.owner_user_id, access.scopes FROM oauth_access_tokens access JOIN oauth_token_families family ON family.id = access.family_id WHERE access.token_hash = ? AND access.resource = ? AND access.revoked_at IS NULL AND family.revoked_at IS NULL AND access.expires_at > ?")
    .bind(tokenHash, resource, new Date().toISOString()).first<{ owner_user_id: string; scopes: string }>();
  if (!oauth) return null;
  await db.prepare("UPDATE oauth_access_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?").bind(tokenHash).run();
  return { userId: oauth.owner_user_id, email: `${oauth.owner_user_id}@planbraid.agent`, displayName: "OAuth-connected agent", scopes: oauth.scopes.split(/\s+/).filter(Boolean), authentication: "oauth" };
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
  const eventCount = await db.prepare("SELECT COUNT(*) AS count FROM work_events WHERE source_id = ? AND created_at >= COALESCE((SELECT started_at FROM interactions WHERE id = ?), now() - interval '1 hour')").bind(input.sourceId, interactionId).first<{ count: number }>();
  const reconciliation = Number(eventCount?.count ?? 0) > 0 ? "todos_changed" : "no_todo_change";
  const notificationId = id("ntf");
  await commitMutation(db, [
    existing
      ? db.prepare("UPDATE interactions SET status = 'completed', outcome = ?, summary = ?, reconciliation = ?, completed_at = ?, updated_at = ? WHERE id = ?").bind(input.outcome ?? "success", summary, reconciliation, now, now, interactionId)
      : db.prepare("INSERT INTO interactions (id, organization_id, project_id, source_id, external_id, sequence, status, outcome, summary, reconciliation, started_at, completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)").bind(interactionId, organizationId, input.projectId, input.sourceId, input.externalId, input.sequence ?? null, input.outcome ?? "success", summary, reconciliation, now, now, now),
    db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(nextRevision, now, input.projectId, currentRevision),
    db.prepare("INSERT INTO work_events (id, organization_id, project_id, project_revision, source_id, interaction_id, actor_name, event_type, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'interaction.completed', ?, ?, ?)").bind(id("evt"), organizationId, input.projectId, nextRevision, input.sourceId, interactionId, text(source, "provider").replace(/^./, (c) => c.toUpperCase()), summary, JSON.stringify({ reconciliation, outcome: input.outcome ?? "success" }), now),
    db.prepare("INSERT INTO notifications (id, organization_id, recipient_user_id, project_id, source_id, interaction_id, event_type, priority, title, body, deep_link, dedupe_key, requires_action, created_at) VALUES (?, ?, ?, ?, ?, ?, 'interaction.completed', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING").bind(notificationId, organizationId, principal.userId, input.projectId, input.sourceId, interactionId, input.outcome === "failed" || input.outcome === "blocked" ? "high" : "normal", `${text(source, "provider")} interaction ${input.outcome ?? "completed"}`, summary, `/?project=${input.projectId}&source=${input.sourceId}`, `interaction:${interactionId}`, input.outcome === "blocked" ? 1 : 0, now),
  ]);
  return { interactionId, notificationId, reconciliation, projectRevision: nextRevision };
}

export async function registerSourceSession(db: PgD1, principal: Principal, input: { projectId: string; provider: string; externalId: string; title?: string; model?: string; codingSpaceId?: string; assurance?: string }) {
  const organizationId = await organizationFor(db, principal);
  await ownedProject(db, organizationId, input.projectId);
  const provider = input.provider.trim().slice(0, 80);
  const externalId = input.externalId.trim().slice(0, 240);
  if (!provider || !externalId) throw domainError("VALIDATION_FAILED", "Provider and external session ID are required");
  const existing = await db.prepare("SELECT id FROM sources WHERE project_id = ? AND provider = ? AND external_id = ?").bind(input.projectId, provider, externalId).first<{ id: string }>();
  if (existing) {
    await db.prepare("UPDATE sources SET status = 'active', last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, title = COALESCE(?, title), model = COALESCE(?, model) WHERE id = ?").bind(input.title ?? null, input.model ?? null, existing.id).run();
    return { sourceId: existing.id, idempotentReplay: true };
  }
  const sourceId = id("src");
  // Two concurrent register_agent_session calls for the same (project, provider,
  // external_id) can both reach here believing no source exists yet (Postgres runs
  // them in true parallel, unlike D1 which serialized every query). The losing insert
  // hits sources' UNIQUE(project_id, provider, external_id), not the id primary key, so
  // re-select on conflict rather than assume this insert is the row that landed.
  const inserted = await db.prepare("INSERT INTO sources (id, organization_id, project_id, coding_space_id, provider, external_id, title, model, status, assurance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?) ON CONFLICT (project_id, provider, external_id) DO NOTHING RETURNING id")
    .bind(sourceId, organizationId, input.projectId, input.codingSpaceId ?? null, provider, externalId, input.title?.slice(0, 240) || `${provider} session`, input.model?.slice(0, 120) ?? null, input.assurance ?? "instructed").first<{ id: string }>();
  if (inserted) return { sourceId: inserted.id, idempotentReplay: false };
  const winner = await db.prepare("SELECT id FROM sources WHERE project_id = ? AND provider = ? AND external_id = ?").bind(input.projectId, provider, externalId).first<{ id: string }>();
  return { sourceId: winner!.id, idempotentReplay: true };
}

/**
 * Creates proposed work, collapsing anything that restates work the project already
 * has. Nothing is ever discarded: a collapsed proposal is stored as an alias carrying
 * its original wording and the agent that authored it, so provenance survives and a
 * wrong match stays reversible.
 */
export async function createWorkItemsDeduplicated(
  db: PgD1,
  principal: Principal,
  input: { projectId: string; proposals: Proposal[]; sourceId?: string; idempotencyKey: string },
) {
  const organizationId = await organizationFor(db, principal);
  await ownedProject(db, organizationId, input.projectId);
  const rows = await db.prepare("SELECT * FROM work_items WHERE project_id = ? AND organization_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 500")
    .bind(input.projectId, organizationId).all<Row>();
  const existingItems = rows.results.map(mapItem);
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
        sourceId: input.sourceId, contentFingerprint: outcome.fingerprintValue, idempotencyKey: `${input.idempotencyKey}:${index}`,
      }) as unknown as { itemId: string; itemKey: string };
      createdByIndex.set(index, record);
      targetByIndex.set(index, record);
      created += 1;

      const entry: Record<string, unknown> = { ref: outcome.ref, status: "created", workItemId: record.itemId, itemKey: record.itemKey };
      // Resembles existing work but not conclusively. The item is created either way;
      // the resemblance is a note, not a decision the agent has to make.
      if (outcome.match) entry.resembles = { itemKey: outcome.match.itemKey, workItemId: outcome.match.workItemId, note: outcome.match.explanation };
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
    const existingKeyById = new Map(existingItems.map((entry) => [entry.id, entry.itemKey] as const));

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
            type: "blocks", idempotencyKey: `${input.idempotencyKey}:dep:${index}:${depIndex}`,
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
  await ownedProject(db, organizationId, input.projectId);
  const avoidCollisions = input.avoidCollisions !== false;
  const limit = Math.min(Math.max(Number(input.limit ?? 5), 1), 50);

  const [itemRows, sourceRows, aliasRows] = await db.batch([
    db.prepare("SELECT * FROM work_items WHERE project_id = ? AND organization_id = ? AND archived_at IS NULL AND status = 'ready' AND blocking_count = 0").bind(input.projectId, organizationId),
    db.prepare("SELECT * FROM sources WHERE project_id = ? AND organization_id = ?").bind(input.projectId, organizationId),
    db.prepare("SELECT * FROM work_item_aliases WHERE project_id = ? AND organization_id = ?").bind(input.projectId, organizationId),
  ]);
  const candidates = itemRows.results.map(mapItem);
  // The SQL predicate above is the same rule deriveColumn applies for a "ready" item, so
  // this list can never diverge from what the board shows in the Ready column.
  const sources = sourceRows.results.map(mapSource);
  const aliases = aliasRows.results.map(mapAlias);

  const claimed = new Set<string>();
  if (avoidCollisions) {
    for (const source of sources) {
      if (source.status === "ended" || source.id === input.sourceId) continue;
      for (const taskId of source.currentTaskIds) claimed.add(taskId);
    }
  }

  let excludedByCollision = 0;
  const ranked = [];
  for (const item of candidates) {
    if (claimed.has(item.id)) { excludedByCollision += 1; continue; }
    const downstream = await downstreamOf(db, organizationId, input.projectId, item.id);
    const unlockCount = downstream.filter((entry) => entry.blockingCount === 1).length;
    const providers = new Set<string>();
    const ownSource = sources.find((source) => source.id === item.sourceId);
    if (ownSource) providers.add(ownSource.provider);
    for (const alias of aliases) {
      if (alias.workItemId !== item.id) continue;
      const aliasSource = sources.find((source) => source.id === alias.sourceId);
      if (aliasSource) providers.add(aliasSource.provider);
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

export async function updateSourceHeartbeat(db: PgD1, principal: Principal, input: { sourceId: string; state?: string; currentTaskIds?: string[]; end?: boolean }) {
  const organizationId = await organizationFor(db, principal);
  const result = await db.prepare("UPDATE sources SET status = ?, current_task_ids = ?, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? RETURNING id").bind(input.end ? "ended" : input.state ?? "active", JSON.stringify((input.currentTaskIds ?? []).slice(0, 100)), input.sourceId, organizationId).first();
  if (!result) throw domainError("NOT_FOUND", "Source session not found", 404);
  return { sourceId: input.sourceId, status: input.end ? "ended" : input.state ?? "active" };
}
