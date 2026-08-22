/**
 * Guest sandboxes (lib/guest.ts): a better-auth anonymous session gets a real,
 * auto-seeded, capped organization instead of a sign-up wall — see the module's own
 * header for why. These tests cover the wiring in lib/store.ts's organizationFor/
 * executeCommand/createMcpToken, the cap functions themselves, the claim-on-signup
 * merge, the cascading cleanup delete, and the real-integration refusal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createMcpToken, executeCommand, loadDashboard, organizationFor } from "@/lib/store.ts";
import {
  GUEST_MCP_TOKEN_LIMIT,
  GUEST_PROJECT_LIMIT,
  GUEST_WORK_ITEM_LIMIT,
  assertMcpTokenCap,
  assertProjectCap,
  assertWorkItemCap,
  claimGuestOrganization,
  deleteGuestOrganization,
  findExpiredGuestOrganizationIds,
} from "@/lib/guest.ts";
import { beginProviderOAuth, integrationProvider } from "@/lib/integrations/core.ts";
import { createTestDb } from "./support/local-pg.mjs";

const guest = { userId: "u_guest", email: "guest@planbraid.local", displayName: "Guest", authentication: "browser", isGuest: true };
const real = { userId: "u_real", email: "real@planbraid.local", displayName: "Real Person", authentication: "browser" };

async function orgRow(db, organizationId) {
  return db.prepare("SELECT is_guest, guest_expires_at, owner_user_id FROM organizations WHERE id = ?").bind(organizationId).first();
}

test("a brand-new anonymous principal gets a guest-marked, pre-seeded workspace", async () => {
  const db = await createTestDb();
  const organizationId = await organizationFor(db, guest);
  const org = await orgRow(db, organizationId);
  assert.equal(org.is_guest, true);
  assert.ok(new Date(org.guest_expires_at).getTime() > Date.now(), "TTL should be set in the future");

  const dashboard = await loadDashboard(db, guest);
  assert.equal(dashboard.projects.length, 1, "the seed creates exactly one demo project");
  assert.equal(dashboard.workItems.length, 5, "the seed creates a small, legible board, not an empty one");

  const done = dashboard.workItems.find((item) => item.title === "Design the sign-in flow");
  const api = dashboard.workItems.find((item) => item.title === "Build the sign-in API");
  const ui = dashboard.workItems.find((item) => item.title === "Wire up the sign-in screen");
  assert.equal(done.status, "done");
  assert.equal(api.blockingCount, 0, "its blocker is already done, so it should not read as blocked");
  assert.equal(ui.blockingCount, 1, "seeded blocked-on-api, so a visitor can watch it auto-unblock live");
  assert.equal(dashboard.dependencies.length, 2);
});

test("finishing the seeded blocker auto-unblocks the dependent, live", async () => {
  const db = await createTestDb();
  await organizationFor(db, guest);
  const before = await loadDashboard(db, guest);
  const api = before.workItems.find((item) => item.title === "Build the sign-in API");
  const projectId = before.projects[0].id;

  // proposed -> done is not a legal direct hop (ALLOWED_TRANSITIONS in lib/contracts.ts);
  // completing seeded, not-yet-started work goes through in_progress first, same as a
  // real agent would.
  await executeCommand(db, guest, { action: "transition_item", projectId, itemId: api.id, expectedVersion: api.version, status: "in_progress", idempotencyKey: "test-start-api" });
  await executeCommand(db, guest, { action: "transition_item", projectId, itemId: api.id, expectedVersion: api.version + 1, status: "done", idempotencyKey: "test-complete-api" });

  const after = await loadDashboard(db, guest);
  const ui = after.workItems.find((item) => item.title === "Wire up the sign-in screen");
  assert.equal(ui.blockingCount, 0, "completing the blocker should clear the dependent's blocking count");
});

test("revisiting an anonymous session refreshes the TTL instead of re-seeding", async () => {
  const db = await createTestDb();
  const organizationId = await organizationFor(db, guest);
  await db.prepare("UPDATE organizations SET guest_expires_at = now() + interval '1 minute' WHERE id = ?").bind(organizationId).run();

  const again = await organizationFor(db, guest);
  assert.equal(again, organizationId, "the same anonymous user always lands on the same guest org");
  const org = await orgRow(db, organizationId);
  assert.ok(new Date(org.guest_expires_at).getTime() > Date.now() + 60_000, "a later visit should push the expiry back out");

  const dashboard = await loadDashboard(db, guest);
  assert.equal(dashboard.projects.length, 1, "a second visit must not seed a second demo project");
});

test("a real (non-guest) principal is never subject to guest caps", async () => {
  const db = await createTestDb();
  const organizationId = await organizationFor(db, real);
  await assert.doesNotReject(assertProjectCap(db, organizationId, real.isGuest));
  await assert.doesNotReject(assertWorkItemCap(db, organizationId, real.isGuest));
  await assert.doesNotReject(assertMcpTokenCap(db, organizationId, real.isGuest));
});

test("guest project cap is enforced end to end through executeCommand", async () => {
  const db = await createTestDb();
  const organizationId = await organizationFor(db, guest); // seeds project #1
  assert.equal((await loadDashboard(db, guest)).projects.length, 1);

  // Room for exactly one more before the cap (GUEST_PROJECT_LIMIT = 2) is reached.
  await executeCommand(db, guest, { action: "create_project", name: "Second project", idempotencyKey: "p2" });
  assert.equal((await loadDashboard(db, guest)).projects.length, GUEST_PROJECT_LIMIT);

  await assert.rejects(
    executeCommand(db, guest, { action: "create_project", name: "Third project", idempotencyKey: "p3" }),
    (error) => error.code === "GUEST_LIMIT_REACHED",
  );
  const org = await orgRow(db, organizationId);
  assert.equal(org.is_guest, true, "a rejected write must not somehow clear the guest marker");
});

test("guest work item and MCP token caps trip at the configured limit", async () => {
  const db = await createTestDb();
  const organizationId = await organizationFor(db, real); // a plain org, no seed noise
  await db.prepare("UPDATE organizations SET is_guest = true WHERE id = ?").bind(organizationId).run();

  await db.prepare("INSERT INTO work_items (id, organization_id, project_id, sequence, item_key, title) SELECT 'wi_cap_' || g, ?, 'prj_fake', g, '#' || g, 'filler' FROM generate_series(1, ?) AS g")
    .bind(organizationId, GUEST_WORK_ITEM_LIMIT).run();
  await assert.rejects(assertWorkItemCap(db, organizationId, true), (error) => error.code === "GUEST_LIMIT_REACHED");

  for (let index = 0; index < GUEST_MCP_TOKEN_LIMIT; index += 1) await createMcpToken(db, { ...real, isGuest: true }, `token ${index}`);
  await assert.rejects(createMcpToken(db, { ...real, isGuest: true }, "one too many"), (error) => error.code === "GUEST_LIMIT_REACHED");
});

test("claiming a guest workspace on real sign-up hands it over intact", async () => {
  const db = await createTestDb();
  const organizationId = await organizationFor(db, guest);
  const token = await createMcpToken(db, guest, "My agent");

  await claimGuestOrganization(db, guest.userId, real.userId);

  const claimed = await organizationFor(db, real);
  assert.equal(claimed, organizationId, "the real account should land on the same org, not a fresh one");
  const org = await orgRow(db, organizationId);
  assert.equal(org.is_guest, false);
  assert.equal(org.owner_user_id, real.userId);
  assert.equal(org.guest_expires_at, null);

  const tokens = await db.prepare("SELECT owner_user_id FROM mcp_tokens WHERE id = ?").bind(token.id).first();
  assert.equal(tokens.owner_user_id, real.userId, "an agent connection made before claiming should keep working under the real account");
});

test("claiming never overwrites an account that already owns a workspace", async () => {
  const db = await createTestDb();
  const guestOrgId = await organizationFor(db, guest);
  const realOrgId = await organizationFor(db, real);

  await claimGuestOrganization(db, guest.userId, real.userId);

  const guestOrg = await orgRow(db, guestOrgId);
  assert.equal(guestOrg.is_guest, true, "an already-owned account must not silently absorb a stranger's sandbox");
  assert.equal(guestOrg.owner_user_id, guest.userId);
  const untouchedReal = await orgRow(db, realOrgId);
  assert.equal(untouchedReal.owner_user_id, real.userId);
});

test("expired guest organizations are found and fully deleted, claimed ones never are", async () => {
  const db = await createTestDb();
  const organizationId = await organizationFor(db, guest);
  await db.prepare("UPDATE organizations SET guest_expires_at = now() - interval '1 hour' WHERE id = ?").bind(organizationId).run();

  assert.deepEqual(await findExpiredGuestOrganizationIds(db), [organizationId]);

  const claimedOrgId = await organizationFor(db, real);
  assert.equal(await deleteGuestOrganization(db, claimedOrgId), false, "a claimed (non-guest) organization must refuse deletion even if asked");
  assert.ok(await orgRow(db, claimedOrgId), "and must still exist afterward");

  assert.equal(await deleteGuestOrganization(db, organizationId), true);
  assert.equal(await orgRow(db, organizationId), null);
  assert.equal((await db.prepare("SELECT COUNT(*)::int AS count FROM work_items WHERE organization_id = ?").bind(organizationId).first()).count, 0);
  assert.equal((await db.prepare("SELECT COUNT(*)::int AS count FROM projects WHERE organization_id = ?").bind(organizationId).first()).count, 0);
});

test("a guest principal is refused before a real OAuth connection is ever started", async () => {
  const db = await createTestDb();
  await assert.rejects(
    beginProviderOAuth(db, guest, integrationProvider("basecamp"), null, new Request("http://localhost/api/integrations/basecamp/connect")),
    (error) => error.code === "GUEST_INTEGRATIONS_DISABLED",
  );
});
