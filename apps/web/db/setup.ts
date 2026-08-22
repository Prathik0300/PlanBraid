import type { PgD1 } from "@/db/pg-d1";

/**
 * better-auth's Kysely Postgres adapter always double-quotes identifiers, so these
 * camelCase columns must be created quoted too — an unquoted `emailVerified` would be
 * folded to `emailverified` by Postgres and every better-auth query would 404 on it.
 */
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, "emailVerified" BOOLEAN NOT NULL DEFAULT false, image TEXT, "createdAt" TIMESTAMPTZ NOT NULL, "updatedAt" TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "session" (id TEXT PRIMARY KEY, "expiresAt" TIMESTAMPTZ NOT NULL, token TEXT NOT NULL UNIQUE, "createdAt" TIMESTAMPTZ NOT NULL, "updatedAt" TIMESTAMPTZ NOT NULL, "ipAddress" TEXT, "userAgent" TEXT, "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_session_user ON "session"("userId")`,
  `CREATE TABLE IF NOT EXISTS "account" (id TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "providerId" TEXT NOT NULL, "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, "accessToken" TEXT, "refreshToken" TEXT, "idToken" TEXT, "accessTokenExpiresAt" TIMESTAMPTZ, "refreshTokenExpiresAt" TIMESTAMPTZ, scope TEXT, password TEXT, "createdAt" TIMESTAMPTZ NOT NULL, "updatedAt" TIMESTAMPTZ NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_account_user ON "account"("userId")`,
  `CREATE TABLE IF NOT EXISTS "verification" (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, "expiresAt" TIMESTAMPTZ NOT NULL, "createdAt" TIMESTAMPTZ, "updatedAt" TIMESTAMPTZ)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_verification_identifier ON "verification"(identifier)`,
  `CREATE TABLE IF NOT EXISTS "rateLimit" (id TEXT PRIMARY KEY, "key" TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, "lastRequest" BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS auth_principal_links (auth_user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE, canonical_user_id TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS data_migrations (organization_id TEXT NOT NULL, migration_key TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(organization_id, migration_key))`,
  `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_key TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', directory TEXT NOT NULL DEFAULT '', git_remote TEXT, default_branch TEXT NOT NULL DEFAULT 'main', revision INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(organization_id, project_key))`,
  `CREATE INDEX IF NOT EXISTS idx_projects_org_updated ON projects(organization_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS project_members (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'planbraid', external_id TEXT, name TEXT NOT NULL, email TEXT, avatar_url TEXT, title TEXT, active BOOLEAN NOT NULL DEFAULT true, metadata TEXT NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_project_members_external ON project_members(project_id, provider, external_id) WHERE external_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id, active, name)`,
  `CREATE TABLE IF NOT EXISTS coding_spaces (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, fingerprint TEXT NOT NULL, label TEXT NOT NULL, safe_path TEXT NOT NULL, branch TEXT NOT NULL DEFAULT 'main', kind TEXT NOT NULL DEFAULT 'local', status TEXT NOT NULL DEFAULT 'online', last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(project_id, fingerprint))`,
  `CREATE INDEX IF NOT EXISTS idx_spaces_project ON coding_spaces(project_id)`,
  `CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, coding_space_id TEXT, provider TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL, model TEXT, status TEXT NOT NULL DEFAULT 'active', assurance TEXT NOT NULL DEFAULT 'instructed', current_task_ids TEXT NOT NULL DEFAULT '[]', last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(project_id, provider, external_id))`,
  `CREATE INDEX IF NOT EXISTS idx_sources_project_seen ON sources(project_id, last_seen_at)`,
  `CREATE TABLE IF NOT EXISTS interactions (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL, sequence INTEGER, status TEXT NOT NULL DEFAULT 'started', outcome TEXT, summary TEXT NOT NULL DEFAULT '', reconciliation TEXT NOT NULL DEFAULT 'needs_reconciliation', started_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(source_id, external_id))`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_project_completed ON interactions(project_id, completed_at)`,
  // No parent_id: it was declared here and never written by any code path (finding F7,
  // tracked across three architecture documents without ever being decided). Hierarchy is
  // deferred to M20, which models an objective as a work_item of type='objective'
  // referenced by objective_id — a name that says what the relationship means, rather than
  // a generic parent/child column three separate designs each read differently.
  `CREATE TABLE IF NOT EXISTS work_items (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, sequence INTEGER NOT NULL, item_key TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'task', title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'proposed', priority TEXT NOT NULL DEFAULT 'normal', assignee TEXT, source_id TEXT, coding_space_id TEXT, completion_confidence TEXT NOT NULL DEFAULT 'reported', verification_status TEXT NOT NULL DEFAULT 'pending', blocker_reason TEXT, version INTEGER NOT NULL DEFAULT 1, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, archived_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(project_id, sequence), UNIQUE(project_id, item_key))`,
  `CREATE INDEX IF NOT EXISTS idx_work_items_project_status ON work_items(project_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_work_items_source ON work_items(source_id)`,
  `CREATE TABLE IF NOT EXISTS work_item_assignees (organization_id TEXT NOT NULL, project_id TEXT NOT NULL, work_item_id TEXT NOT NULL, project_member_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (work_item_id, project_member_id))`,
  `CREATE INDEX IF NOT EXISTS idx_work_item_assignees_member ON work_item_assignees(project_member_id, work_item_id)`,
  `CREATE TABLE IF NOT EXISTS work_events (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, project_revision INTEGER NOT NULL, work_item_id TEXT, source_id TEXT, interaction_id TEXT, actor_name TEXT NOT NULL, event_type TEXT NOT NULL, summary TEXT NOT NULL, from_status TEXT, to_status TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(project_id, project_revision))`,
  `CREATE INDEX IF NOT EXISTS idx_events_project_revision ON work_events(project_id, project_revision)`,
  `CREATE INDEX IF NOT EXISTS idx_events_item_created ON work_events(work_item_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS dependencies (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, from_work_item_id TEXT NOT NULL, to_work_item_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'blocks', reason TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(from_work_item_id, to_work_item_id, type), CHECK(from_work_item_id <> to_work_item_id))`,
  `CREATE INDEX IF NOT EXISTS idx_dependencies_to ON dependencies(to_work_item_id)`,
  `CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, work_item_id TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL, uri TEXT, result TEXT, source_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_item ON evidence(work_item_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS work_claims (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, source_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'exclusive', lease_expires_at TIMESTAMPTZ NOT NULL, heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(), version INTEGER NOT NULL DEFAULT 1, UNIQUE(work_item_id, source_id))`,
  `CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, recipient_user_id TEXT NOT NULL, project_id TEXT NOT NULL, work_item_id TEXT, source_id TEXT, interaction_id TEXT, event_type TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', title TEXT NOT NULL, body TEXT NOT NULL, deep_link TEXT NOT NULL, dedupe_key TEXT NOT NULL, requires_action INTEGER NOT NULL DEFAULT 0, read_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(recipient_user_id, dedupe_key))`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(recipient_user_id, read_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS idempotency_records (scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(scope, idempotency_key))`,
  `CREATE TABLE IF NOT EXISTS mcp_tokens (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT 'work:read,work:write', last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, client_secret_hash TEXT, client_name TEXT NOT NULL, redirect_uris TEXT NOT NULL, grant_types TEXT NOT NULL, response_types TEXT NOT NULL, token_auth_method TEXT NOT NULL DEFAULT 'none', client_uri TEXT, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS oauth_authorization_requests (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL, state TEXT, code_challenge TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_requests_expiry ON oauth_authorization_requests(expires_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_authorization_codes (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL, code_challenge TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_codes_client_expiry ON oauth_authorization_codes(client_id, expires_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_token_families (id TEXT PRIMARY KEY, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS oauth_access_tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL, family_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_access_family ON oauth_access_tokens(family_id)`,
  `CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL, family_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON oauth_refresh_tokens(family_id)`,
  // rate_key/window_start stay TEXT (bucket identifiers, compared lexicographically by
  // lib/oauth.ts, not consumed as real timestamps) so their comparisons are unaffected
  // by the Postgres switch.
  `CREATE TABLE IF NOT EXISTS oauth_rate_limits (rate_key TEXT NOT NULL, window_start TEXT NOT NULL, request_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(rate_key, window_start))`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, endpoint TEXT NOT NULL, subscription TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'all_interactions', active INTEGER NOT NULL DEFAULT 1, last_success_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(owner_user_id, endpoint))`,
  // access_token/refresh_token hold GitHub credentials and are stored encrypted (see
  // lib/crypto-box.ts), never as plaintext. One connection per user, so re-connecting
  // upserts rather than accumulating stale tokens.
  `CREATE TABLE IF NOT EXISTS github_connections (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL UNIQUE, github_login TEXT NOT NULL DEFAULT '', access_token TEXT NOT NULL, refresh_token TEXT, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  // A matched proposal is stored as an alias rather than a work item on purpose. Making
  // it a real row would give it a status and a version, so it would surface in board
  // queries, counts, list_work_items, and the dependency graph, and every one of those
  // call sites would need a filter forever. Provenance is preserved either way.
  `CREATE TABLE IF NOT EXISTS work_item_aliases (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, work_item_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', source_id TEXT, interaction_id TEXT, match_score REAL NOT NULL DEFAULT 0, match_method TEXT NOT NULL DEFAULT 'fingerprint', match_reason TEXT NOT NULL DEFAULT '', confirmed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_aliases_item ON work_item_aliases(work_item_id, created_at)`,
  // One press of Simplify. Findings persist rather than being computed and thrown away
  // so that a connected agent can attach its own to the same run, and so that applying
  // one is auditable after the fact.
  `CREATE TABLE IF NOT EXISTS simplification_runs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', requested_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_simplification_runs_project ON simplification_runs(project_id, created_at)`,
  // proposed_command is a lib/contracts.ts Command, so applying a finding runs the same
  // executeCommand path as everything else instead of a second write path that could
  // drift from it. agreed_by accumulates the agents that independently reported the
  // same finding, mirroring how work items accumulate corroborating providers.
  `CREATE TABLE IF NOT EXISTS simplification_findings (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, work_item_id TEXT, related_work_item_id TEXT, verdict TEXT NOT NULL DEFAULT 'possible', reason TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', proposed_command TEXT, origin TEXT NOT NULL DEFAULT 'matcher', agreed_by TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open', dedupe_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(run_id, dedupe_key))`,
  `CREATE INDEX IF NOT EXISTS idx_simplification_findings_run ON simplification_findings(run_id, created_at)`,
  // Asking a specific connected agent to report everything it knows for a project.
  // Resolved two ways (lib/store.ts): the agent's own next register_agent_session call
  // surfaces it, or a create_work_items batch naming it as import_request_id closes it
  // directly. The partial unique index is what makes re-clicking "Import from Codex"
  // reuse the open request instead of piling up duplicates.
  `CREATE TABLE IF NOT EXISTS import_requests (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, source_id TEXT NOT NULL, requested_by TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reported_count INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_import_requests_open ON import_requests(project_id, source_id) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_import_requests_org ON import_requests(organization_id, status)`,
  // The blocking index for duplicate matching. Candidates used to be retrieved by
  // recency, which silently dropped the oldest completed work — precisely the candidates
  // DEDUPLICATION_ARCHITECTURE.md §5 argues are worth the most, since matching against
  // finished work prevents redundant work rather than a redundant card. Artifacts are the
  // right retrieval axis: age-independent, and already extracted for every item.
  `CREATE TABLE IF NOT EXISTS work_item_artifacts (organization_id TEXT NOT NULL, project_id TEXT NOT NULL, work_item_id TEXT NOT NULL, artifact TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'other', PRIMARY KEY (project_id, artifact, work_item_id))`,
  `CREATE INDEX IF NOT EXISTS idx_item_artifacts_item ON work_item_artifacts(work_item_id)`,
  // E1's second retriever (RECONCILIATION_ARCHITECTURE.md §5): the same signature the
  // artifact index reads (lib/dedup/signature.ts) already extracts stemmed, stopword-free
  // object tokens for every item — this indexes them the same way artifacts are indexed,
  // so a proposal with distinctive wording but no concrete file/endpoint reference (a
  // paraphrase, or work described only by what it does) still has something to retrieve
  // on. Document frequency for IDF weighting is computed at query time via
  // COUNT(DISTINCT work_item_id), never stored, so it always reflects the corpus as it
  // exists right now rather than a frequency snapshot that could drift stale.
  `CREATE TABLE IF NOT EXISTS work_item_tokens (organization_id TEXT NOT NULL, project_id TEXT NOT NULL, work_item_id TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY (project_id, token, work_item_id))`,
  `CREATE INDEX IF NOT EXISTS idx_item_tokens_item ON work_item_tokens(work_item_id)`,
  // E5's static embedding tier (RECONCILIATION_ARCHITECTURE.md §6/§6.1, "Route A — vectors
  // in Postgres"). `vector` ships with every managed Postgres host this app has run on
  // (Neon, Supabase) and with @electric-sql/pglite's bundled vector extension (tests,
  // loaded in tests/support/local-pg.mjs) — all speak the same pgvector SQL, so this
  // schema and every query against it run unmodified across them.
  `CREATE EXTENSION IF NOT EXISTS vector`,
  // The distilled model's own lookup table: one row per vocabulary token, shared and
  // read-only across every organization — it is model data, not tenant data, the same way
  // a stopword list would be. `weight` is the Zipf/PCA weighting §6 says is "baked in at
  // distillation time" for the real model; defaults to 1 so a naive seed (equal weighting)
  // still produces a valid, if less accurate, mean pool. Empty in this environment: the
  // real ~8 MB potion-base-8M table has to be loaded by a deploy step or migration this
  // milestone does not include (RECONCILIATION_ARCHITECTURE.md's own build-status note
  // explains why — no way to fetch or fabricate real distilled weights in this sandbox).
  // An empty table is not a broken feature: `computeEmbedding` (lib/dedup/embedding.ts)
  // returns `null` when none of an item's tokens have a row here, which the blocking
  // retriever and Stage 2's f8 feature already treat as a normal missing observation, so
  // the whole tier is inert — not wrong, just contributing nothing — until it's populated.
  `CREATE TABLE IF NOT EXISTS token_vectors (token TEXT PRIMARY KEY, vec vector(256) NOT NULL, weight REAL NOT NULL DEFAULT 1)`,
  // One mean-pooled embedding per work item, the input to pgvector ANN search. Composite
  // primary key matches every other per-item index table in this file (work_item_artifacts,
  // work_item_tokens) for the same reason: project-scoped uniqueness, not a global one.
  // HNSW over cosine distance is what §6.1 calls out by name ("serves 1M vectors in
  // 5-20ms") — created unconditionally here since every Postgres host this schema targets
  // and PGlite's bundled extension support it; an empty table costs nothing to index.
  `CREATE TABLE IF NOT EXISTS work_item_embeddings (organization_id TEXT NOT NULL, project_id TEXT NOT NULL, work_item_id TEXT NOT NULL, embedding vector(256) NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (project_id, work_item_id))`,
  `CREATE INDEX IF NOT EXISTS idx_item_embeddings_ann ON work_item_embeddings USING hnsw (embedding vector_cosine_ops)`,
  // The golden set for the reconciliation engine (RECONCILIATION_ARCHITECTURE.md E0):
  // labels the product already generates as a side effect of normal use. A human merging
  // two items is a positive label; splitting a wrong match, or dismissing a Simplify
  // duplicate finding, is a negative one. `features` freezes the matcher's own
  // adjudication (score, method, reason, both signatures) at the moment of the label, so a
  // label stays interpretable after the scorer that produced it changes. `pair_hash` is
  // order-independent so a merge and a later split of the same two items don't collide.
  `CREATE TABLE IF NOT EXISTS reconciliation_labels (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, pair_hash TEXT NOT NULL, left_item_id TEXT NOT NULL, right_item_id TEXT NOT NULL, verdict TEXT NOT NULL, confidence TEXT NOT NULL DEFAULT 'high', label_source TEXT NOT NULL, features TEXT NOT NULL DEFAULT '{}', justification TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (project_id, pair_hash, label_source))`,
  `CREATE INDEX IF NOT EXISTS idx_reconciliation_labels_project ON reconciliation_labels(project_id, created_at)`,
  // E6 — Tier A, the connected-agent judgment tier (RECONCILIATION_ARCHITECTURE.md §9).
  // A pending question raised when Stage 2 lands a proposal in the ambiguous band
  // (verdict 'possible'): the item is still created either way (§9 doesn't change the
  // asymmetric-error rule — an unresolved judgment is never grounds to withhold a task),
  // but the agent is handed a precise question about the specific candidate instead of
  // just a passive "resembles" note. `UNIQUE(project_id, left_item_id, right_item_id)`
  // is deliberately ordered, not pair-hashed like reconciliation_labels: a judgment
  // request always names a real "new item" and a real "existing candidate," a direction
  // that matters for the question's own wording, unlike a label which is about the pair.
  `CREATE TABLE IF NOT EXISTS reconciliation_judgment_requests (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, left_item_id TEXT NOT NULL, right_item_id TEXT NOT NULL, question TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open', requested_by_source_id TEXT, answered_verdict TEXT, answered_justification TEXT, answered_by_source_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), answered_at TIMESTAMPTZ, UNIQUE (project_id, left_item_id, right_item_id))`,
  `CREATE INDEX IF NOT EXISTS idx_judgment_requests_project_status ON reconciliation_judgment_requests(project_id, status)`,
  // The plan operation log (PLAN_VERSION_CONTROL.md M25). Additive and observational: the
  // existing tables above remain the source of truth and the only thing any read path in
  // the product actually depends on today. This is the append-only history layer beside
  // them — hash is content-addressed (lib/ops/hash.ts), so the same logical change
  // submitted twice collapses to one row with no idempotency key needed at this layer.
  // `parents` is the operation's position in the partial order: for the single 'canonical'
  // branch this milestone builds, that is always the branch's prior head, so in ordinary,
  // non-concurrent use the log is a linear chain; the column stays plural because a real
  // concurrent write is a genuine fork, not an error, and the schema must be able to say so
  // without a migration later.
  // Uniqueness is scoped to (project_id, hash), not to hash alone. The hash formula
  // itself (lib/ops/hash.ts) deliberately omits project_id, matching
  // PLAN_VERSION_CONTROL.md §3's `sha256(type ‖ canonical(payload) ‖ sorted(parents))` —
  // but git gets away with an equally project-agnostic commit hash only because each
  // repository is its own separate object store; two unrelated repos' commits never share
  // a keyspace. This table is one shared keyspace across every project, so without the
  // project_id half of the key, two different projects' first-ever op (empty parents) can
  // legitimately have identical type and payload — "propose task X" in two unrelated
  // projects — and would silently collide on a bare `hash` primary key, with the second
  // project's op discarded by ON CONFLICT DO NOTHING. Composite key keeps the hash formula
  // exactly as specified while making that collision impossible.
  `CREATE TABLE IF NOT EXISTS plan_ops (hash TEXT NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, parents TEXT[] NOT NULL DEFAULT '{}', author_kind TEXT NOT NULL, author_name TEXT NOT NULL, source_id TEXT, branch TEXT NOT NULL DEFAULT 'canonical', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (project_id, hash))`,
  `CREATE INDEX IF NOT EXISTS idx_plan_ops_project_branch ON plan_ops(project_id, branch, created_at)`,
  // One row per (project, branch): the frontier op(s) new writes chain onto. Updated
  // inside an advisory-locked transaction (lib/ops/log.ts:appendPlanOp) so concurrent
  // writers serialize onto a correct parent rather than racing.
  `CREATE TABLE IF NOT EXISTS plan_refs (project_id TEXT NOT NULL, name TEXT NOT NULL, head TEXT[] NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (project_id, name))`,
  // Conflicts as first-class objects (PLAN_VERSION_CONTROL.md §1, the Pijul property):
  // a conflict is a legitimate state two operations put the plan in, not a merge failure,
  // and its resolution is recorded against the specific pair so the same conflict cannot
  // reopen later. Still schema-only: E4 (RECONCILIATION_ARCHITECTURE.md) shipped the
  // reconciliation engine's CONFLICT relation type, but it raises a decision through
  // `decision_options` below (two work items, not two plan_ops) — this table is keyed on
  // `op_a`/`op_b` specifically for conflicts *between operations in the plan log*
  // (PLAN_VERSION_CONTROL.md's own concurrent-write conflicts), a different, still-unbuilt
  // detection path this table remains reserved for.
  `CREATE TABLE IF NOT EXISTS plan_conflicts (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, op_a TEXT NOT NULL, op_b TEXT NOT NULL, subject_work_item_id TEXT, decision_work_item_id TEXT, state TEXT NOT NULL DEFAULT 'open', resolved_by_op TEXT, resolution TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ, UNIQUE (project_id, op_a, op_b))`,
  `CREATE INDEX IF NOT EXISTS idx_plan_conflicts_project_state ON plan_conflicts(project_id, state)`,
  // M19 — decisions and conflicts. A decision is an ordinary work_item with type =
  // 'decision'; this table is only the options being weighed, each optionally pointing at
  // a real work item when the option is "do the work already proposed as #N" rather than a
  // free-text alternative nobody has proposed as a task yet. Deliberately not routed
  // through plan_conflicts (op_a/op_b): that table is reserved for conflicts between two
  // plan *operations* (still unbuilt); a manually or agent-raised decision is a simpler,
  // human-facing "choose one of these" that doesn't need two specific colliding ops to
  // point at. E4 (RECONCILIATION_ARCHITECTURE.md) is what populates this table
  // automatically now: a proposal whose Stage 3 relation is CONFLICT (opposite intent on
  // the same concrete artifact — lib/dedup/relations.ts) raises a decision here with the
  // new item and the existing one as its two options
  // (lib/planning/decisions.ts:raiseConflictDecisions), on top of the manual/agent-flagged
  // path this table already supported.
  `CREATE TABLE IF NOT EXISTS decision_options (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, decision_work_item_id TEXT NOT NULL, label TEXT NOT NULL, related_work_item_id TEXT, rationale TEXT NOT NULL DEFAULT '', proposed_by_source_id TEXT, status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_decision_options_decision ON decision_options(decision_work_item_id)`,
  // M15 — repository observations via the bridge. One row per commit actually reported,
  // never per file: paths and commit metadata only, matching the bridge's existing "never
  // opens provider transcript files" promise. UNIQUE(project_id, head_sha) is what makes
  // reporting the same commit twice (a retried hook call, or two sessions on one branch) a
  // no-op rather than a duplicate observation or duplicate evidence.
  // deleted_paths (M17): the subset of changed_paths git reported as removed or renamed
  // away, kept separate from changed_paths because "touched" and "no longer exists under
  // this name" need different downstream handling (M15's evidence attachment vs M17's
  // evidence_removed finding) and diff --name-status is the only source that tells them
  // apart from a plain path list.
  `CREATE TABLE IF NOT EXISTS repo_observations (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, source_id TEXT, head_sha TEXT NOT NULL, branch TEXT, changed_paths TEXT NOT NULL DEFAULT '[]', deleted_paths TEXT NOT NULL DEFAULT '[]', verification_command TEXT, verification_exit_code INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (project_id, head_sha))`,
  `CREATE INDEX IF NOT EXISTS idx_repo_observations_project ON repo_observations(project_id, created_at DESC)`,
  // E7 — repository grounding, Level 1 (RECONCILIATION_ARCHITECTURE.md §7), scoped to
  // TypeScript/JavaScript: the bridge's own optional tree-sitter parse
  // (integrations/bridge/symbols.mjs), reported alongside repo_observations at the same
  // turn boundary. One row per (project, file, symbol name) — a symbol table, not a log —
  // so a repeated report of the same file naturally upserts (`ON CONFLICT` in the
  // ingestion statement) rather than accumulating stale duplicates of a function that
  // hasn't moved. `line` is best-effort location, not a stable identity: it drifts as a
  // file is edited above the symbol, and the primary key deliberately does not include it.
  `CREATE TABLE IF NOT EXISTS repo_symbols (organization_id TEXT NOT NULL, project_id TEXT NOT NULL, file TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (project_id, file, symbol))`,
  `CREATE INDEX IF NOT EXISTS idx_repo_symbols_project_symbol ON repo_symbols(project_id, symbol)`,
  // Provider-neutral OAuth grants. One grant can expose several Basecamp accounts or
  // Jira sites, so account/site selection belongs to a project binding rather than the
  // connection. Both tokens are AES-GCM sealed by lib/crypto-box.ts before storage.
  `CREATE TABLE IF NOT EXISTS integration_connections (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, provider TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', access_token TEXT NOT NULL, refresh_token TEXT, access_token_expires_at TIMESTAMPTZ, granted_scopes TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'connected', last_success_at TIMESTAMPTZ, last_error_code TEXT, last_error_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(owner_user_id, provider))`,
  `CREATE INDEX IF NOT EXISTS idx_integration_connections_org_provider ON integration_connections(organization_id, provider)`,
  // OAuth state is stored as a digest so a database read cannot mint a valid callback.
  // project_id is the project whose integration dialog initiated the connection and is
  // used only to return the browser to the right place after consent.
  `CREATE TABLE IF NOT EXISTS integration_oauth_states (state_hash TEXT PRIMARY KEY, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, provider TEXT NOT NULL, project_id TEXT, redirect_uri TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_integration_oauth_states_expiry ON integration_oauth_states(expires_at)`,
  // A binding selects one concrete external project/container for one Planbraid project.
  // The callback secret is both sealed (needed to recreate provider registrations) and
  // hashed (constant-time verification of inbound callback paths without decryption).
  `CREATE TABLE IF NOT EXISTS integration_bindings (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, connection_id TEXT NOT NULL, provider TEXT NOT NULL, external_account_id TEXT NOT NULL, external_account_name TEXT NOT NULL DEFAULT '', external_project_id TEXT NOT NULL, external_project_key TEXT, external_project_name TEXT NOT NULL, external_base_url TEXT NOT NULL, filter_query TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '{}', webhook_id TEXT, webhook_secret TEXT NOT NULL, webhook_secret_hash TEXT NOT NULL, webhook_expires_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'active', last_sync_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ, last_error_code TEXT, last_error_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(project_id, provider, external_account_id, external_project_id))`,
  `CREATE INDEX IF NOT EXISTS idx_integration_bindings_project ON integration_bindings(project_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_integration_bindings_connection ON integration_bindings(connection_id, status)`,
  // Canonical provider snapshots live separately from accepted Planbraid work. A changed
  // provider snapshot reopens review; it never silently overwrites a work item.
  `CREATE TABLE IF NOT EXISTS external_items (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, binding_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL, external_key TEXT, item_type TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', external_status TEXT NOT NULL DEFAULT '', normalized_status TEXT NOT NULL DEFAULT 'proposed', priority TEXT NOT NULL DEFAULT 'normal', assignee TEXT, due_at TIMESTAMPTZ, parent_external_id TEXT, canonical_url TEXT NOT NULL DEFAULT '', external_revision TEXT, content_hash TEXT NOT NULL, normalized_snapshot TEXT NOT NULL DEFAULT '{}', raw_snapshot TEXT NOT NULL DEFAULT '{}', review_status TEXT NOT NULL DEFAULT 'pending', tombstoned_at TIMESTAMPTZ, first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(binding_id, external_id))`,
  `CREATE INDEX IF NOT EXISTS idx_external_items_binding_review ON external_items(binding_id, review_status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_external_items_project ON external_items(project_id, provider)`,
  `CREATE TABLE IF NOT EXISTS work_item_external_links (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, binding_id TEXT NOT NULL, external_item_id TEXT NOT NULL, work_item_id TEXT NOT NULL, link_kind TEXT NOT NULL DEFAULT 'imported', last_applied_hash TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(external_item_id), UNIQUE(binding_id, work_item_id, external_item_id))`,
  `CREATE INDEX IF NOT EXISTS idx_external_links_work_item ON work_item_external_links(work_item_id)`,
  // Webhook endpoints acknowledge after this durable insert. Redeliveries collapse on
  // delivery_key; processing failures remain visible and can be replayed by a later sync.
  `CREATE TABLE IF NOT EXISTS integration_webhook_inbox (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, binding_id TEXT NOT NULL, provider TEXT NOT NULL, delivery_key TEXT NOT NULL, payload_hash TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ, last_error TEXT, received_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ, UNIQUE(binding_id, delivery_key))`,
  `CREATE INDEX IF NOT EXISTS idx_integration_webhook_pending ON integration_webhook_inbox(status, next_attempt_at, received_at)`,
  // Outbound effects are introduced with the same durable/idempotent contract even
  // though Basecamp/Jira begin read-only. Webhook registration and future write-back use
  // this table instead of coupling provider availability to a domain transaction.
  `CREATE TABLE IF NOT EXISTS integration_outbox (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, binding_id TEXT, provider TEXT NOT NULL, effect_key TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ, provider_response_id TEXT, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ, UNIQUE(provider, effect_key))`,
  `CREATE INDEX IF NOT EXISTS idx_integration_outbox_pending ON integration_outbox(status, next_attempt_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS integration_sync_runs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, binding_id TEXT NOT NULL, provider TEXT NOT NULL, run_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', cursor TEXT, fetched_count INTEGER NOT NULL DEFAULT 0, changed_count INTEGER NOT NULL DEFAULT 0, tombstoned_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, error_summary TEXT, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ)`,
  `CREATE INDEX IF NOT EXISTS idx_integration_sync_runs_binding ON integration_sync_runs(binding_id, started_at DESC)`,
  // Slack/Teams are a publish destination, not an import source, so their binding shape
  // is genuinely different from integration_bindings (one external project per binding):
  // scope_type lets one channel receive either one project's updates or a portfolio feed
  // across every current-and-future eligible project, with project_id NULL only for the
  // latter. excluded_project_ids is how an all_projects binding opts specific projects
  // out; event_types is the per-binding delivery-toggle set from the settings UI.
  `CREATE TABLE IF NOT EXISTS integration_channel_bindings (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, connection_id TEXT NOT NULL, provider TEXT NOT NULL, scope_type TEXT NOT NULL DEFAULT 'project', project_id TEXT, external_channel_id TEXT NOT NULL, external_channel_name TEXT NOT NULL DEFAULT '', excluded_project_ids TEXT NOT NULL DEFAULT '[]', event_types TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', last_success_at TIMESTAMPTZ, last_error_code TEXT, last_error_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK (scope_type IN ('project', 'all_projects')), CHECK ((scope_type = 'project') = (project_id IS NOT NULL)))`,
  `CREATE INDEX IF NOT EXISTS idx_channel_bindings_project ON integration_channel_bindings(project_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_channel_bindings_org_scope ON integration_channel_bindings(organization_id, scope_type, status)`,
  `CREATE INDEX IF NOT EXISTS idx_channel_bindings_connection ON integration_channel_bindings(connection_id, status)`,
] as const;

/**
 * Additive column migrations. Postgres supports `ADD COLUMN IF NOT EXISTS` natively
 * (unlike SQLite/D1), so these no longer need the try/catch-per-statement guard the
 * D1 version required — kept anyway as a harmless belt-and-suspenders wrapper below.
 */
export const MIGRATION_STATEMENTS = [
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS content_fingerprint TEXT`,
  // Count of unresolved hard-dependency prerequisites (DAG_EDGE_TYPES), maintained
  // incrementally on every dependency write and status transition. See
  // GRAPH_ARCHITECTURE.md §4 — this is what lets a blocked item become ready on its
  // own instead of the status just going stale once its blocker finishes.
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS blocking_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS unblocked_at TIMESTAMPTZ`,
  // Which of the owner's agent logins wrote this, resolved server-side from the
  // credential and the optional ?agent= marker rather than from the free-form provider
  // string an agent types. Two CLI aliases for the same model (claude-personal,
  // claude-work) are otherwise indistinguishable. See lib/providers.ts's agentAccountKey.
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS agent_account_id TEXT`,
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS agent_account_label TEXT`,
  // Per-connection rename. Kept off oauth_clients because every Claude Code install
  // self-registers under the same client_name, so renaming the client would rename
  // every connection made from that client at once.
  `ALTER TABLE oauth_token_families ADD COLUMN IF NOT EXISTS label TEXT`,
  // The item a merge archived. split_alias restores that exact item (and its key)
  // instead of minting a new one, so undoing a wrong merge returns the board to where
  // it was rather than leaving a differently-numbered copy behind.
  `ALTER TABLE work_item_aliases ADD COLUMN IF NOT EXISTS archived_work_item_id TEXT`,
  // NULL means "not yet in work_item_artifacts". Items written before the index existed
  // are backfilled lazily from the dedup read path (lib/dedup/artifacts.ts); the column
  // is what keeps an item with genuinely zero artifacts from being rescanned forever.
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS artifacts_indexed_at TIMESTAMPTZ`,
  // E5's own "already indexed" flag, deliberately separate from artifacts_indexed_at
  // rather than reusing it. E1's own bug (see blocking.ts) was two passes that both need
  // to run for *correctness*, coupled to one flag, so the second silently found nothing
  // left to do. Embeddings are different: `token_vectors` is empty in this environment
  // (see its own schema comment) and possibly always empty in a deployment that never
  // loads the real distilled table, so an item that never gets an embedding is the
  // expected steady state, not starvation — the artifact/token retrievers still work
  // fully via RRF fusion either way. Giving this its own flag keeps a permanently-needed
  // index (artifacts/tokens) from ever being coupled to an optional one's completion.
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS embeddings_indexed_at TIMESTAMPTZ`,
  // E6: which provider family answered a Tier A judgment, nullable since the merge/
  // split/dismissal label sources this column also applies to (retroactively, if ever
  // backfilled) don't carry one today. §9's own audit rule — "track judgment-vs-later-
  // human-split agreement per provider; if a provider's judgments disagree with humans,
  // down-weight them" — needs to group by this, so it has to live on the label row
  // itself rather than be re-derived by joining through sources at query time (a
  // judgment's source may itself be deleted or renamed long after the label is what
  // matters).
  `ALTER TABLE reconciliation_labels ADD COLUMN IF NOT EXISTS provider_family TEXT`,
  // Planning maturity, orthogonal to status. `status` says how far along the work is;
  // `maturity` says whether it is work at all yet or still something an agent said out
  // loud. Existing rows default to 'accepted' on purpose: they predate the distinction
  // and were all treated as real work, so defaulting them to 'proposal' would empty every
  // board on deploy. See PLANNING_INTELLIGENCE_ROADMAP.md D1.
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS maturity TEXT NOT NULL DEFAULT 'accepted'`,
  // Why a terminal item ended the way it did. Meaningful only for done/cancelled, and the
  // reason 'cancelled' alone was never enough: deferred, rejected, superseded and
  // abandoned are four different futures.
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS resolution TEXT`,
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS resolution_reason TEXT`,
  // Deferral with a date, so "not now" stops being indistinguishable from "abandoned".
  // An open item deferred into the future is excluded from ready work until it passes.
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS deferred_until TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS idx_work_items_maturity ON work_items(project_id, maturity)`,
  // Per-project policy, as JSON text like every other structured column here. Currently
  // holds only gateProposals, which decides whether unaccepted proposals are kept off the
  // board — shipped off, so nothing changes for an existing project until it is turned on.
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS settings TEXT NOT NULL DEFAULT '{}'`,
  // How a claim was learned, not merely who wrote it. Nullable on purpose: events written
  // before this column existed genuinely have no recorded provenance, and defaulting them
  // to a class would assert something nobody said. See lib/trust/provenance.ts.
  `ALTER TABLE work_events ADD COLUMN IF NOT EXISTS provenance TEXT`,
  `ALTER TABLE work_events ADD COLUMN IF NOT EXISTS reason TEXT`,
  // The provenance behind the item's *current* status, denormalized so the common read
  // ("how much should I believe this is done") costs no event scan.
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS status_provenance TEXT`,
  // F7, settled: dropped rather than kept dormant. Safe on a live database because no
  // INSERT or UPDATE anywhere in the codebase's history ever set this column — it is NULL
  // for every row that exists, in every deployment, so nothing is lost.
  `ALTER TABLE work_items DROP COLUMN IF EXISTS parent_id`,
  // The credential (mcp_tokens.id or the oauth token family id — the same id
  // principalFromBearer already derives agentAccountId from, and the same id the Setup
  // dialog's connection list renames/revokes) that registered this source. Enforcing
  // project access has to bind to this, not to agent_account_id: the ?agent= marker
  // folded into agent_account_id is caller-supplied text with nothing behind it, so a
  // block keyed on the marker alone is bypassable just by connecting again under a
  // different marker with the same underlying credential. Nullable: sessions registered
  // before this column existed have no recorded credential and can't be blocked until
  // they reconnect.
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS credential_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_sources_credential ON sources(credential_id)`,
  // A real per-project access boundary, separate from sources.status. sources.status is
  // just bookkeeping an agent's own heartbeat overwrites on every register_agent_session
  // call; this table is what apps/web/app/mcp/route.ts actually checks before letting a
  // credential touch a project, so it survives that agent simply reconnecting.
  `CREATE TABLE IF NOT EXISTS project_access_blocks (project_id TEXT NOT NULL, credential_id TEXT NOT NULL, organization_id TEXT NOT NULL, blocked_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (project_id, credential_id))`,
  `CREATE INDEX IF NOT EXISTS idx_project_access_blocks_credential ON project_access_blocks(credential_id)`,
  // Provider identity that doesn't fit the existing columns (Slack's team id/name and bot
  // user id — needed to know which workspace a connection's channel list belongs to, and
  // to render "connected to Acme Corp" without decrypting the token). JSON text like every
  // other structured column here, so a future provider's own identity fields need no
  // schema change.
  `ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS metadata TEXT NOT NULL DEFAULT '{}'`,
] as const;

let initialized = false;

export async function ensureSchema(db: PgD1) {
  if (initialized) return;
  await db.batch(SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)));
  for (const statement of MIGRATION_STATEMENTS) {
    try { await db.prepare(statement).run(); } catch { /* column already present */ }
  }
  initialized = true;
}
