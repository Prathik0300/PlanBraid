/**
 * Regression coverage for a bug found live in production: Codex's OAuth connection
 * completed the consent screen (a real authorization code was issued and delivered to
 * its loopback callback) but never called /token to exchange it, and the terminal
 * reported "couldn't authenticate" with no server-side trace at all — not even a
 * rejected request.
 *
 * Root cause: Next.js's default trailing-slash redirect (POST /token/ -> 308 -> /token)
 * happens before any route handler runs, and not every OAuth client's HTTP library
 * correctly re-sends a POST body through a 308 — some silently drop it or refuse to
 * follow a redirect for a non-idempotent method. next.config.ts now sets
 * skipTrailingSlashRedirect so both forms reach the route directly, but that alone
 * would have made trailing-slash requests 404 instead, because handleOAuthRoute's
 * pathname routing was an exact string match. It now normalizes a trailing slash
 * before matching.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { handleOAuthRoute } from "@/lib/oauth.ts";

function runtime(db) {
  return { DB: db, BETTER_AUTH_URL: "https://planbraid.local" };
}

test("oauth-authorization-server metadata is identical with and without a trailing slash", async () => {
  const db = await createTestDb();
  const withoutSlash = await handleOAuthRoute(new Request("https://planbraid.local/.well-known/oauth-authorization-server"), runtime(db));
  const withSlash = await handleOAuthRoute(new Request("https://planbraid.local/.well-known/oauth-authorization-server/"), runtime(db));
  assert.equal(withoutSlash.status, 200);
  assert.equal(withSlash.status, 200);
  assert.deepEqual(await withoutSlash.json(), await withSlash.json());
});

test("oauth-protected-resource metadata is identical with and without a trailing slash", async () => {
  const db = await createTestDb();
  const withoutSlash = await handleOAuthRoute(new Request("https://planbraid.local/.well-known/oauth-protected-resource"), runtime(db));
  const withSlash = await handleOAuthRoute(new Request("https://planbraid.local/.well-known/oauth-protected-resource/"), runtime(db));
  assert.equal(withoutSlash.status, 200);
  assert.equal(withSlash.status, 200);
  assert.deepEqual(await withoutSlash.json(), await withSlash.json());
});

test("POST /register/ (trailing slash) registers a client exactly like POST /register", async () => {
  const db = await createTestDb();
  const body = JSON.stringify({ redirect_uris: ["https://example.com/callback"] });
  const response = await handleOAuthRoute(new Request("https://planbraid.local/register/", { method: "POST", headers: { "content-type": "application/json" }, body }), runtime(db));
  assert.equal(response.status, 201, "a trailing slash must not 404 or otherwise fail differently than the canonical path");
  const client = await response.json();
  assert.ok(client.client_id);
});

test("POST /token/ (trailing slash) reaches the same handler as POST /token, not a 404", async () => {
  const db = await createTestDb();
  // No real grant is set up here — the point is only that this must fail the same way
  // (a real OAuth error) as the non-trailing-slash form, not a routing-level 404, which
  // is indistinguishable from "this endpoint doesn't exist" to a client and is exactly
  // what silently broke Codex's exchange in production.
  const withoutSlash = await handleOAuthRoute(new Request("https://planbraid.local/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code" }), runtime(db));
  const withSlash = await handleOAuthRoute(new Request("https://planbraid.local/token/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code" }), runtime(db));
  assert.notEqual(withSlash.status, 404);
  assert.equal(withSlash.status, withoutSlash.status);
});

test("a bare double slash in the pathname is left alone rather than stripped to an empty path", async () => {
  const db = await createTestDb();
  // Guards the edge case in the normalization itself: "/" must never become "".
  const response = await handleOAuthRoute(new Request("https://planbraid.local/"), runtime(db));
  assert.equal(response, null, "the root path isn't an OAuth route and must fall through untouched, not match something by accident");
});
