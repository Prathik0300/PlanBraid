/**
 * Project-scoped reads.
 *
 * `loadDashboard` exists to render one screen that genuinely shows everything the viewer
 * owns, and for that it is the right query. It became the wrong query everywhere else:
 * every MCP read tool called it, so asking about one work item loaded every project's
 * items, events, dependencies, evidence and aliases and then filtered in JavaScript
 * (`PLANNING_INTELLIGENCE_ROADMAP.md` finding F6). Every planning-intelligence feature
 * adds another reader, so this module is what they read through instead.
 *
 * Two rules:
 *  - Every query here is scoped by `project_id` AND `organization_id`. The organization
 *    predicate is the authorization boundary and is never dropped just because the
 *    project id was already checked.
 *  - Callers ask for what they need. Loading events to answer "what is this item's title"
 *    is the same mistake at a smaller scale.
 */
import type { PgD1 } from "@/db/pg-d1";
import type { Project, Source, WorkEvent, WorkItem } from "@/lib/contracts";
import { mapAlias, mapDependency, mapEvent, mapEvidence, mapItem, mapProject, mapSource, type Row } from "./rows.ts";

export type ProjectViewParts = {
  items?: boolean;
  events?: boolean;
  sources?: boolean;
  dependencies?: boolean;
  evidence?: boolean;
  aliases?: boolean;
};

export type ProjectView = {
  project: Project;
  workItems: WorkItem[];
  events: WorkEvent[];
  sources: Source[];
  dependencies: ReturnType<typeof mapDependency>[];
  evidence: ReturnType<typeof mapEvidence>[];
  aliases: ReturnType<typeof mapAlias>[];
};

/** Recent-events cap. The brief shows 20; anything wanting more wants a different query. */
const EVENT_LIMIT = 100;

export function notFound(message = "Project not found") {
  return Object.assign(new Error(message), { code: "NOT_FOUND", status: 404 });
}

/**
 * One project, with only the parts asked for. Issued as a single `db.batch`, so the
 * whole view costs one round trip rather than one per part.
 */
export async function loadProjectView(
  db: PgD1,
  organizationId: string,
  projectId: string,
  parts: ProjectViewParts = {},
): Promise<ProjectView> {
  const statements = [db.prepare("SELECT * FROM projects WHERE id = ? AND organization_id = ? AND status <> 'archived'").bind(projectId, organizationId)];
  const order: Array<keyof ProjectViewParts> = [];

  if (parts.items) {
    order.push("items");
    statements.push(db.prepare("SELECT * FROM work_items WHERE project_id = ? AND organization_id = ? AND archived_at IS NULL ORDER BY sequence").bind(projectId, organizationId));
  }
  if (parts.events) {
    order.push("events");
    statements.push(db.prepare("SELECT * FROM work_events WHERE project_id = ? AND organization_id = ? ORDER BY created_at DESC, project_revision DESC LIMIT ?").bind(projectId, organizationId, EVENT_LIMIT));
  }
  if (parts.sources) {
    order.push("sources");
    statements.push(db.prepare("SELECT * FROM sources WHERE project_id = ? AND organization_id = ? ORDER BY last_seen_at DESC").bind(projectId, organizationId));
  }
  if (parts.dependencies) {
    order.push("dependencies");
    statements.push(db.prepare("SELECT * FROM dependencies WHERE project_id = ? AND organization_id = ?").bind(projectId, organizationId));
  }
  if (parts.evidence) {
    order.push("evidence");
    statements.push(db.prepare("SELECT * FROM evidence WHERE project_id = ? AND organization_id = ? ORDER BY created_at DESC").bind(projectId, organizationId));
  }
  if (parts.aliases) {
    order.push("aliases");
    statements.push(db.prepare("SELECT * FROM work_item_aliases WHERE project_id = ? AND organization_id = ? ORDER BY created_at DESC").bind(projectId, organizationId));
  }

  const results = await db.batch(statements);
  const projectRow = (results[0].results as Row[])[0];
  if (!projectRow) throw notFound();

  const view: ProjectView = { project: mapProject(projectRow), workItems: [], events: [], sources: [], dependencies: [], evidence: [], aliases: [] };
  const presenceNow = Date.now();
  for (const [index, part] of order.entries()) {
    const rows = results[index + 1].results as Row[];
    if (part === "items") view.workItems = rows.map(mapItem);
    else if (part === "events") view.events = rows.map(mapEvent);
    else if (part === "sources") view.sources = rows.map((row) => mapSource(row, presenceNow));
    else if (part === "dependencies") view.dependencies = rows.map(mapDependency);
    else if (part === "evidence") view.evidence = rows.map(mapEvidence);
    else if (part === "aliases") view.aliases = rows.map(mapAlias);
  }
  return view;
}

/** Ownership check on its own, for callers that need nothing else back. */
export async function requireProject(db: PgD1, organizationId: string, projectId: string) {
  const row = await db.prepare("SELECT * FROM projects WHERE id = ? AND organization_id = ? AND status <> 'archived'").bind(projectId, organizationId).first<Row>();
  if (!row) throw notFound();
  return row;
}

export type ListWorkItemsInput = { projectId: string; status?: string; sourceId?: string; query?: string; limit?: number };

/**
 * Filtered work-item list, filtered in SQL. The status/source/text predicates used to run
 * in JavaScript over every item in the organization; here they are `WHERE` clauses, so a
 * caller asking for three blocked items transfers three rows.
 */
export async function listWorkItems(db: PgD1, organizationId: string, input: ListWorkItemsInput): Promise<WorkItem[]> {
  const limit = Math.min(Math.max(Number(input.limit ?? 100), 1), 200);
  const clauses = ["project_id = ?", "organization_id = ?", "archived_at IS NULL"];
  const binds: unknown[] = [input.projectId, organizationId];
  if (input.status) { clauses.push("status = ?"); binds.push(input.status); }
  if (input.sourceId) { clauses.push("source_id = ?"); binds.push(input.sourceId); }
  if (input.query?.trim()) {
    // ILIKE over the same three fields the in-memory filter used. `%` and `_` in the
    // query are escaped so a search for "100%" is a search for a literal percent sign
    // rather than a wildcard that matches the whole project.
    clauses.push("(item_key ILIKE ? ESCAPE '\\' OR title ILIKE ? ESCAPE '\\' OR description ILIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLike(input.query.trim())}%`;
    binds.push(pattern, pattern, pattern);
  }
  const rows = await db.prepare(`SELECT * FROM work_items WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`).bind(...binds, limit).all<Row>();
  return rows.results.map(mapItem);
}

/** Cross-project search, still scoped to the organization, still filtered in SQL. */
export async function searchWorkItems(db: PgD1, organizationId: string, input: { query: string; projectId?: string; limit?: number }): Promise<WorkItem[]> {
  const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 100);
  const pattern = `%${escapeLike(input.query.trim())}%`;
  const clauses = ["organization_id = ?", "archived_at IS NULL", "(item_key ILIKE ? ESCAPE '\\' OR title ILIKE ? ESCAPE '\\' OR description ILIKE ? ESCAPE '\\')"];
  const binds: unknown[] = [organizationId, pattern, pattern, pattern];
  if (input.projectId) { clauses.push("project_id = ?"); binds.push(input.projectId); }
  const rows = await db.prepare(`SELECT * FROM work_items WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`).bind(...binds, limit).all<Row>();
  return rows.results.map(mapItem);
}

/** One work item with the context a caller reading a single task actually wants. */
export async function loadWorkItemDetail(db: PgD1, organizationId: string, workItemId: string) {
  const itemRow = await db.prepare("SELECT * FROM work_items WHERE id = ? AND organization_id = ? AND archived_at IS NULL").bind(workItemId, organizationId).first<Row>();
  if (!itemRow) throw Object.assign(new Error("Work item not found"), { code: "NOT_FOUND", status: 404 });
  const item = mapItem(itemRow);
  const [sourceResult, eventResult, evidenceResult, dependencyResult, aliasResult] = await db.batch([
    db.prepare("SELECT * FROM sources WHERE id = ? AND organization_id = ?").bind(item.sourceId ?? "", organizationId),
    db.prepare("SELECT * FROM work_events WHERE work_item_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT ?").bind(workItemId, organizationId, EVENT_LIMIT),
    db.prepare("SELECT * FROM evidence WHERE work_item_id = ? AND organization_id = ? ORDER BY created_at DESC").bind(workItemId, organizationId),
    db.prepare("SELECT * FROM dependencies WHERE (from_work_item_id = ? OR to_work_item_id = ?) AND organization_id = ?").bind(workItemId, workItemId, organizationId),
    db.prepare("SELECT * FROM work_item_aliases WHERE work_item_id = ? AND organization_id = ? ORDER BY created_at DESC").bind(workItemId, organizationId),
  ]);
  return {
    workItem: item,
    source: (sourceResult.results as Row[])[0] ? mapSource((sourceResult.results as Row[])[0]) : null,
    events: (eventResult.results as Row[]).map(mapEvent),
    evidence: (evidenceResult.results as Row[]).map(mapEvidence),
    dependencies: (dependencyResult.results as Row[]).map(mapDependency),
    aliases: (aliasResult.results as Row[]).map(mapAlias),
  };
}

/** Every project the caller owns. `resolve_project` needs the list and nothing else. */
export async function listProjects(db: PgD1, organizationId: string): Promise<Project[]> {
  const rows = await db.prepare("SELECT * FROM projects WHERE organization_id = ? AND status <> 'archived' ORDER BY updated_at DESC").bind(organizationId).all<Row>();
  return rows.results.map(mapProject);
}

/** `id → itemKey`, for messages that name the tasks they acted on. */
export async function itemKeysFor(db: PgD1, organizationId: string, itemIds: string[]) {
  const keys = new Map<string, string>();
  if (!itemIds.length) return keys;
  const rows = await db.prepare("SELECT id, item_key FROM work_items WHERE organization_id = ? AND id = ANY(?::text[])").bind(organizationId, itemIds).all<{ id: string; item_key: string }>();
  for (const row of rows.results) keys.set(row.id, row.item_key);
  return keys;
}

/** The current optimistic-concurrency version, for callers that just chained a write and
 * need the version the next one must assert. */
export async function currentVersionOf(db: PgD1, organizationId: string, workItemId: string) {
  return db.prepare("SELECT version, item_key FROM work_items WHERE id = ? AND organization_id = ? AND archived_at IS NULL").bind(workItemId, organizationId).first<{ version: number; item_key: string }>();
}

/** `\`, `%` and `_` are the three characters ILIKE treats specially. */
function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
