import type { PgD1 } from "@/db/pg-d1";
import { connectionCredentials, domainError, providerConfig } from "@/lib/integrations/core";
import { providerFetch } from "@/lib/integrations/http";
import type { ProviderRequest } from "@/lib/integrations/types";
import { parseJson } from "@/lib/integrations/utils";

type Json = Record<string, unknown>;

const API = "https://slack.com/api";

/** Least-privilege bot scopes: post messages (including to public channels the bot has
 * not joined) and list channels to populate the binding picker. Deliberately excludes
 * anything that reads message content or the user directory - this app never needs it,
 * and requesting it would both slow Slack Marketplace review and put us inside the
 * conversations.history/replies rate-limit tightening Slack applied to non-Marketplace
 * apps in 2025 for no benefit. */
/** Slack's Web API always answers HTTP 200 and signals failure via a body-level `ok`
 * field, unlike Basecamp/Jira where providerFetch's status check is enough - every call
 * here re-checks `ok` itself after parsing. */
async function slackJson<T extends Json>(url: string, options: Parameters<typeof providerFetch>[1]): Promise<T> {
  const response = await providerFetch(url, options);
  const body = await response.json() as T & { ok?: boolean; error?: string };
  if (!body.ok) throw Object.assign(new Error(body.error ? `Slack: ${body.error}` : "Slack request failed"), { code: slackErrorCode(body.error), status: 502 });
  return body;
}

function slackErrorCode(error?: string) {
  if (error === "invalid_auth" || error === "token_revoked" || error === "account_inactive") return "PROVIDER_RECONNECT_REQUIRED";
  if (error === "ratelimited") return "PROVIDER_RATE_LIMITED";
  return "SLACK_REQUEST_FAILED";
}

export async function exchangeSlackCode(code: string, redirectUri: string, fetcher: ProviderRequest = fetch) {
  const { clientId, clientSecret } = providerConfig("slack");
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code });
  const token = await slackJson<{ access_token: string; bot_user_id: string; team: { id: string; name: string }; scope: string }>(`${API}/oauth.v2.access`, { provider: "slack", fetcher, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  return {
    accessToken: token.access_token,
    // Standard bot tokens (token rotation not enabled - see SLACK_INTEGRATION_PLAN.md §4)
    // do not expire, so there is nothing to refresh and nothing to seal as a refresh
    // token. refreshCredentials stays unimplemented for the same reason: enabling
    // rotation later is a config change, not a code change, once it's worth the added
    // single-use-refresh-token concurrency handling it requires.
    refreshToken: null as string | null,
    expiresAt: null as string | null,
    scopes: token.scope.split(","),
    label: `Slack · ${token.team.name}`,
    metadata: { teamId: token.team.id, teamName: token.team.name, botUserId: token.bot_user_id },
  };
}

async function slackAccessToken(db: PgD1, connectionId: string) {
  const credentials = await connectionCredentials(db, connectionId);
  if (credentials.provider !== "slack") throw domainError("CONNECTION_PROVIDER_MISMATCH", "The connection is not a Slack connection", 422);
  return credentials.accessToken;
}

export type SlackChannel = { id: string; name: string; isPrivate: boolean; isMember: boolean };

export async function listSlackChannels(db: PgD1, connectionId: string, fetcher: ProviderRequest = fetch): Promise<SlackChannel[]> {
  const token = await slackAccessToken(db, connectionId);
  const channels: SlackChannel[] = [];
  let cursor = "";
  let pages = 0;
  do {
    const url = new URL(`${API}/conversations.list`);
    url.searchParams.set("types", "public_channel,private_channel");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const body = await slackJson<{ channels: Json[]; response_metadata?: { next_cursor?: string } }>(url.toString(), { provider: "slack", fetcher, headers: { authorization: `Bearer ${token}` } });
    for (const entry of body.channels) channels.push({ id: String(entry.id), name: String(entry.name ?? entry.id), isPrivate: Boolean(entry.is_private), isMember: Boolean(entry.is_member) });
    cursor = body.response_metadata?.next_cursor ?? "";
    pages += 1;
  } while (cursor && pages < 20);
  return channels.sort((left, right) => left.name.localeCompare(right.name));
}

/** Best-effort: the created task's description links back to the source message when
 * this succeeds, and simply omits the link when it doesn't (e.g. the message was deleted
 * between the shortcut click and this call). Never worth failing task creation over. */
export async function getSlackPermalink(db: PgD1, connectionId: string, channel: string, messageTs: string, fetcher: ProviderRequest = fetch) {
  const token = await slackAccessToken(db, connectionId);
  const url = new URL(`${API}/chat.getPermalink`);
  url.searchParams.set("channel", channel);
  url.searchParams.set("message_ts", messageTs);
  const body = await slackJson<{ permalink: string }>(url.toString(), { provider: "slack", fetcher, headers: { authorization: `Bearer ${token}` } });
  return body.permalink;
}

export type SlackBlock = Json;

export async function postSlackMessage(db: PgD1, connectionId: string, channel: string, blocks: SlackBlock[], fallbackText: string, fetcher: ProviderRequest = fetch) {
  const token = await slackAccessToken(db, connectionId);
  const body = await slackJson<{ ts: string; channel: string }>(`${API}/chat.postMessage`, {
    provider: "slack", fetcher, method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, blocks: blocks.slice(0, 50), text: fallbackText.slice(0, 4000), unfurl_links: false, unfurl_media: false }),
  });
  return { ts: body.ts, channel: body.channel };
}

/** Opens a modal from a message shortcut's or slash command's trigger_id. trigger_id is
 * single-use and expires in ~3 seconds, so the caller must call this immediately on
 * receiving the interaction, before doing any other work. */
export async function openSlackModal(db: PgD1, connectionId: string, triggerId: string, view: Json, fetcher: ProviderRequest = fetch) {
  const token = await slackAccessToken(db, connectionId);
  await slackJson(`${API}/views.open`, {
    provider: "slack", fetcher, method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ trigger_id: triggerId, view }),
  });
}

/** Visible only to the one Slack user who triggered the action - the confirmation for a
 * task just created from their shortcut or slash command, not a channel-wide message. */
export async function postSlackEphemeral(db: PgD1, connectionId: string, channel: string, user: string, text: string, fetcher: ProviderRequest = fetch) {
  const token = await slackAccessToken(db, connectionId);
  await slackJson(`${API}/chat.postEphemeral`, {
    provider: "slack", fetcher, method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, user, text: text.slice(0, 4000) }),
  });
}

/**
 * HMAC-SHA256 request verification (docs.slack.dev/authentication/verifying-requests-
 * from-slack): basestring is `v0:{timestamp}:{raw body}`, compared in constant time, with
 * a 5-minute replay window. Must run on the *raw* request body, before any JSON parsing -
 * the caller is responsible for reading text() first and reusing that same string.
 */
export async function verifySlackSignature(signingSecret: string, timestampHeader: string | null, signatureHeader: string | null, rawBody: string, now = Date.now()) {
  if (!timestampHeader || !signatureHeader) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > 300) return false;
  const basestring = `v0:${timestampHeader}:${rawBody}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(basestring));
  const expected = `v0=${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return constantTimeEqualLength(expected, signatureHeader);
}

function constantTimeEqualLength(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function parseSlackWebhookPayload(rawBody: string, contentType: string | null): Json {
  if ((contentType ?? "").includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(rawBody);
    const payload = params.get("payload");
    if (payload) return parseJson<Json>(payload, {});
    return Object.fromEntries(params.entries());
  }
  return parseJson<Json>(rawBody, {});
}
