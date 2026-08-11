/**
 * Domain-logic tests for the "Connected apps" dashboard list: which OAuth clients have
 * a live (non-revoked) token family for this user, and revoking one. Seeds the
 * oauth_clients/oauth_token_families/oauth_refresh_tokens rows directly rather than
 * driving the full PKCE authorize/token-exchange HTTP flow (handleOAuthRoute's internal
 * step functions aren't exported for isolated testing) — this still exercises the exact
 * query family that broke in production (see lib/oauth.ts's applyRateLimit fix), just
 * against pre-seeded state instead of a live registration.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal } from "./support/fixtures.mjs";
import { organizationFor } from "@/lib/store.ts";
import { listOAuthConnections, revokeOAuthConnection } from "@/lib/oauth.ts";

async function seedConnection(db, organizationId, { clientId = crypto.randomUUID(), familyId = crypto.randomUUID(), clientName = "Test Client", scopes = "work:read work:write" } = {}) {
  // ON CONFLICT DO NOTHING: reconnecting-the-same-client tests intentionally reuse a
  // clientId across two seedConnection() calls, which would otherwise violate the
  // primary key on the second insert.
  await db.prepare("INSERT INTO oauth_clients (id, client_name, redirect_uris, grant_types, response_types, token_auth_method) VALUES (?, ?, ?, ?, ?, 'none') ON CONFLICT (id) DO NOTHING")
    .bind(clientId, clientName, JSON.stringify(["https://example.com/callback"]), JSON.stringify(["authorization_code"]), JSON.stringify(["code"])).run();
  await db.prepare("INSERT INTO oauth_token_families (id) VALUES (?)").bind(familyId).run();
  await db.prepare("INSERT INTO oauth_refresh_tokens (id, token_hash, client_id, organization_id, owner_user_id, scopes, resource, family_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), crypto.randomUUID(), clientId, organizationId, principal.userId, scopes, "https://planbraid.local/mcp", familyId, new Date(Date.now() + 86400000).toISOString()).run();
  return { clientId, familyId };
}

test("listOAuthConnections returns a connected app with its scopes", async () => {
  const db = await createTestDb();
  const organizationId = await organizationFor(db, principal);
  const { familyId } = await seedConnection(db, organizationId, { clientName: "Claude Desktop" });

  const connections = await listOAuthConnections(db, principal, organizationId);
  assert.equal(connections.length, 1);
  assert.equal(connections[0].id, familyId);
  assert.equal(connections[0].name, "Claude Desktop");
  assert.deepEqual(connections[0].scopes, ["work:read", "work:write"]);
  assert.equal(connections[0].lastUsedAt, null);
});

test("revokeOAuthConnection revokes the family, which then disappears from the list", async () => {
  const db = await createTestDb();
  const organizationId = await organizationFor(db, principal);
  const { familyId } = await seedConnection(db, organizationId);

  const result = await revokeOAuthConnection(db, principal, organizationId, familyId);
  assert.deepEqual(result, { id: familyId, revoked: true });

  const connections = await listOAuthConnections(db, principal, organizationId);
  assert.equal(connections.length, 0);
});

test("revokeOAuthConnection throws NOT_FOUND for a connection that does not belong to this user", async () => {
  const db = await createTestDb();
  const organizationId = await organizationFor(db, principal);
  await assert.rejects(
    () => revokeOAuthConnection(db, principal, organizationId, "family_does_not_exist"),
    (error) => { assert.equal(error.code, "NOT_FOUND"); return true; },
  );
});

test("reconnecting the same client shows as two separate rows, most recent first", async () => {
  const db = await createTestDb();
  const organizationId = await organizationFor(db, principal);
  const first = await seedConnection(db, organizationId, { clientName: "Reconnecting App" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await seedConnection(db, organizationId, { clientId: first.clientId, clientName: "Reconnecting App" });

  const connections = await listOAuthConnections(db, principal, organizationId);
  assert.equal(connections.length, 2);
  assert.equal(connections[0].id, second.familyId);
  assert.equal(connections[1].id, first.familyId);
});
