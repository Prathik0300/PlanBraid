import type { PgD1 } from "@/db/pg-d1";
import { connectionCredentials, markConnectionError, providerConfig, replaceConnectionTokens } from "@/lib/integrations/core";
import { nextLink, providerFetch, ProviderHttpError } from "@/lib/integrations/http";
import type { ExternalProject, ExternalResource, NormalizedExternalItem, ProviderRequest } from "@/lib/integrations/types";
import { safeIso, textFromHtml } from "@/lib/integrations/utils";

type Json = Record<string, unknown>;

const AUTHORIZATION_URL = "https://launchpad.37signals.com/authorization.json";
const TOKEN_URL = "https://launchpad.37signals.com/authorization/token";

function userAgent() {
  return process.env.BASECAMP_USER_AGENT?.trim() || "Planbraid (https://planbraid.com)";
}

export async function exchangeBasecampCode(code: string, redirectUri: string, fetcher: ProviderRequest = fetch) {
  const { clientId, clientSecret } = providerConfig("basecamp");
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code });
  const response = await providerFetch(TOKEN_URL, { provider: "basecamp", fetcher, method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent() }, body });
  const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!token.access_token) throw Object.assign(new Error("Basecamp did not return an access token"), { code: "BASECAMP_AUTH_FAILED", status: 400 });
  const resources = await basecampResourcesWithToken(token.access_token, fetcher);
  return {
    accessToken: token.access_token, refreshToken: token.refresh_token ?? null,
    expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
    scopes: [] as string[], label: resources[0]?.name ? `Basecamp · ${resources[0].name}` : "Basecamp",
  };
}

export async function basecampAccessToken(db: PgD1, connectionId: string, fetcher: ProviderRequest = fetch) {
  const credentials = await connectionCredentials(db, connectionId);
  if (credentials.provider !== "basecamp") throw Object.assign(new Error("The connection is not a Basecamp connection"), { code: "CONNECTION_PROVIDER_MISMATCH", status: 422 });
  if (!credentials.expiresAt || new Date(credentials.expiresAt).getTime() > Date.now() + 60_000) return credentials.accessToken;
  if (!credentials.refreshToken) {
    await markConnectionError(db, connectionId, "BASECAMP_RECONNECT_REQUIRED", true);
    throw Object.assign(new Error("Reconnect Basecamp to continue importing"), { code: "BASECAMP_RECONNECT_REQUIRED", status: 401 });
  }
  const { clientId, clientSecret } = providerConfig("basecamp");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: clientId, client_secret: clientSecret });
  try {
    const response = await providerFetch(TOKEN_URL, { provider: "basecamp", fetcher, method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent() }, body });
    const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!token.access_token) throw new Error("Basecamp refresh response did not contain an access token");
    await replaceConnectionTokens(db, connectionId, token.access_token, token.refresh_token ?? null, token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null);
    return token.access_token;
  } catch (error) {
    await markConnectionError(db, connectionId, error instanceof ProviderHttpError ? error.code : "BASECAMP_REFRESH_FAILED", true);
    throw error;
  }
}

export async function listBasecampResources(db: PgD1, connectionId: string, fetcher: ProviderRequest = fetch) {
  return basecampResourcesWithToken(await basecampAccessToken(db, connectionId, fetcher), fetcher);
}

async function basecampResourcesWithToken(accessToken: string, fetcher: ProviderRequest): Promise<ExternalResource[]> {
  const response = await providerFetch(AUTHORIZATION_URL, { provider: "basecamp", fetcher, headers: basecampHeaders(accessToken) });
  const body = await response.json() as { accounts?: Json[] };
  return (body.accounts ?? []).filter((entry) => String(entry.product ?? "") === "bc3").map((entry) => {
    const id = String(entry.id ?? "");
    return { id, name: String(entry.name ?? `Basecamp ${id}`), url: String(entry.app_href ?? entry.href ?? ""), scopes: [] };
  }).filter((entry) => entry.id);
}

export async function listBasecampProjects(db: PgD1, connectionId: string, accountId: string, fetcher: ProviderRequest = fetch): Promise<ExternalProject[]> {
  const token = await basecampAccessToken(db, connectionId, fetcher);
  const resources = await basecampResourcesWithToken(token, fetcher);
  const account = resources.find((entry) => entry.id === accountId);
  if (!account) throw Object.assign(new Error("The Basecamp account is not available to this connection"), { code: "BASECAMP_ACCOUNT_NOT_FOUND", status: 404 });
  const baseUrl = basecampBaseUrl(accountId);
  const projects = await getAllPages<Json>(`${baseUrl}/projects.json`, token, fetcher);
  return projects.map((project) => ({
    id: String(project.id), key: null, name: String(project.name ?? "Untitled Basecamp project"), description: textFromHtml(project.description),
    url: String(project.app_url ?? ""), accountId, accountName: account.name, baseUrl,
  }));
}

export async function fetchBasecampProjectItems(db: PgD1, binding: Json, fetcher: ProviderRequest = fetch): Promise<NormalizedExternalItem[]> {
  const token = await basecampAccessToken(db, String(binding.connection_id), fetcher);
  const baseUrl = checkedBasecampBaseUrl(String(binding.external_base_url), String(binding.external_account_id));
  const projectId = String(binding.external_project_id);
  const projectResponse = await providerFetch(`${baseUrl}/projects/${encodeURIComponent(projectId)}.json`, { provider: "basecamp", fetcher, headers: basecampHeaders(token) });
  const project = await projectResponse.json() as Json;
  const dock = Array.isArray(project.dock) ? project.dock as Json[] : [];
  const todoSet = dock.find((entry) => String(entry.name) === "todoset" && entry.enabled !== false);
  if (!todoSet?.id) return [];

  const todoSetId = String(todoSet.id);
  const lists = await getAllPages<Json>(`${baseUrl}/todosets/${encodeURIComponent(todoSetId)}/todolists.json`, token, fetcher);
  const normalized: NormalizedExternalItem[] = lists.map(normalizeBasecampTodoList);
  for (const list of lists) {
    const listId = String(list.id);
    const [pending, completed] = await Promise.all([
      getAllPages<Json>(`${baseUrl}/todolists/${encodeURIComponent(listId)}/todos.json`, token, fetcher),
      getAllPages<Json>(`${baseUrl}/todolists/${encodeURIComponent(listId)}/todos.json?completed=true`, token, fetcher),
    ]);
    const seen = new Map([...pending, ...completed].map((todo) => [String(todo.id), todo]));
    normalized.push(...[...seen.values()].map((todo) => normalizeBasecampTodo(todo, listId)));
  }

  // Basecamp permits to-dos directly under the to-do set, outside any list.
  const [directPending, directCompleted] = await Promise.all([
    getAllPages<Json>(`${baseUrl}/todosets/${encodeURIComponent(todoSetId)}/todos.json`, token, fetcher, true),
    getAllPages<Json>(`${baseUrl}/todosets/${encodeURIComponent(todoSetId)}/todos.json?completed=true`, token, fetcher, true),
  ]);
  const direct = new Map([...directPending, ...directCompleted].map((todo) => [String(todo.id), todo]));
  normalized.push(...[...direct.values()].map((todo) => normalizeBasecampTodo(todo, null)));
  return normalized;
}

export function normalizeBasecampTodoList(list: Json): NormalizedExternalItem {
  return {
    externalId: String(list.id), externalKey: null, itemType: "feature", title: String(list.title ?? "Untitled to-do list"),
    description: textFromHtml(list.description), externalStatus: String(list.status ?? "active"), normalizedStatus: list.status === "trashed" ? "cancelled" : "planned",
    priority: "normal", assignee: null, dueAt: null, parentExternalId: null, canonicalUrl: String(list.app_url ?? ""),
    externalRevision: safeIso(list.updated_at), relations: [], raw: list,
  };
}

export function normalizeBasecampTodo(todo: Json, fallbackParentId: string | null): NormalizedExternalItem {
  const assignees = Array.isArray(todo.assignees) ? (todo.assignees as Json[]).map((person) => String(person.name ?? "")).filter(Boolean) : [];
  const parent = todo.parent && typeof todo.parent === "object" ? todo.parent as Json : null;
  const completed = Boolean(todo.completed);
  const status = String(todo.status ?? "active");
  return {
    externalId: String(todo.id), externalKey: null, itemType: "task", title: String(todo.content ?? todo.title ?? "Untitled to-do"),
    description: textFromHtml(todo.description), externalStatus: completed ? "completed" : status,
    normalizedStatus: status === "trashed" ? "cancelled" : completed ? "done" : "planned", priority: "normal",
    assignee: assignees.length ? assignees.join(", ") : null, dueAt: safeIso(todo.due_on),
    parentExternalId: parent?.type === "Todolist" && parent.id ? String(parent.id) : fallbackParentId,
    canonicalUrl: String(todo.app_url ?? ""), externalRevision: safeIso(todo.updated_at), relations: [], raw: todo,
  };
}

export async function fetchBasecampTodo(db: PgD1, binding: Json, externalId: string, fetcher: ProviderRequest = fetch) {
  const token = await basecampAccessToken(db, String(binding.connection_id), fetcher);
  const baseUrl = checkedBasecampBaseUrl(String(binding.external_base_url), String(binding.external_account_id));
  const response = await providerFetch(`${baseUrl}/todos/${encodeURIComponent(externalId)}.json`, { provider: "basecamp", fetcher, headers: basecampHeaders(token), maxRetries: 2 });
  return normalizeBasecampTodo(await response.json() as Json, null);
}

export async function createBasecampWebhook(db: PgD1, binding: Json, callbackUrl: string, fetcher: ProviderRequest = fetch) {
  const token = await basecampAccessToken(db, String(binding.connection_id), fetcher);
  const baseUrl = checkedBasecampBaseUrl(String(binding.external_base_url), String(binding.external_account_id));
  const response = await providerFetch(`${baseUrl}/buckets/${encodeURIComponent(String(binding.external_project_id))}/webhooks.json`, {
    provider: "basecamp", fetcher, method: "POST", headers: { ...basecampHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ payload_url: callbackUrl, types: ["Todo", "Todolist"] }),
  });
  const body = await response.json() as Json;
  return { id: String(body.id), expiresAt: null };
}

function basecampHeaders(token: string) {
  return { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": userAgent() };
}

function basecampBaseUrl(accountId: string) {
  if (!/^\d+$/.test(accountId)) throw Object.assign(new Error("Invalid Basecamp account identifier"), { code: "BASECAMP_ACCOUNT_INVALID", status: 422 });
  return `https://3.basecampapi.com/${accountId}`;
}

function checkedBasecampBaseUrl(value: string, accountId: string) {
  const expected = basecampBaseUrl(accountId);
  if (value.replace(/\/$/, "") !== expected) throw Object.assign(new Error("Basecamp API base URL does not match the bound account"), { code: "BASECAMP_BASE_URL_INVALID", status: 422 });
  return expected;
}

async function getAllPages<T>(initialUrl: string, token: string, fetcher: ProviderRequest, tolerateNotFound = false): Promise<T[]> {
  const results: T[] = [];
  let url: string | null = initialUrl;
  let pages = 0;
  while (url) {
    try {
      const response = await providerFetch(url, { provider: "basecamp", fetcher, headers: basecampHeaders(token) });
      const body = await response.json();
      if (Array.isArray(body)) results.push(...body as T[]);
      url = nextLink(response.headers.get("link"));
      pages += 1;
      if (pages > 1_000) throw Object.assign(new Error("Basecamp pagination exceeded its safety limit"), { code: "BASECAMP_PAGINATION_INVALID", status: 502 });
    } catch (error) {
      if (tolerateNotFound && error instanceof ProviderHttpError && error.responseStatus === 404) return results;
      throw error;
    }
  }
  return results;
}
