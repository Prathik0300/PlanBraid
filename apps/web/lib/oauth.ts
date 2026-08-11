import type { PgD1 } from "@/db/pg-d1";
import { ensureSchema } from "@/db/setup";
import { principalFromRequest } from "@/lib/app-principal";
import type { AuthEnvironment } from "@/lib/auth";
import { organizationFor, type Principal } from "@/lib/store";

const SUPPORTED_SCOPES = ["work:read", "work:write"] as const;
const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 60 * 60 * 24 * 30;
const AUTHORIZATION_CODE_SECONDS = 5 * 60;
const AUTHORIZATION_REQUEST_SECONDS = 10 * 60;

type Row = Record<string, unknown>;
type OAuthClient = {
  id: string;
  secretHash: string | null;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
};

export function oauthResourceMetadataUrl(request: Request) {
  return `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
}

export function oauthChallenge(request: Request, scope = SUPPORTED_SCOPES.join(" ")) {
  return `Bearer resource_metadata="${oauthResourceMetadataUrl(request)}", scope="${scope}"`;
}

export async function handleOAuthRoute(request: Request, runtime: AuthEnvironment): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method === "OPTIONS" && ["/register", "/token", "/revoke"].includes(pathname)) return optionsResponse();
  if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp") return protectedResourceMetadata(request);
  if (pathname === "/.well-known/oauth-authorization-server") return authorizationServerMetadata(request);
  if (!["/register", "/authorize", "/token", "/revoke"].includes(pathname)) return null;

  const db = runtime.DB;
  await ensureSchema(db);
  if (pathname === "/register" && request.method === "POST") return registerClient(request, db);
  if (pathname === "/authorize" && request.method === "GET") return beginAuthorization(request, runtime);
  if (pathname === "/authorize" && request.method === "POST") return finishAuthorization(request, runtime);
  if (pathname === "/token" && request.method === "POST") return exchangeToken(request, db);
  if (pathname === "/revoke" && request.method === "POST") return revokeToken(request, db);
  return new Response("Method not allowed", { status: 405, headers: { allow: allowedMethods(pathname) } });
}

function protectedResourceMetadata(request: Request) {
  const origin = new URL(request.url).origin;
  return oauthJson({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Planbraid MCP",
  }, 200, true);
}

function authorizationServerMetadata(request: Request) {
  const origin = new URL(request.url).origin;
  return oauthJson({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    revocation_endpoint: `${origin}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: SUPPORTED_SCOPES,
  }, 200, true);
}

async function registerClient(request: Request, db: PgD1) {
  const limited = await applyRateLimit(db, request, "register", 30);
  if (limited) return limited;
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return oauthError("invalid_client_metadata", "Registration requires application/json", 400);
  const body = await readJson(request, 64_000);
  if (!body) return oauthError("invalid_client_metadata", "Invalid registration document", 400);

  const redirectUris = stringArray(body.redirect_uris);
  if (!redirectUris.length || redirectUris.length > 8 || redirectUris.some((uri) => !validRedirectUri(uri))) {
    return oauthError("invalid_redirect_uri", "redirect_uris must contain valid HTTPS or loopback callback URLs", 400);
  }
  const grantTypes = stringArray(body.grant_types, ["authorization_code", "refresh_token"]);
  const responseTypes = stringArray(body.response_types, ["code"]);
  if (grantTypes.some((value) => !["authorization_code", "refresh_token"].includes(value)) || responseTypes.some((value) => value !== "code")) {
    return oauthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported", 400);
  }
  const requestedMethod = String(body.token_endpoint_auth_method ?? "none");
  if (!["none", "client_secret_post", "client_secret_basic"].includes(requestedMethod)) return oauthError("invalid_client_metadata", "Unsupported token endpoint authentication method", 400);
  const tokenAuthMethod = requestedMethod as OAuthClient["tokenAuthMethod"];
  const clientName = cleanText(body.client_name, "MCP client", 120);
  const clientId = randomToken("rbc", 24);
  const clientSecret = tokenAuthMethod === "none" ? null : randomToken("rbs", 32);
  const now = new Date();
  await db.prepare("INSERT INTO oauth_clients (id, client_secret_hash, client_name, redirect_uris, grant_types, response_types, token_auth_method, client_uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(clientId, clientSecret ? await digest(clientSecret) : null, clientName, JSON.stringify(redirectUris), JSON.stringify(grantTypes), JSON.stringify(responseTypes), tokenAuthMethod, validHttpsUrl(body.client_uri) ? String(body.client_uri) : null, now.toISOString()).run();

  return oauthJson({
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: tokenAuthMethod,
  }, 201);
}

async function beginAuthorization(request: Request, runtime: AuthEnvironment) {
  const db = runtime.DB;
  const url = new URL(request.url);
  const validation = await validateAuthorizationRequest(url, db);
  if (validation instanceof Response) return validation;
  const principal = await requestPrincipal(request, runtime);
  if (!principal) {
    const returnTo = `${url.pathname}${url.search}`;
    return Response.redirect(`${url.origin}/sign-in?returnTo=${encodeURIComponent(returnTo)}`, 302);
  }
  const limited = await applyRateLimit(db, request, "authorize", 120);
  if (limited) return limited;
  const organizationId = await organizationFor(db, principal);
  const requestId = randomToken("oar", 24);
  const expiresAt = new Date(Date.now() + AUTHORIZATION_REQUEST_SECONDS * 1000).toISOString();
  await db.prepare("INSERT INTO oauth_authorization_requests (id, client_id, organization_id, owner_user_id, redirect_uri, scopes, resource, state, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(requestId, validation.client.id, organizationId, principal.userId, validation.redirectUri, validation.scopes.join(" "), validation.resource, validation.state, validation.codeChallenge, expiresAt).run();
  return consentPage(validation.client.name, validation.redirectUri, validation.scopes, requestId, principal);
}

async function finishAuthorization(request: Request, runtime: AuthEnvironment) {
  const db = runtime.DB;
  const principal = await requestPrincipal(request, runtime);
  if (!principal) return oauthHtml("Sign-in required", "Return to your MCP client and start the connection again after signing in to Planbraid.", 401);
  const form = await request.formData().catch(() => null);
  if (!form) return oauthError("invalid_request", "Invalid consent submission", 400);
  const requestId = String(form.get("request_id") ?? "");
  const decision = String(form.get("decision") ?? "deny");
  const row = await db.prepare("SELECT * FROM oauth_authorization_requests WHERE id = ? AND owner_user_id = ? AND used_at IS NULL AND expires_at > ?")
    .bind(requestId, principal.userId, new Date().toISOString()).first<Row>();
  if (!row) return oauthHtml("Request expired", "Return to Claude and start the connection again.", 400);

  const consumed = await db.prepare("UPDATE oauth_authorization_requests SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL RETURNING id").bind(requestId).first();
  if (!consumed) return oauthHtml("Request already used", "Return to Claude and start the connection again.", 400);
  const redirectUri = String(row.redirect_uri);
  const state = nullableString(row.state);
  if (decision !== "approve") return redirectWithParams(redirectUri, { error: "access_denied", error_description: "The user declined Planbraid access", state });

  const code = randomToken("rlc", 32);
  const expiresAt = new Date(Date.now() + AUTHORIZATION_CODE_SECONDS * 1000).toISOString();
  await db.prepare("INSERT INTO oauth_authorization_codes (id, code_hash, client_id, organization_id, owner_user_id, redirect_uri, scopes, resource, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(randomToken("ocd", 18), await digest(code), String(row.client_id), String(row.organization_id), principal.userId, redirectUri, String(row.scopes), String(row.resource), String(row.code_challenge), expiresAt).run();
  return redirectWithParams(redirectUri, { code, state });
}

async function exchangeToken(request: Request, db: PgD1) {
  const limited = await applyRateLimit(db, request, "token", 180);
  if (limited) return limited;
  const form = await readForm(request);
  if (!form) return oauthError("invalid_request", "Token requests must use application/x-www-form-urlencoded", 400);
  const client = await authenticateClient(db, request, form);
  if (client instanceof Response) return client;
  const grantType = form.get("grant_type");
  if (grantType && !client.grantTypes.includes(grantType)) return oauthError("unauthorized_client", "This client is not registered for the requested grant", 400);
  if (grantType === "authorization_code") return exchangeAuthorizationCode(db, form, client, request);
  if (grantType === "refresh_token") return exchangeRefreshToken(db, form, client, request);
  return oauthError("unsupported_grant_type", "Supported grants are authorization_code and refresh_token", 400);
}

async function exchangeAuthorizationCode(db: PgD1, form: URLSearchParams, client: OAuthClient, request: Request) {
  const code = form.get("code") ?? "";
  const row = await db.prepare("SELECT * FROM oauth_authorization_codes WHERE code_hash = ? AND client_id = ?").bind(await digest(code), client.id).first<Row>();
  if (!row || row.used_at || String(row.expires_at) <= new Date().toISOString()) return oauthError("invalid_grant", "Authorization code is invalid or expired", 400);
  if (form.get("redirect_uri") !== String(row.redirect_uri)) return oauthError("invalid_grant", "redirect_uri does not match the authorization request", 400);
  const resource = canonicalResource(request, form.get("resource"));
  if (!resource || resource !== String(row.resource)) return oauthError("invalid_target", "Token resource does not match the MCP server", 400);
  const verifier = form.get("code_verifier") ?? "";
  if (!validCodeVerifier(verifier) || !constantTimeEqual(await pkceChallenge(verifier), String(row.code_challenge))) return oauthError("invalid_grant", "PKCE verification failed", 400);

  const consumed = await db.prepare("UPDATE oauth_authorization_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL RETURNING id").bind(String(row.id)).first();
  if (!consumed) return oauthError("invalid_grant", "Authorization code was already used", 400);
  return issueTokenPair(db, {
    clientId: client.id, organizationId: String(row.organization_id), ownerUserId: String(row.owner_user_id),
    scopes: String(row.scopes), resource: String(row.resource), familyId: randomToken("fam", 18),
  });
}

async function exchangeRefreshToken(db: PgD1, form: URLSearchParams, client: OAuthClient, request: Request) {
  const rawToken = form.get("refresh_token") ?? "";
  const row = await db.prepare("SELECT refresh.*, family.revoked_at AS family_revoked_at FROM oauth_refresh_tokens refresh JOIN oauth_token_families family ON family.id = refresh.family_id WHERE refresh.token_hash = ? AND refresh.client_id = ?").bind(await digest(rawToken), client.id).first<Row>();
  if (!row || String(row.expires_at) <= new Date().toISOString()) return oauthError("invalid_grant", "Refresh token is invalid or expired", 400);
  if (row.revoked_at || row.family_revoked_at) {
    await revokeFamily(db, String(row.family_id));
    return oauthError("invalid_grant", "Refresh token reuse was detected; reconnect Planbraid", 400);
  }
  const resource = canonicalResource(request, form.get("resource"));
  if (!resource || resource !== String(row.resource)) return oauthError("invalid_target", "Token resource does not match the MCP server", 400);
  const requestedScopes = parseScopes(form.get("scope") ?? String(row.scopes));
  const originalScopes = parseScopes(String(row.scopes));
  if (!requestedScopes.length || requestedScopes.some((scope) => !originalScopes.includes(scope))) return oauthError("invalid_scope", "Refresh cannot add permissions", 400);

  const rotated = await db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL RETURNING id").bind(String(row.id)).first();
  if (!rotated) {
    await revokeFamily(db, String(row.family_id));
    return oauthError("invalid_grant", "Refresh token reuse was detected; reconnect Planbraid", 400);
  }
  return issueTokenPair(db, {
    clientId: client.id, organizationId: String(row.organization_id), ownerUserId: String(row.owner_user_id),
    scopes: requestedScopes.join(" "), resource: String(row.resource), familyId: String(row.family_id),
  });
}

async function revokeToken(request: Request, db: PgD1) {
  const form = await readForm(request);
  if (!form) return oauthError("invalid_request", "Revocation requests must use application/x-www-form-urlencoded", 400);
  const client = await authenticateClient(db, request, form);
  if (client instanceof Response) return client;
  const tokenHash = await digest(form.get("token") ?? "");
  const refresh = await db.prepare("SELECT family_id FROM oauth_refresh_tokens WHERE token_hash = ? AND client_id = ?").bind(tokenHash, client.id).first<{ family_id: string }>();
  if (refresh) await revokeFamily(db, refresh.family_id);
  else await db.prepare("UPDATE oauth_access_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND client_id = ?").bind(tokenHash, client.id).run();
  return new Response(null, { status: 200, headers: noStoreHeaders() });
}

async function validateAuthorizationRequest(url: URL, db: PgD1): Promise<{ client: OAuthClient; redirectUri: string; scopes: string[]; resource: string; state: string | null; codeChallenge: string } | Response> {
  if (url.searchParams.get("response_type") !== "code") return oauthError("unsupported_response_type", "Only response_type=code is supported", 400);
  const client = await loadClient(db, url.searchParams.get("client_id") ?? "");
  if (!client) return oauthError("invalid_request", "Unknown OAuth client", 400);
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  if (!client.redirectUris.includes(redirectUri)) return oauthError("invalid_request", "redirect_uri is not registered for this client", 400);
  const scopes = parseScopes(url.searchParams.get("scope") ?? SUPPORTED_SCOPES.join(" "));
  if (!scopes.length || scopes.some((scope) => !SUPPORTED_SCOPES.includes(scope as typeof SUPPORTED_SCOPES[number]))) return redirectWithParams(redirectUri, { error: "invalid_scope", state: url.searchParams.get("state") });
  const resource = canonicalResourceFromUrl(url, url.searchParams.get("resource"));
  if (!resource) return redirectWithParams(redirectUri, { error: "invalid_target", state: url.searchParams.get("state") });
  if ((url.searchParams.get("state") ?? "").length > 2048) return oauthError("invalid_request", "state is too long", 400);
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  if (url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) return redirectWithParams(redirectUri, { error: "invalid_request", error_description: "S256 PKCE is required", state: url.searchParams.get("state") });
  return { client, redirectUri, scopes, resource, state: url.searchParams.get("state"), codeChallenge };
}

async function authenticateClient(db: PgD1, request: Request, form: URLSearchParams): Promise<OAuthClient | Response> {
  const basic = parseBasicAuthorization(request.headers.get("authorization"));
  const clientId = basic?.id ?? form.get("client_id") ?? "";
  const client = await loadClient(db, clientId);
  if (!client) return invalidClient();
  if (client.tokenAuthMethod === "none") return basic ? invalidClient() : client;
  const secret = basic?.secret ?? form.get("client_secret") ?? "";
  if ((client.tokenAuthMethod === "client_secret_basic" && !basic) || (client.tokenAuthMethod === "client_secret_post" && basic) || !secret || !client.secretHash || !constantTimeEqual(await digest(secret), client.secretHash)) return invalidClient();
  return client;
}

async function loadClient(db: PgD1, clientId: string): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 200) return null;
  const row = await db.prepare("SELECT * FROM oauth_clients WHERE id = ? AND revoked_at IS NULL").bind(clientId).first<Row>();
  if (!row) return null;
  return {
    id: String(row.id), secretHash: nullableString(row.client_secret_hash), name: String(row.client_name),
    redirectUris: parseStringArray(row.redirect_uris), grantTypes: parseStringArray(row.grant_types), tokenAuthMethod: String(row.token_auth_method) as OAuthClient["tokenAuthMethod"],
  };
}

async function issueTokenPair(db: PgD1, input: { clientId: string; organizationId: string; ownerUserId: string; scopes: string; resource: string; familyId: string }) {
  const accessToken = randomToken("rla", 32);
  const refreshToken = randomToken("rlr", 40);
  const now = Date.now();
  const accessExpiresAt = new Date(now + ACCESS_TOKEN_SECONDS * 1000).toISOString();
  const refreshExpiresAt = new Date(now + REFRESH_TOKEN_SECONDS * 1000).toISOString();
  await db.batch([
    db.prepare("INSERT INTO oauth_token_families (id) VALUES (?) ON CONFLICT (id) DO NOTHING").bind(input.familyId),
    db.prepare("INSERT INTO oauth_access_tokens (id, token_hash, client_id, organization_id, owner_user_id, scopes, resource, family_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(randomToken("oat", 18), await digest(accessToken), input.clientId, input.organizationId, input.ownerUserId, input.scopes, input.resource, input.familyId, accessExpiresAt),
    db.prepare("INSERT INTO oauth_refresh_tokens (id, token_hash, client_id, organization_id, owner_user_id, scopes, resource, family_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(randomToken("ort", 18), await digest(refreshToken), input.clientId, input.organizationId, input.ownerUserId, input.scopes, input.resource, input.familyId, refreshExpiresAt),
  ]);
  return oauthJson({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refreshToken, scope: input.scopes });
}

async function revokeFamily(db: PgD1, familyId: string) {
  await db.batch([
    db.prepare("INSERT INTO oauth_token_families (id, revoked_at) VALUES (?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET revoked_at = COALESCE(oauth_token_families.revoked_at, CURRENT_TIMESTAMP)").bind(familyId),
    db.prepare("UPDATE oauth_access_tokens SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE family_id = ?").bind(familyId),
    db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE family_id = ?").bind(familyId),
  ]);
}

export type OAuthConnection = { id: string; name: string; scopes: string[]; lastUsedAt: string | null; createdAt: string };

/** One row per non-revoked token family — a family is the unit `revokeFamily` acts on,
 * so this is the unit the dashboard should show and let the user revoke. If the same
 * client reconnects, that's a second family and a second row, which is accurate. */
export async function listOAuthConnections(db: PgD1, principal: Principal, organizationId: string): Promise<OAuthConnection[]> {
  const rows = await db.prepare(
    `SELECT f.id AS family_id, c.client_name AS client_name, f.created_at AS connected_at, MAX(t.scopes) AS scopes, MAX(a.last_used_at) AS last_used_at
       FROM oauth_token_families f
       JOIN oauth_refresh_tokens t ON t.family_id = f.id
       JOIN oauth_clients c ON c.id = t.client_id
       LEFT JOIN oauth_access_tokens a ON a.family_id = f.id
      WHERE f.revoked_at IS NULL AND t.owner_user_id = ? AND t.organization_id = ?
      GROUP BY f.id, c.client_name, f.created_at
      ORDER BY f.created_at DESC
      LIMIT 100`,
  ).bind(principal.userId, organizationId).all<{ family_id: string; client_name: string; connected_at: string; scopes: string | null; last_used_at: string | null }>();
  return rows.results.map((row) => ({ id: row.family_id, name: row.client_name, scopes: (row.scopes ?? "").split(/\s+/).filter(Boolean), lastUsedAt: row.last_used_at, createdAt: row.connected_at }));
}

export async function revokeOAuthConnection(db: PgD1, principal: Principal, organizationId: string, familyId: string): Promise<{ id: string; revoked: true }> {
  const owned = await db.prepare("SELECT id FROM oauth_refresh_tokens WHERE family_id = ? AND owner_user_id = ? AND organization_id = ? LIMIT 1")
    .bind(familyId, principal.userId, organizationId).first<{ id: string }>();
  if (!owned) throw Object.assign(new Error("OAuth connection not found"), { code: "NOT_FOUND", status: 404 });
  await revokeFamily(db, familyId);
  return { id: familyId, revoked: true };
}

async function applyRateLimit(db: PgD1, request: Request, bucket: string, maximum: number): Promise<Response | null> {
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const hour = new Date().toISOString().slice(0, 13);
  const key = await digest(`${bucket}:${ip}`);
  // Postgres treats a bare self-referencing column here as ambiguous between the
  // target table and the implicit `excluded` row ON CONFLICT always exposes — must be
  // table-qualified (SQLite/D1 never required this).
  const row = await db.prepare("INSERT INTO oauth_rate_limits (rate_key, window_start, request_count) VALUES (?, ?, 1) ON CONFLICT(rate_key, window_start) DO UPDATE SET request_count = oauth_rate_limits.request_count + 1 RETURNING oauth_rate_limits.request_count AS request_count")
    .bind(key, hour).first<{ request_count: number }>();
  if (Number(row?.request_count ?? 1) === 1) await cleanupExpiredOAuthData(db);
  if (Number(row?.request_count ?? 1) <= maximum) return null;
  return oauthError("temporarily_unavailable", "Too many OAuth requests; try again later", 429, { "retry-after": "3600" });
}

async function cleanupExpiredOAuthData(db: PgD1) {
  const now = new Date().toISOString();
  const inactiveClientCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rateCutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 13);
  await db.batch([
    db.prepare("DELETE FROM oauth_authorization_requests WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM oauth_authorization_codes WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM oauth_access_tokens WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM oauth_refresh_tokens WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM oauth_rate_limits WHERE window_start < ?").bind(rateCutoff),
    db.prepare("DELETE FROM oauth_token_families WHERE NOT EXISTS (SELECT 1 FROM oauth_access_tokens WHERE family_id = oauth_token_families.id) AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens WHERE family_id = oauth_token_families.id)"),
    db.prepare("DELETE FROM oauth_clients WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM oauth_authorization_requests WHERE client_id = oauth_clients.id) AND NOT EXISTS (SELECT 1 FROM oauth_authorization_codes WHERE client_id = oauth_clients.id) AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens WHERE client_id = oauth_clients.id) AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens WHERE client_id = oauth_clients.id)").bind(inactiveClientCutoff),
  ]);
}

async function requestPrincipal(request: Request, runtime: AuthEnvironment): Promise<Principal | null> {
  try { return await principalFromRequest(runtime, request); } catch { return null; }
}

function canonicalResource(request: Request, supplied: string | null) {
  return canonicalResourceFromUrl(new URL(request.url), supplied);
}

function canonicalResourceFromUrl(url: URL, supplied: string | null) {
  const expected = `${url.origin}/mcp`;
  if (!supplied) return expected; // Compatibility with MCP's March 2025 authorization profile.
  try { return new URL(supplied).href === expected ? expected : null; } catch { return null; }
}

function parseScopes(value: string) {
  return [...new Set(value.trim().split(/\s+/).filter(Boolean))];
}

function validRedirectUri(value: string) {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch { return false; }
}

function validHttpsUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function validCodeVerifier(value: string) { return /^[A-Za-z0-9._~-]{43,128}$/.test(value); }

async function pkceChallenge(verifier: string) {
  const hashed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(hashed));
}

async function digest(value: string) {
  const hashed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(prefix: string, byteLength: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return `${prefix}_${base64Url(bytes)}`;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index++) mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return mismatch === 0;
}

function parseBasicAuthorization(value: string | null) {
  if (!value?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(value.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { id: decodeFormComponent(decoded.slice(0, separator)), secret: decodeFormComponent(decoded.slice(separator + 1)) };
  } catch { return null; }
}

function decodeFormComponent(value: string) {
  try { return decodeURIComponent(value.replaceAll("+", " ")); } catch { return value; }
}

async function readJson(request: Request, maximum: number): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maximum) return null;
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

async function readForm(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/x-www-form-urlencoded")) return null;
  const text = await request.text();
  return text.length <= 64_000 ? new URLSearchParams(text) : null;
}

function stringArray(value: unknown, fallback: string[] = []) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as string[] : fallback;
}

function parseStringArray(value: unknown) {
  if (typeof value !== "string") return [];
  try { return stringArray(JSON.parse(value)); } catch { return []; }
}

function cleanText(value: unknown, fallback: string, maximum: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : fallback;
}

function nullableString(value: unknown) { return value == null ? null : String(value); }

function redirectWithParams(uri: string, values: Record<string, string | null>) {
  const target = new URL(uri);
  for (const [key, value] of Object.entries(values)) if (value != null) target.searchParams.set(key, value);
  return Response.redirect(target.toString(), 302);
}

function invalidClient() {
  return oauthError("invalid_client", "Client authentication failed", 401, { "www-authenticate": "Basic realm=\"Planbraid OAuth\"" });
}

function oauthError(error: string, description: string, status: number, headers?: Record<string, string>) {
  return oauthJson({ error, error_description: description }, status, false, headers);
}

function oauthJson(value: unknown, status = 200, cacheable = false, headers?: Record<string, string>) {
  return Response.json(value, { status, headers: { ...(cacheable ? { "cache-control": "public, max-age=300" } : noStoreHeaders()), "access-control-allow-origin": "*", ...headers } });
}

function noStoreHeaders() { return { "cache-control": "no-store", pragma: "no-cache" }; }

function optionsResponse() {
  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "86400" } });
}

function allowedMethods(pathname: string) { return pathname === "/authorize" ? "GET, POST" : "POST"; }

function consentPage(clientName: string, redirectUri: string, scopes: string[], requestId: string, principal: Principal) {
  const permissions = scopes.map((scope) => scope === "work:write" ? "Create, update, block, and complete todo items" : "View your projects, todo items, sources, and activity");
  const permissionItems = permissions.map((permission) => `<li><span>✓</span>${escapeHtml(permission)}</li>`).join("");
  const redirectHost = new URL(redirectUri).host;
  const body = `<main><div class="brand"><img src="/planbraid-mark.png" alt="">Planbraid</div><section><small>CONNECT MCP CLIENT</small><h1>Allow ${escapeHtml(clientName)} to use Planbraid?</h1><p>This connection will act for <strong>${escapeHtml(principal.email)}</strong>. The authorization result returns to <strong>${escapeHtml(redirectHost)}</strong>.</p><ul>${permissionItems}</ul><div class="notice">Access tokens expire after one hour. You can disconnect the connector to revoke future access.</div><form method="post" action="/authorize"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}"><button class="approve" name="decision" value="approve">Allow access</button><button class="deny" name="decision" value="deny">Cancel</button></form></section><footer>OAuth 2.1 · PKCE · scoped access · refresh rotation</footer></main>`;
  return htmlDocument("Authorize Planbraid", body, 200);
}

function oauthHtml(title: string, message: string, status: number) {
  return htmlDocument(title, `<main><div class="brand"><img src="/planbraid-mark.png" alt="">Planbraid</div><section><small>OAUTH CONNECTION</small><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></section></main>`, status);
}

function htmlDocument(title: string, body: string, status: number) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#0d0f13;color:#eef1f5}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 0,#202634 0,transparent 42%),#0d0f13}main{width:min(520px,100%)}.brand{display:flex;align-items:center;gap:9px;margin:0 0 18px;color:#c9ced7;font-size:14px;font-weight:650}.brand img{width:32px;height:32px;object-fit:contain}section{padding:28px;border:1px solid #303641;border-radius:14px;background:#16191f;box-shadow:0 24px 70px #0008}small{color:#8eb1ff;font-size:10px;letter-spacing:.12em}h1{margin:10px 0 12px;font-size:24px;line-height:1.25}p{color:#aab0ba;font-size:14px;line-height:1.55}p strong{color:#e4e7ec}ul{list-style:none;margin:22px 0;padding:0;display:grid;gap:11px}li{display:flex;gap:10px;color:#cbd0d8;font-size:13px}li span{color:#69cb91}.notice{padding:11px;border-left:2px solid #657da9;background:#1b2029;color:#929aa7;font-size:12px;line-height:1.5}form{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:22px}button{height:42px;border-radius:8px;font-weight:650;cursor:pointer}.approve{border:1px solid #5578b5;background:#2e466e;color:#f2f6ff}.deny{border:1px solid #373d47;background:transparent;color:#b5bbc5}footer{text-align:center;margin-top:14px;color:#646c78;font-size:10px}@media(max-width:480px){section{padding:20px}form{grid-template-columns:1fr}}</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...noStoreHeaders(), "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}
