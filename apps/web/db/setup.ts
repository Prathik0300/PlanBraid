export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt DATE NOT NULL, updatedAt DATE NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "session" (id TEXT PRIMARY KEY, expiresAt DATE NOT NULL, token TEXT NOT NULL UNIQUE, createdAt DATE NOT NULL, updatedAt DATE NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_session_user ON "session"(userId)`,
  `CREATE TABLE IF NOT EXISTS "account" (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt DATE, refreshTokenExpiresAt DATE, scope TEXT, password TEXT, createdAt DATE NOT NULL, updatedAt DATE NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_account_user ON "account"(userId)`,
  `CREATE TABLE IF NOT EXISTS "verification" (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt DATE NOT NULL, createdAt DATE, updatedAt DATE)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_verification_identifier ON "verification"(identifier)`,
  `CREATE TABLE IF NOT EXISTS "rateLimit" (id TEXT PRIMARY KEY, "key" TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, lastRequest INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS auth_principal_links (auth_user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE, canonical_user_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS data_migrations (organization_id TEXT NOT NULL, migration_key TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(organization_id, migration_key))`,
  `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_key TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', directory TEXT NOT NULL DEFAULT '', git_remote TEXT, default_branch TEXT NOT NULL DEFAULT 'main', revision INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(organization_id, project_key))`,
  `CREATE INDEX IF NOT EXISTS idx_projects_org_updated ON projects(organization_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS coding_spaces (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, fingerprint TEXT NOT NULL, label TEXT NOT NULL, safe_path TEXT NOT NULL, branch TEXT NOT NULL DEFAULT 'main', kind TEXT NOT NULL DEFAULT 'local', status TEXT NOT NULL DEFAULT 'online', last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id, fingerprint))`,
  `CREATE INDEX IF NOT EXISTS idx_spaces_project ON coding_spaces(project_id)`,
  `CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, coding_space_id TEXT, provider TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL, model TEXT, status TEXT NOT NULL DEFAULT 'active', assurance TEXT NOT NULL DEFAULT 'instructed', current_task_ids TEXT NOT NULL DEFAULT '[]', last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id, provider, external_id))`,
  `CREATE INDEX IF NOT EXISTS idx_sources_project_seen ON sources(project_id, last_seen_at)`,
  `CREATE TABLE IF NOT EXISTS interactions (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL, sequence INTEGER, status TEXT NOT NULL DEFAULT 'started', outcome TEXT, summary TEXT NOT NULL DEFAULT '', reconciliation TEXT NOT NULL DEFAULT 'needs_reconciliation', started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(source_id, external_id))`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_project_completed ON interactions(project_id, completed_at)`,
  `CREATE TABLE IF NOT EXISTS work_items (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, sequence INTEGER NOT NULL, item_key TEXT NOT NULL, parent_id TEXT, type TEXT NOT NULL DEFAULT 'task', title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'proposed', priority TEXT NOT NULL DEFAULT 'normal', assignee TEXT, source_id TEXT, coding_space_id TEXT, completion_confidence TEXT NOT NULL DEFAULT 'reported', verification_status TEXT NOT NULL DEFAULT 'pending', blocker_reason TEXT, version INTEGER NOT NULL DEFAULT 1, started_at TEXT, completed_at TEXT, archived_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id, sequence), UNIQUE(project_id, item_key))`,
  `CREATE INDEX IF NOT EXISTS idx_work_items_project_status ON work_items(project_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_work_items_source ON work_items(source_id)`,
  `CREATE TABLE IF NOT EXISTS work_events (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, project_revision INTEGER NOT NULL, work_item_id TEXT, source_id TEXT, interaction_id TEXT, actor_name TEXT NOT NULL, event_type TEXT NOT NULL, summary TEXT NOT NULL, from_status TEXT, to_status TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id, project_revision))`,
  `CREATE INDEX IF NOT EXISTS idx_events_project_revision ON work_events(project_id, project_revision)`,
  `CREATE INDEX IF NOT EXISTS idx_events_item_created ON work_events(work_item_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS dependencies (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, from_work_item_id TEXT NOT NULL, to_work_item_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'blocks', reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(from_work_item_id, to_work_item_id, type), CHECK(from_work_item_id <> to_work_item_id))`,
  `CREATE INDEX IF NOT EXISTS idx_dependencies_to ON dependencies(to_work_item_id)`,
  `CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, work_item_id TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL, uri TEXT, result TEXT, source_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_item ON evidence(work_item_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS work_claims (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, source_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'exclusive', lease_expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, version INTEGER NOT NULL DEFAULT 1, UNIQUE(work_item_id, source_id))`,
  `CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, recipient_user_id TEXT NOT NULL, project_id TEXT NOT NULL, work_item_id TEXT, source_id TEXT, interaction_id TEXT, event_type TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', title TEXT NOT NULL, body TEXT NOT NULL, deep_link TEXT NOT NULL, dedupe_key TEXT NOT NULL, requires_action INTEGER NOT NULL DEFAULT 0, read_at TEXT, resolved_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(recipient_user_id, dedupe_key))`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(recipient_user_id, read_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS idempotency_records (scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(scope, idempotency_key))`,
  `CREATE TABLE IF NOT EXISTS mcp_tokens (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'work:read,work:write', last_used_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, client_secret_hash TEXT, client_name TEXT NOT NULL, redirect_uris TEXT NOT NULL, grant_types TEXT NOT NULL, response_types TEXT NOT NULL, token_auth_method TEXT NOT NULL DEFAULT 'none', client_uri TEXT, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS oauth_authorization_requests (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL, state TEXT, code_challenge TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_requests_expiry ON oauth_authorization_requests(expires_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_authorization_codes (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL, code_challenge TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_codes_client_expiry ON oauth_authorization_codes(client_id, expires_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_token_families (id TEXT PRIMARY KEY, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS oauth_access_tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL, family_id TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_access_family ON oauth_access_tokens(family_id)`,
  `CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL, family_id TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON oauth_refresh_tokens(family_id)`,
  `CREATE TABLE IF NOT EXISTS oauth_rate_limits (rate_key TEXT NOT NULL, window_start TEXT NOT NULL, request_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(rate_key, window_start))`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, endpoint TEXT NOT NULL, subscription TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'all_interactions', active INTEGER NOT NULL DEFAULT 1, last_success_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(owner_user_id, endpoint))`,
  // A matched proposal is stored as an alias rather than a work item on purpose. Making
  // it a real row would give it a status and a version, so it would surface in board
  // queries, counts, list_work_items, and the dependency graph, and every one of those
  // call sites would need a filter forever. Provenance is preserved either way.
  `CREATE TABLE IF NOT EXISTS work_item_aliases (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, work_item_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', source_id TEXT, interaction_id TEXT, match_score REAL NOT NULL DEFAULT 0, match_method TEXT NOT NULL DEFAULT 'fingerprint', match_reason TEXT NOT NULL DEFAULT '', confirmed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_aliases_item ON work_item_aliases(work_item_id, created_at)`,
] as const;

/**
 * Additive column migrations. SQLite has no `ADD COLUMN IF NOT EXISTS`, and on an
 * already-migrated database the expected outcome is a duplicate-column error, so each
 * runs on its own rather than inside the batch above where one failure would abort
 * every other statement.
 */
export const MIGRATION_STATEMENTS = [
  `ALTER TABLE work_items ADD COLUMN content_fingerprint TEXT`,
  // Count of unresolved hard-dependency prerequisites (DAG_EDGE_TYPES), maintained
  // incrementally on every dependency write and status transition. See
  // GRAPH_ARCHITECTURE.md §4 — this is what lets a blocked item become ready on its
  // own instead of the status just going stale once its blocker finishes.
  `ALTER TABLE work_items ADD COLUMN blocking_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE work_items ADD COLUMN unblocked_at TEXT`,
] as const;

let initialized = false;

export async function ensureSchema(db: D1Database) {
  if (initialized) return;
  await db.batch(SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)));
  for (const statement of MIGRATION_STATEMENTS) {
    try { await db.prepare(statement).run(); } catch { /* column already present */ }
  }
  initialized = true;
}
