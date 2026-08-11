import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const authUsers = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => [uniqueIndex("uq_auth_user_email").on(table.email)]);

export const authSessions = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  token: text("token").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
}, (table) => [uniqueIndex("uq_auth_session_token").on(table.token), index("idx_auth_session_user").on(table.userId)]);

export const authAccounts = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => [index("idx_auth_account_user").on(table.userId)]);

export const authVerifications = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
}, (table) => [index("idx_auth_verification_identifier").on(table.identifier)]);

export const authRateLimits = sqliteTable("rateLimit", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  count: integer("count").notNull(),
  lastRequest: integer("lastRequest").notNull(),
}, (table) => [uniqueIndex("uq_auth_rate_limit_key").on(table.key)]);

export const authPrincipalLinks = sqliteTable("auth_principal_links", {
  authUserId: text("auth_user_id").primaryKey().references(() => authUsers.id, { onDelete: "cascade" }),
  canonicalUserId: text("canonical_user_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("uq_auth_principal_canonical").on(table.canonicalUserId)]);

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("uq_organizations_owner").on(table.ownerUserId)]);

export const dataMigrations = sqliteTable("data_migrations", {
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  migrationKey: text("migration_key").notNull(),
  appliedAt: text("applied_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("uq_data_migrations_org_key").on(table.organizationId, table.migrationKey)]);

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  key: text("project_key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  directory: text("directory").notNull().default(""),
  gitRemote: text("git_remote"),
  defaultBranch: text("default_branch").notNull().default("main"),
  revision: integer("revision").notNull().default(0),
  status: text("status").notNull().default("active"),
  ...timestamps,
}, (table) => [
  uniqueIndex("uq_projects_org_key").on(table.organizationId, table.key),
  index("idx_projects_org_updated").on(table.organizationId, table.updatedAt),
]);

export const codingSpaces = sqliteTable("coding_spaces", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  fingerprint: text("fingerprint").notNull(),
  label: text("label").notNull(),
  safePath: text("safe_path").notNull(),
  branch: text("branch").notNull().default("main"),
  kind: text("kind").notNull().default("local"),
  status: text("status").notNull().default("online"),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  ...timestamps,
}, (table) => [
  uniqueIndex("uq_spaces_project_fingerprint").on(table.projectId, table.fingerprint),
  index("idx_spaces_project").on(table.projectId),
]);

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  codingSpaceId: text("coding_space_id").references(() => codingSpaces.id),
  provider: text("provider").notNull(),
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  model: text("model"),
  status: text("status").notNull().default("active"),
  assurance: text("assurance").notNull().default("instructed"),
  currentTaskIds: text("current_task_ids").notNull().default("[]"),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  ...timestamps,
}, (table) => [
  uniqueIndex("uq_sources_project_provider_external").on(table.projectId, table.provider, table.externalId),
  index("idx_sources_project_seen").on(table.projectId, table.lastSeenAt),
]);

export const interactions = sqliteTable("interactions", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  sourceId: text("source_id").notNull().references(() => sources.id),
  externalId: text("external_id").notNull(),
  sequence: integer("sequence"),
  status: text("status").notNull().default("started"),
  outcome: text("outcome"),
  summary: text("summary").notNull().default(""),
  reconciliation: text("reconciliation").notNull().default("needs_reconciliation"),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
  ...timestamps,
}, (table) => [
  uniqueIndex("uq_interactions_source_external").on(table.sourceId, table.externalId),
  index("idx_interactions_project_completed").on(table.projectId, table.completedAt),
]);

export const workItems = sqliteTable("work_items", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  sequence: integer("sequence").notNull(),
  itemKey: text("item_key").notNull(),
  parentId: text("parent_id"),
  type: text("type").notNull().default("task"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("proposed"),
  priority: text("priority").notNull().default("normal"),
  assignee: text("assignee"),
  sourceId: text("source_id").references(() => sources.id),
  codingSpaceId: text("coding_space_id").references(() => codingSpaces.id),
  completionConfidence: text("completion_confidence").notNull().default("reported"),
  verificationStatus: text("verification_status").notNull().default("pending"),
  blockerReason: text("blocker_reason"),
  version: integer("version").notNull().default(1),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  archivedAt: text("archived_at"),
  ...timestamps,
}, (table) => [
  uniqueIndex("uq_work_items_project_sequence").on(table.projectId, table.sequence),
  uniqueIndex("uq_work_items_project_key").on(table.projectId, table.itemKey),
  index("idx_work_items_project_status").on(table.projectId, table.status, table.updatedAt),
  index("idx_work_items_source").on(table.sourceId),
]);

export const workEvents = sqliteTable("work_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  projectRevision: integer("project_revision").notNull(),
  workItemId: text("work_item_id").references(() => workItems.id),
  sourceId: text("source_id").references(() => sources.id),
  interactionId: text("interaction_id").references(() => interactions.id),
  actorName: text("actor_name").notNull(),
  eventType: text("event_type").notNull(),
  summary: text("summary").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_events_project_revision").on(table.projectId, table.projectRevision),
  index("idx_events_project_revision").on(table.projectId, table.projectRevision),
  index("idx_events_item_created").on(table.workItemId, table.createdAt),
]);

export const dependencies = sqliteTable("dependencies", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  fromWorkItemId: text("from_work_item_id").notNull().references(() => workItems.id),
  toWorkItemId: text("to_work_item_id").notNull().references(() => workItems.id),
  type: text("type").notNull().default("blocks"),
  reason: text("reason").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_dependencies_edge").on(table.fromWorkItemId, table.toWorkItemId, table.type),
  index("idx_dependencies_to").on(table.toWorkItemId),
]);

export const evidence = sqliteTable("evidence", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  workItemId: text("work_item_id").notNull().references(() => workItems.id),
  type: text("type").notNull(),
  label: text("label").notNull(),
  uri: text("uri"),
  result: text("result"),
  sourceId: text("source_id").references(() => sources.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_evidence_item").on(table.workItemId, table.createdAt)]);

export const workClaims = sqliteTable("work_claims", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull().references(() => workItems.id),
  sourceId: text("source_id").notNull().references(() => sources.id),
  mode: text("mode").notNull().default("exclusive"),
  leaseExpiresAt: text("lease_expires_at").notNull(),
  heartbeatAt: text("heartbeat_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  version: integer("version").notNull().default(1),
}, (table) => [uniqueIndex("uq_claim_item_source").on(table.workItemId, table.sourceId)]);

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  recipientUserId: text("recipient_user_id").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id),
  workItemId: text("work_item_id").references(() => workItems.id),
  sourceId: text("source_id").references(() => sources.id),
  interactionId: text("interaction_id").references(() => interactions.id),
  eventType: text("event_type").notNull(),
  priority: text("priority").notNull().default("normal"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  deepLink: text("deep_link").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  requiresAction: integer("requires_action", { mode: "boolean" }).notNull().default(false),
  readAt: text("read_at"),
  resolvedAt: text("resolved_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_notifications_user_dedupe").on(table.recipientUserId, table.dedupeKey),
  index("idx_notifications_user_read").on(table.recipientUserId, table.readAt, table.createdAt),
]);

export const idempotencyRecords = sqliteTable("idempotency_records", {
  scope: text("scope").notNull(),
  key: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  response: text("response").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("uq_idempotency_scope_key").on(table.scope, table.key)]);

export const mcpTokens = sqliteTable("mcp_tokens", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  scopes: text("scopes").notNull().default("work:read,work:write"),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("uq_mcp_tokens_hash").on(table.tokenHash)]);

export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  clientSecretHash: text("client_secret_hash"),
  clientName: text("client_name").notNull(),
  redirectUris: text("redirect_uris").notNull(),
  grantTypes: text("grant_types").notNull(),
  responseTypes: text("response_types").notNull(),
  tokenAuthMethod: text("token_auth_method").notNull().default("none"),
  clientUri: text("client_uri"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const oauthAuthorizationRequests = sqliteTable("oauth_authorization_requests", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().references(() => oauthClients.id),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  ownerUserId: text("owner_user_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  scopes: text("scopes").notNull(),
  resource: text("resource").notNull(),
  state: text("state"),
  codeChallenge: text("code_challenge").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_oauth_requests_expiry").on(table.expiresAt)]);

export const oauthAuthorizationCodes = sqliteTable("oauth_authorization_codes", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull(),
  clientId: text("client_id").notNull().references(() => oauthClients.id),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  ownerUserId: text("owner_user_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  scopes: text("scopes").notNull(),
  resource: text("resource").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_oauth_codes_hash").on(table.codeHash),
  index("idx_oauth_codes_client_expiry").on(table.clientId, table.expiresAt),
]);

export const oauthTokenFamilies = sqliteTable("oauth_token_families", {
  id: text("id").primaryKey(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const oauthAccessTokens = sqliteTable("oauth_access_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  clientId: text("client_id").notNull().references(() => oauthClients.id),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  ownerUserId: text("owner_user_id").notNull(),
  scopes: text("scopes").notNull(),
  resource: text("resource").notNull(),
  familyId: text("family_id").notNull().references(() => oauthTokenFamilies.id),
  expiresAt: text("expires_at").notNull(),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_oauth_access_hash").on(table.tokenHash),
  index("idx_oauth_access_family").on(table.familyId),
]);

export const oauthRefreshTokens = sqliteTable("oauth_refresh_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  clientId: text("client_id").notNull().references(() => oauthClients.id),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  ownerUserId: text("owner_user_id").notNull(),
  scopes: text("scopes").notNull(),
  resource: text("resource").notNull(),
  familyId: text("family_id").notNull().references(() => oauthTokenFamilies.id),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_oauth_refresh_hash").on(table.tokenHash),
  index("idx_oauth_refresh_family").on(table.familyId),
]);

export const oauthRateLimits = sqliteTable("oauth_rate_limits", {
  rateKey: text("rate_key").notNull(),
  windowStart: text("window_start").notNull(),
  requestCount: integer("request_count").notNull().default(0),
}, (table) => [uniqueIndex("uq_oauth_rate_window").on(table.rateKey, table.windowStart)]);

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  ownerUserId: text("owner_user_id").notNull(),
  endpoint: text("endpoint").notNull(),
  subscription: text("subscription").notNull(),
  mode: text("mode").notNull().default("all_interactions"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  lastSuccessAt: text("last_success_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("uq_push_owner_endpoint").on(table.ownerUserId, table.endpoint)]);
