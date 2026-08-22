import type { PgD1 } from "@/db/pg-d1";
import { ensureSchema } from "@/db/setup";
import { openSecret, sealSecret } from "@/lib/crypto-box";
import type { IntegrationConnectionSummary, IntegrationProvider } from "@/lib/integrations/types";
import { INTEGRATION_PROVIDERS } from "@/lib/integrations/types";
import { integrationId, parseJson, randomSecret, sha256 } from "@/lib/integrations/utils";
import { organizationFor, type Principal } from "@/lib/store";
import { guestIntegrationsDisabledError } from "@/lib/guest";

type Row = Record<string, unknown>;

export function integrationProvider(value: string): IntegrationProvider {
  if (!INTEGRATION_PROVIDERS.includes(value as IntegrationProvider)) throw domainError("UNKNOWN_PROVIDER", "Unknown integration provider", 404);
  return value as IntegrationProvider;
}

const PROVIDER_ENV_PREFIX: Record<IntegrationProvider, string> = { basecamp: "BASECAMP", jira: "JIRA", slack: "SLACK" };
const PROVIDER_LABEL: Record<IntegrationProvider, string> = { basecamp: "Basecamp", jira: "Jira", slack: "Slack" };
export const JIRA_OAUTH_SCOPES = ["read:jira-work", "read:jira-user", "manage:jira-webhook", "offline_access"] as const;

export function providerConfigured(provider: IntegrationProvider) {
  const prefix = PROVIDER_ENV_PREFIX[provider];
  const hasClient = Boolean(process.env[`${prefix}_CLIENT_ID`]?.trim() && process.env[`${prefix}_CLIENT_SECRET`]?.trim());
  // Slack additionally needs a signing secret to verify inbound Events API deliveries;
  // without it the app could receive webhooks it cannot authenticate, so it is treated
  // as part of "configured" rather than a separate, easy-to-forget check.
  return provider === "slack" ? hasClient && Boolean(process.env.SLACK_SIGNING_SECRET?.trim()) : hasClient;
}

export function providerConfig(provider: IntegrationProvider) {
  const prefix = PROVIDER_ENV_PREFIX[provider];
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim();
  if (!clientId || !clientSecret) throw domainError("NOT_CONFIGURED", `${PROVIDER_LABEL[provider]} OAuth is not configured for this deployment`, 503);
  return { clientId, clientSecret };
}

export function providerRedirectUri(provider: IntegrationProvider, request: Request) {
  const configured = process.env[`${PROVIDER_ENV_PREFIX[provider]}_REDIRECT_URI`]?.trim();
  return configured || `${new URL(request.url).origin}/api/integrations/${provider}/callback`;
}

export async function beginProviderOAuth(db: PgD1, principal: Principal, provider: IntegrationProvider, projectId: string | null, request: Request) {
  // A guest sandbox never gets a real OAuth grant: storing a real, long-lived Basecamp/
  // Jira/Slack token against a throwaway anonymous user, and the webhook/App-install
  // that comes with it, would outlive the sandbox itself. See lib/guest.ts's header.
  if (principal.isGuest) throw guestIntegrationsDisabledError();
  await ensureSchema(db);
  const organizationId = await organizationFor(db, principal);
  if (projectId) await requireOwnedProject(db, organizationId, projectId);
  const { clientId } = providerConfig(provider);
  const redirectUri = providerRedirectUri(provider, request);
  const state = randomSecret(32);
  const stateHash = await sha256(state);
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM integration_oauth_states WHERE expires_at < now() OR used_at IS NOT NULL"),
    db.prepare("INSERT INTO integration_oauth_states (state_hash, organization_id, owner_user_id, provider, project_id, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(stateHash, organizationId, principal.userId, provider, projectId, redirectUri, expiresAt),
  ]);

  if (provider === "basecamp") {
    const url = new URL("https://launchpad.37signals.com/authorization/new");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  if (provider === "slack") {
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    // Bot scopes only (no user_scope): posting always happens as the bot, never as the
    // installing person, so there is no per-user token to request or store. `commands`
    // is for the /planbraid slash command; message shortcuts need no scope of their own
    // (Slack pushes the clicked message's content directly in the interaction payload,
    // so this never reads channel history - see slack-import.ts's file comment).
    url.searchParams.set("scope", "chat:write,chat:write.public,channels:read,groups:read,team:read,commands");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  const url = new URL("https://auth.atlassian.com/authorize");
  url.searchParams.set("audience", "api.atlassian.com");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", JIRA_OAUTH_SCOPES.join(" "));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function consumeOAuthState(db: PgD1, principal: Principal, provider: IntegrationProvider, state: string) {
  const stateHash = await sha256(state);
  const row = await db.prepare("UPDATE integration_oauth_states SET used_at = now() WHERE state_hash = ? AND provider = ? AND owner_user_id = ? AND used_at IS NULL AND expires_at > now() RETURNING organization_id, project_id, redirect_uri")
    .bind(stateHash, provider, principal.userId).first<Row>();
  if (!row) throw domainError("OAUTH_STATE_INVALID", "The integration authorization request expired or was already used", 400);
  return { organizationId: String(row.organization_id), projectId: row.project_id ? String(row.project_id) : null, redirectUri: String(row.redirect_uri) };
}

export async function saveConnection(db: PgD1, input: {
  organizationId: string;
  ownerUserId: string;
  provider: IntegrationProvider;
  label: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
  metadata?: Record<string, unknown>;
}) {
  const id = integrationId("icn");
  const row = await db.prepare("INSERT INTO integration_connections (id, organization_id, owner_user_id, provider, label, access_token, refresh_token, access_token_expires_at, granted_scopes, metadata, status, last_success_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', now()) ON CONFLICT (owner_user_id, provider) DO UPDATE SET organization_id = excluded.organization_id, label = excluded.label, access_token = excluded.access_token, refresh_token = COALESCE(excluded.refresh_token, integration_connections.refresh_token), access_token_expires_at = excluded.access_token_expires_at, granted_scopes = excluded.granted_scopes, metadata = excluded.metadata, status = 'connected', last_success_at = now(), last_error_code = NULL, last_error_at = NULL, updated_at = now() RETURNING id")
    .bind(id, input.organizationId, input.ownerUserId, input.provider, input.label.slice(0, 120), await sealSecret(input.accessToken), input.refreshToken ? await sealSecret(input.refreshToken) : null, input.expiresAt, JSON.stringify(input.scopes), JSON.stringify(input.metadata ?? {})).first<{ id: string }>();
  if (!row) throw domainError("CONNECTION_SAVE_FAILED", "The integration connection could not be stored", 500);
  return row.id;
}

export async function connectionCredentials(db: PgD1, connectionId: string) {
  const row = await db.prepare("SELECT * FROM integration_connections WHERE id = ? AND status <> 'disconnected'").bind(connectionId).first<Row>();
  if (!row) throw domainError("CONNECTION_NOT_FOUND", "Integration connection not found", 404);
  const accessToken = await openSecret(String(row.access_token));
  const refreshToken = row.refresh_token ? await openSecret(String(row.refresh_token)) : null;
  if (!accessToken) throw domainError("PROVIDER_RECONNECT_REQUIRED", "The integration credential can no longer be decrypted; reconnect it", 401);
  return {
    id: String(row.id), organizationId: String(row.organization_id), ownerUserId: String(row.owner_user_id),
    provider: integrationProvider(String(row.provider)), label: String(row.label), accessToken, refreshToken,
    expiresAt: row.access_token_expires_at ? String(row.access_token_expires_at) : null,
    scopes: parseJson<string[]>(row.granted_scopes, []), status: String(row.status),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
  };
}

export async function replaceConnectionTokens(db: PgD1, connectionId: string, accessToken: string, refreshToken: string | null, expiresAt: string | null, scopes?: string[]) {
  await db.prepare("UPDATE integration_connections SET access_token = ?, refresh_token = COALESCE(?, refresh_token), access_token_expires_at = ?, granted_scopes = COALESCE(?, granted_scopes), status = 'connected', last_success_at = now(), last_error_code = NULL, last_error_at = NULL, updated_at = now() WHERE id = ?")
    .bind(await sealSecret(accessToken), refreshToken ? await sealSecret(refreshToken) : null, expiresAt, scopes ? JSON.stringify(scopes) : null, connectionId).run();
}

export async function markConnectionError(db: PgD1, connectionId: string, code: string, reconnect = false) {
  await db.prepare("UPDATE integration_connections SET status = ?, last_error_code = ?, last_error_at = now(), updated_at = now() WHERE id = ?")
    .bind(reconnect ? "reauthorization_required" : "degraded", code.slice(0, 120), connectionId).run();
}

const DEFAULT_LABEL: Record<IntegrationProvider, string> = { basecamp: "Basecamp", jira: "Jira Cloud", slack: "Slack" };

export async function listConnections(db: PgD1, principal: Principal): Promise<IntegrationConnectionSummary[]> {
  const organizationId = await organizationFor(db, principal);
  const result = await db.prepare("SELECT id, provider, label, status, granted_scopes, metadata, last_success_at, last_error_code FROM integration_connections WHERE organization_id = ? AND owner_user_id = ? AND status <> 'disconnected' ORDER BY provider")
    .bind(organizationId, principal.userId).all<Row>();
  const byProvider = new Map(result.results.map((row) => [String(row.provider), row]));
  return INTEGRATION_PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    return {
      id: row ? String(row.id) : "", provider, label: row ? String(row.label) : DEFAULT_LABEL[provider],
      status: row ? String(row.status) : "not_connected", configured: providerConfigured(provider),
      scopes: row ? parseJson<string[]>(row.granted_scopes, []) : [], lastSuccessAt: row?.last_success_at ? String(row.last_success_at) : null,
      lastErrorCode: row?.last_error_code ? String(row.last_error_code) : null,
      metadata: row ? parseJson<Record<string, unknown>>(row.metadata, {}) : {},
    };
  });
}

export async function requireOwnedConnection(db: PgD1, principal: Principal, connectionId: string, provider?: IntegrationProvider) {
  const organizationId = await organizationFor(db, principal);
  const row = await db.prepare("SELECT id, provider FROM integration_connections WHERE id = ? AND organization_id = ? AND owner_user_id = ? AND status <> 'disconnected'")
    .bind(connectionId, organizationId, principal.userId).first<Row>();
  if (!row || (provider && row.provider !== provider)) throw domainError("CONNECTION_NOT_FOUND", "Integration connection not found", 404);
  return { organizationId, provider: integrationProvider(String(row.provider)) };
}

export async function disconnectConnection(db: PgD1, principal: Principal, connectionId: string) {
  const { organizationId } = await requireOwnedConnection(db, principal, connectionId);
  await db.batch([
    db.prepare("UPDATE integration_connections SET status = 'disconnected', access_token = '', refresh_token = NULL, updated_at = now() WHERE id = ? AND organization_id = ?").bind(connectionId, organizationId),
    db.prepare("UPDATE integration_bindings SET status = 'disconnected', updated_at = now() WHERE connection_id = ? AND organization_id = ?").bind(connectionId, organizationId),
    db.prepare("UPDATE integration_channel_bindings SET status = 'disconnected', updated_at = now() WHERE connection_id = ? AND organization_id = ?").bind(connectionId, organizationId),
  ]);
}

export async function requireOwnedProject(db: PgD1, organizationId: string, projectId: string) {
  const row = await db.prepare("SELECT id FROM projects WHERE id = ? AND organization_id = ? AND status = 'active'").bind(projectId, organizationId).first();
  if (!row) throw domainError("PROJECT_NOT_FOUND", "Project not found", 404);
}

export function domainError(code: string, message: string, status = 422, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { code, status, details });
}
