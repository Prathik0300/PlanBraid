import { createHmac, timingSafeEqual } from "node:crypto";
import type { PgD1 } from "@/db/pg-d1";
import { connectionCredentials, markConnectionError, providerConfig, replaceConnectionTokens } from "@/lib/integrations/core";
import { providerFetch, ProviderHttpError } from "@/lib/integrations/http";
import type { ExternalProject, ExternalRelation, ExternalResource, NormalizedExternalItem, ProviderRequest } from "@/lib/integrations/types";
import { fromBase64url, safeIso, textFromAdf } from "@/lib/integrations/utils";

type Json = Record<string, unknown>;
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

export async function exchangeJiraCode(code: string, redirectUri: string, fetcher: ProviderRequest = fetch) {
  const { clientId, clientSecret } = providerConfig("jira");
  const response = await providerFetch(TOKEN_URL, {
    provider: "jira", fetcher, method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!token.access_token) throw Object.assign(new Error("Jira did not return an access token"), { code: "JIRA_AUTH_FAILED", status: 400 });
  const resources = await jiraResourcesWithToken(token.access_token, fetcher);
  return {
    accessToken: token.access_token, refreshToken: token.refresh_token ?? null,
    expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
    scopes: token.scope?.split(/\s+/).filter(Boolean) ?? [], label: resources[0]?.name ? `Jira · ${resources[0].name}` : "Jira Cloud",
  };
}

export async function jiraAccessToken(db: PgD1, connectionId: string, fetcher: ProviderRequest = fetch) {
  const credentials = await connectionCredentials(db, connectionId);
  if (credentials.provider !== "jira") throw Object.assign(new Error("The connection is not a Jira connection"), { code: "CONNECTION_PROVIDER_MISMATCH", status: 422 });
  if (!credentials.expiresAt || new Date(credentials.expiresAt).getTime() > Date.now() + 60_000) return credentials.accessToken;
  if (!credentials.refreshToken) {
    await markConnectionError(db, connectionId, "JIRA_RECONNECT_REQUIRED", true);
    throw Object.assign(new Error("Reconnect Jira to continue importing"), { code: "JIRA_RECONNECT_REQUIRED", status: 401 });
  }
  const { clientId, clientSecret } = providerConfig("jira");
  try {
    const response = await providerFetch(TOKEN_URL, {
      provider: "jira", fetcher, method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: credentials.refreshToken }),
    });
    const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!token.access_token || !token.refresh_token) throw new Error("Jira rotating refresh response was incomplete");
    const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;
    // Atlassian invalidates the old rotating refresh token. Replacing access and refresh
    // in one statement is mandatory; otherwise one successful refresh strands the grant.
    await replaceConnectionTokens(db, connectionId, token.access_token, token.refresh_token, expiresAt, token.scope?.split(/\s+/).filter(Boolean));
    return token.access_token;
  } catch (error) {
    await markConnectionError(db, connectionId, error instanceof ProviderHttpError ? error.code : "JIRA_REFRESH_FAILED", true);
    throw error;
  }
}

export async function listJiraResources(db: PgD1, connectionId: string, fetcher: ProviderRequest = fetch) {
  return jiraResourcesWithToken(await jiraAccessToken(db, connectionId, fetcher), fetcher);
}

async function jiraResourcesWithToken(token: string, fetcher: ProviderRequest): Promise<ExternalResource[]> {
  const response = await providerFetch(RESOURCES_URL, { provider: "jira", fetcher, headers: jiraHeaders(token) });
  const body = await response.json() as Json[];
  return (Array.isArray(body) ? body : []).map((resource) => ({
    id: String(resource.id ?? ""), name: String(resource.name ?? "Jira site"), url: String(resource.url ?? ""),
    scopes: Array.isArray(resource.scopes) ? resource.scopes.map(String) : [],
  })).filter((resource) => resource.id);
}

export async function listJiraProjects(db: PgD1, connectionId: string, cloudId: string, fetcher: ProviderRequest = fetch): Promise<ExternalProject[]> {
  const token = await jiraAccessToken(db, connectionId, fetcher);
  const resources = await jiraResourcesWithToken(token, fetcher);
  const site = resources.find((entry) => entry.id === cloudId);
  if (!site) throw Object.assign(new Error("The Jira site is not available to this connection"), { code: "JIRA_SITE_NOT_FOUND", status: 404 });
  const baseUrl = jiraBaseUrl(cloudId);
  const projects: Json[] = [];
  let startAt = 0;
  while (true) {
    const response = await providerFetch(`${baseUrl}/rest/api/3/project/search?status=live&orderBy=name&startAt=${startAt}&maxResults=50`, { provider: "jira", fetcher, headers: jiraHeaders(token) });
    const page = await response.json() as { values?: Json[]; startAt?: number; maxResults?: number; total?: number; isLast?: boolean };
    projects.push(...(page.values ?? []));
    if (page.isLast || projects.length >= Number(page.total ?? projects.length)) break;
    startAt = Number(page.startAt ?? startAt) + Number(page.maxResults ?? 50);
    if (startAt > 100_000) throw Object.assign(new Error("Jira project pagination exceeded its safety limit"), { code: "JIRA_PAGINATION_INVALID", status: 502 });
  }
  return projects.map((project) => ({
    id: String(project.id), key: project.key ? String(project.key) : null, name: String(project.name ?? "Untitled Jira project"),
    description: String(project.description ?? ""), url: site.url ? `${site.url}/browse/${String(project.key ?? "")}` : "",
    accountId: cloudId, accountName: site.name, baseUrl,
  }));
}

export async function fetchJiraProjectItems(db: PgD1, binding: Json, fetcher: ProviderRequest = fetch): Promise<NormalizedExternalItem[]> {
  const token = await jiraAccessToken(db, String(binding.connection_id), fetcher);
  const cloudId = String(binding.external_account_id);
  const baseUrl = checkedJiraBaseUrl(String(binding.external_base_url), cloudId);
  const projectKey = String(binding.external_project_key ?? "");
  const projectId = String(binding.external_project_id);
  const configuredJql = String(binding.filter_query ?? "").trim();
  const projectScope = `project = ${quoteJql(projectKey || projectId)}`;
  const jql = configuredJql ? `${projectScope} AND (${configuredJql}) ORDER BY updated ASC` : `${projectScope} ORDER BY updated ASC`;
  const items: NormalizedExternalItem[] = [];
  let nextPageToken: string | undefined;
  let pages = 0;
  do {
    const response = await providerFetch(`${baseUrl}/rest/api/3/search/jql`, {
      provider: "jira", fetcher, method: "POST", headers: { ...jiraHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ jql, maxResults: 100, nextPageToken, fields: ["summary", "description", "status", "priority", "assignee", "duedate", "parent", "issuetype", "issuelinks", "updated", "project"] }),
    });
    const page = await response.json() as { issues?: Json[]; nextPageToken?: string; isLast?: boolean };
    items.push(...(page.issues ?? []).map((issue) => withJiraBrowseUrl(normalizeJiraIssue(issue), binding)));
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
    pages += 1;
    if (pages > 1_000) throw Object.assign(new Error("Jira issue pagination exceeded its safety limit"), { code: "JIRA_PAGINATION_INVALID", status: 502 });
  } while (nextPageToken);
  return items;
}

export function normalizeJiraIssue(issue: Json): NormalizedExternalItem {
  const fields = issue.fields && typeof issue.fields === "object" ? issue.fields as Json : {};
  const status = fields.status && typeof fields.status === "object" ? fields.status as Json : {};
  const category = status.statusCategory && typeof status.statusCategory === "object" ? status.statusCategory as Json : {};
  const priority = fields.priority && typeof fields.priority === "object" ? fields.priority as Json : {};
  const assignee = fields.assignee && typeof fields.assignee === "object" ? fields.assignee as Json : null;
  const parent = fields.parent && typeof fields.parent === "object" ? fields.parent as Json : null;
  const issueType = fields.issuetype && typeof fields.issuetype === "object" ? fields.issuetype as Json : {};
  const links = Array.isArray(fields.issuelinks) ? fields.issuelinks as Json[] : [];
  return {
    externalId: String(issue.id), externalKey: issue.key ? String(issue.key) : null,
    itemType: normalizeJiraType(String(issueType.name ?? "task")), title: String(fields.summary ?? "Untitled Jira issue"),
    description: textFromAdf(fields.description), externalStatus: String(status.name ?? ""), normalizedStatus: normalizeJiraStatus(String(status.name ?? ""), String(category.name ?? category.key ?? "")),
    priority: normalizeJiraPriority(String(priority.name ?? "")), assignee: assignee?.displayName ? String(assignee.displayName) : null,
    dueAt: safeIso(fields.duedate), parentExternalId: parent?.id ? String(parent.id) : null,
    canonicalUrl: issue.key && fields.project && typeof fields.project === "object" ? jiraBrowseUrl(String(issue.self ?? ""), String(issue.key)) : String(issue.self ?? ""),
    externalRevision: safeIso(fields.updated), relations: links.flatMap(normalizeJiraLink), raw: issue,
  };
}

export async function fetchJiraIssue(db: PgD1, binding: Json, issueId: string, fetcher: ProviderRequest = fetch) {
  const token = await jiraAccessToken(db, String(binding.connection_id), fetcher);
  const baseUrl = checkedJiraBaseUrl(String(binding.external_base_url), String(binding.external_account_id));
  const fields = "summary,description,status,priority,assignee,duedate,parent,issuetype,issuelinks,updated,project";
  const response = await providerFetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=${encodeURIComponent(fields)}`, { provider: "jira", fetcher, headers: jiraHeaders(token), maxRetries: 2 });
  return withJiraBrowseUrl(normalizeJiraIssue(await response.json() as Json), binding);
}

export async function createJiraWebhook(db: PgD1, binding: Json, callbackUrl: string, fetcher: ProviderRequest = fetch) {
  const token = await jiraAccessToken(db, String(binding.connection_id), fetcher);
  const baseUrl = checkedJiraBaseUrl(String(binding.external_base_url), String(binding.external_account_id));
  const projectKey = String(binding.external_project_key ?? binding.external_project_id);
  const configuredJql = String(binding.filter_query ?? "").trim();
  const projectScope = `project = ${quoteJql(projectKey)}`;
  const jqlFilter = configuredJql ? `${projectScope} AND (${configuredJql})` : projectScope;
  const response = await providerFetch(`${baseUrl}/rest/api/3/webhook`, {
    provider: "jira", fetcher, method: "POST", headers: { ...jiraHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ url: callbackUrl, webhooks: [{ jqlFilter, events: ["jira:issue_created", "jira:issue_updated", "jira:issue_deleted"] }] }),
  });
  const body = await response.json() as Array<{ createdWebhookId?: number; errors?: string[] }>;
  const created = body.find((entry) => entry.createdWebhookId);
  if (!created?.createdWebhookId) throw Object.assign(new Error(body.flatMap((entry) => entry.errors ?? []).join("; ") || "Jira webhook registration failed"), { code: "JIRA_WEBHOOK_FAILED", status: 502 });
  return { id: String(created.createdWebhookId), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString() };
}

export async function refreshJiraWebhook(db: PgD1, binding: Json, fetcher: ProviderRequest = fetch) {
  if (!binding.webhook_id) return null;
  const token = await jiraAccessToken(db, String(binding.connection_id), fetcher);
  const baseUrl = checkedJiraBaseUrl(String(binding.external_base_url), String(binding.external_account_id));
  await providerFetch(`${baseUrl}/rest/api/3/webhook`, {
    provider: "jira", fetcher, method: "PUT", headers: { ...jiraHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ webhookIds: [Number(binding.webhook_id)] }),
  });
  return new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
}

export async function deleteJiraWebhook(db: PgD1, binding: Json, fetcher: ProviderRequest = fetch) {
  if (!binding.webhook_id) return;
  const token = await jiraAccessToken(db, String(binding.connection_id), fetcher);
  const baseUrl = checkedJiraBaseUrl(String(binding.external_base_url), String(binding.external_account_id));
  await providerFetch(`${baseUrl}/rest/api/3/webhook`, {
    provider: "jira", fetcher, method: "DELETE", headers: { ...jiraHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ webhookIds: [Number(binding.webhook_id)] }), maxRetries: 1,
  });
}

/** Atlassian signs the OAuth webhook bearer token with the app client secret. Only HS256
 * is accepted, and temporal claims are checked when present. The high-entropy callback
 * path is a second independent binding check performed by the webhook route. */
export function verifyJiraWebhookBearer(authorization: string | null, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!authorization?.startsWith("Bearer ")) return false;
  const token = authorization.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0]))) as { alg?: string };
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1]))) as { exp?: number; nbf?: number };
    if (header.alg !== "HS256") return false;
    if (payload.exp && payload.exp < nowSeconds - 30) return false;
    if (payload.nbf && payload.nbf > nowSeconds + 30) return false;
    const { clientSecret } = providerConfig("jira");
    const expected = createHmac("sha256", clientSecret).update(`${parts[0]}.${parts[1]}`).digest();
    const actual = Buffer.from(fromBase64url(parts[2]));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}

function normalizeJiraLink(link: Json): ExternalRelation[] {
  const type = link.type && typeof link.type === "object" ? link.type as Json : {};
  const outward = link.outwardIssue && typeof link.outwardIssue === "object" ? link.outwardIssue as Json : null;
  const inward = link.inwardIssue && typeof link.inwardIssue === "object" ? link.inwardIssue as Json : null;
  const other = outward ?? inward;
  if (!other?.id) return [];
  const label = String(outward ? type.outward ?? type.name ?? "relates to" : type.inward ?? type.name ?? "relates to");
  const lower = label.toLowerCase();
  const relation: ExternalRelation["type"] = lower.includes("blocked by") || lower.includes("is blocked") ? "blocked_by" : lower === "blocks" || (lower.includes("blocks") && !lower.includes("blocked")) ? "blocks" : "relates_to";
  return [{ externalId: String(other.id), type: relation, label }];
}

function normalizeJiraType(value: string) {
  const lower = value.toLowerCase();
  if (lower.includes("epic") || lower.includes("initiative")) return "feature";
  if (lower.includes("story")) return "story";
  if (lower.includes("bug")) return "bug";
  if (lower.includes("sub-task") || lower.includes("subtask")) return "subtask";
  return "task";
}

function normalizeJiraStatus(name: string, category: string): NormalizedExternalItem["normalizedStatus"] {
  const lower = `${name} ${category}`.toLowerCase();
  if (lower.includes("cancel") || lower.includes("won't do") || lower.includes("wont do")) return "cancelled";
  if (lower.includes("done") || lower.includes("complete") || lower.includes("resolved")) return "done";
  if (lower.includes("block") || lower.includes("imped")) return "blocked";
  if (lower.includes("review") || lower.includes("test") || lower.includes("qa")) return "in_review";
  if (lower.includes("progress") || lower.includes("doing")) return "in_progress";
  return "planned";
}

function normalizeJiraPriority(value: string): NormalizedExternalItem["priority"] {
  const lower = value.toLowerCase();
  if (lower.includes("highest") || lower.includes("critical") || lower.includes("urgent") || lower.includes("blocker")) return "urgent";
  if (lower.includes("high")) return "high";
  if (lower.includes("lowest") || lower.includes("trivial")) return "none";
  if (lower.includes("low") || lower.includes("minor")) return "low";
  return "normal";
}

function jiraHeaders(token: string) {
  return { authorization: `Bearer ${token}`, accept: "application/json" };
}

function jiraBaseUrl(cloudId: string) {
  if (!/^[a-z0-9-]{8,80}$/i.test(cloudId)) throw Object.assign(new Error("Invalid Jira cloud identifier"), { code: "JIRA_SITE_INVALID", status: 422 });
  return `https://api.atlassian.com/ex/jira/${cloudId}`;
}

function checkedJiraBaseUrl(value: string, cloudId: string) {
  const expected = jiraBaseUrl(cloudId);
  if (value.replace(/\/$/, "") !== expected) throw Object.assign(new Error("Jira API base URL does not match the bound site"), { code: "JIRA_BASE_URL_INVALID", status: 422 });
  return expected;
}

function quoteJql(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function jiraBrowseUrl(self: string, key: string) {
  try {
    const url = new URL(self);
    if (url.hostname.endsWith("atlassian.net")) return `${url.origin}/browse/${key}`;
  } catch { /* OAuth API self links use api.atlassian.com and need the site URL to browse */ }
  return self;
}

function withJiraBrowseUrl(item: NormalizedExternalItem, binding: Json) {
  if (!item.externalKey) return item;
  const settings = typeof binding.settings === "string" ? JSON.parse(binding.settings || "{}") as { externalProjectUrl?: string } : {};
  try {
    if (settings.externalProjectUrl) item.canonicalUrl = `${new URL(settings.externalProjectUrl).origin}/browse/${encodeURIComponent(item.externalKey)}`;
  } catch { /* retain the API self URL when a legacy binding has no valid site URL */ }
  return item;
}
