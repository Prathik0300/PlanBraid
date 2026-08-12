/**
 * GitHub App integration, used only to let someone pick a repository when creating a
 * project. The App requests `metadata: read-only` and nothing else, so it can list
 * repository names the user explicitly granted at install time and cannot read code.
 *
 * User-to-server tokens are what we hold; they expire when the App has expiring tokens
 * enabled, so listRepos transparently refreshes once on a 401 before giving up.
 */
import type { PgD1 } from "@/db/pg-d1";
import { openSecret, sealSecret } from "@/lib/crypto-box";
import type { Principal } from "@/lib/store";

const GITHUB_API = "https://api.github.com";

export type GithubRepo = { id: number; name: string; fullName: string; description: string; htmlUrl: string; cloneUrl: string; private: boolean; updatedAt: string };
export type GithubStatus = { connected: boolean; login: string | null; configured: boolean };

type Row = Record<string, unknown>;

export function githubConfigured() {
  return Boolean(process.env.GITHUB_APP_SLUG && process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET);
}

function configOrThrow() {
  if (!githubConfigured()) throw Object.assign(new Error("GitHub is not configured for this deployment"), { code: "NOT_CONFIGURED", status: 503 });
  return { slug: process.env.GITHUB_APP_SLUG!, clientId: process.env.GITHUB_APP_CLIENT_ID!, clientSecret: process.env.GITHUB_APP_CLIENT_SECRET! };
}

/** GitHub's own install screen is where the user chooses which repositories to expose. */
export function githubInstallUrl() {
  return `https://github.com/apps/${encodeURIComponent(configOrThrow().slug)}/installations/new`;
}

export async function exchangeGithubCode(db: PgD1, principal: Principal, code: string) {
  const { clientId, clientSecret } = configOrThrow();
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const body = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
  if (!body.access_token) throw Object.assign(new Error(body.error_description ?? "GitHub did not return an access token"), { code: "GITHUB_AUTH_FAILED", status: 400 });

  const login = await fetchLogin(body.access_token);
  const expiresAt = body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null;
  await db.prepare("INSERT INTO github_connections (id, owner_user_id, github_login, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (owner_user_id) DO UPDATE SET github_login = excluded.github_login, access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, updated_at = now()")
    .bind(`ghc_${crypto.randomUUID().replaceAll("-", "")}`, principal.userId, login, await sealSecret(body.access_token), body.refresh_token ? await sealSecret(body.refresh_token) : null, expiresAt).run();
  return { login };
}

export async function githubStatus(db: PgD1, principal: Principal): Promise<GithubStatus> {
  if (!githubConfigured()) return { connected: false, login: null, configured: false };
  const row = await db.prepare("SELECT github_login FROM github_connections WHERE owner_user_id = ?").bind(principal.userId).first<Row>();
  return { connected: Boolean(row), login: row ? String(row.github_login) : null, configured: true };
}

export async function disconnectGithub(db: PgD1, principal: Principal) {
  await db.prepare("DELETE FROM github_connections WHERE owner_user_id = ?").bind(principal.userId).run();
  return { connected: false };
}

export async function listGithubRepos(db: PgD1, principal: Principal): Promise<GithubRepo[]> {
  let token = await accessToken(db, principal);
  let installations = await githubGet<{ installations?: { id: number }[] }>("/user/installations", token);
  if (installations === "unauthorized") {
    token = await refreshAccessToken(db, principal);
    installations = await githubGet<{ installations?: { id: number }[] }>("/user/installations", token);
  }
  if (installations === "unauthorized") throw reconnectRequired();

  const repos: GithubRepo[] = [];
  for (const installation of installations.installations ?? []) {
    // 100 is GitHub's per-page maximum; one page each is plenty for a picker, and keeps
    // this from fanning out into many requests for people in large organizations.
    const page = await githubGet<{ repositories?: Row[] }>(`/user/installations/${installation.id}/repositories?per_page=100`, token);
    if (page === "unauthorized") throw reconnectRequired();
    for (const repo of page.repositories ?? []) {
      repos.push({
        id: Number(repo.id), name: String(repo.name), fullName: String(repo.full_name),
        description: repo.description ? String(repo.description) : "",
        htmlUrl: String(repo.html_url), cloneUrl: String(repo.clone_url ?? repo.html_url),
        private: Boolean(repo.private), updatedAt: String(repo.updated_at ?? ""),
      });
    }
  }
  return repos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function githubGet<T>(path: string, token: string): Promise<T | "unauthorized"> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Planbraid" },
    cache: "no-store",
  });
  if (response.status === 401) return "unauthorized";
  if (!response.ok) throw Object.assign(new Error(`GitHub request failed (${response.status})`), { code: "GITHUB_REQUEST_FAILED", status: 502 });
  return response.json() as Promise<T>;
}

async function fetchLogin(token: string) {
  const user = await githubGet<{ login?: string }>("/user", token);
  return user === "unauthorized" ? "" : String(user.login ?? "");
}

async function accessToken(db: PgD1, principal: Principal) {
  const row = await db.prepare("SELECT access_token FROM github_connections WHERE owner_user_id = ?").bind(principal.userId).first<Row>();
  if (!row) throw Object.assign(new Error("Connect GitHub before browsing repositories"), { code: "GITHUB_NOT_CONNECTED", status: 404 });
  const token = await openSecret(String(row.access_token));
  if (!token) throw reconnectRequired();
  return token;
}

async function refreshAccessToken(db: PgD1, principal: Principal) {
  const { clientId, clientSecret } = configOrThrow();
  const row = await db.prepare("SELECT refresh_token FROM github_connections WHERE owner_user_id = ?").bind(principal.userId).first<Row>();
  const sealed = row?.refresh_token ? String(row.refresh_token) : null;
  const refreshToken = sealed ? await openSecret(sealed) : null;
  if (!refreshToken) throw reconnectRequired();

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const body = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!body.access_token) throw reconnectRequired();

  await db.prepare("UPDATE github_connections SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, updated_at = now() WHERE owner_user_id = ?")
    .bind(await sealSecret(body.access_token), body.refresh_token ? await sealSecret(body.refresh_token) : null, body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null, principal.userId).run();
  return body.access_token;
}

function reconnectRequired() {
  return Object.assign(new Error("The GitHub connection expired; reconnect from your profile"), { code: "GITHUB_RECONNECT_REQUIRED", status: 401 });
}
