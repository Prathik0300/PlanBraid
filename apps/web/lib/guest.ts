/**
 * Guest sandboxes: an unclaimed, capped, auto-expiring workspace for a visitor who
 * signed in through better-auth's anonymous plugin (see lib/auth.ts) instead of creating
 * an account. Deliberately kept independent of lib/store.ts (which imports from here, for
 * cap checks in executeCommand/createMcpToken) to avoid a circular import — everything
 * below works off a bare organizationId/PgD1, never a Principal.
 *
 * Real third-party integrations (GitHub/Basecamp/Jira/Slack) are refused for a guest
 * organization entirely rather than allowed and cleaned up later: they mean storing a
 * real, long-lived OAuth token against a throwaway anonymous user, and a dangling
 * webhook or GitHub App install outliving the sandbox is a liability an unclaimed
 * session should never be able to create. See lib/integrations/core.ts and
 * app/api/github/connect/route.ts.
 */
import type { PgD1 } from "@/db/pg-d1";

/** How long an unclaimed guest workspace survives past its last visit. Refreshed on
 * every request from that session (touchGuestOrganization), so an active exploration
 * never expires mid-session — only an abandoned one does. */
export const GUEST_TTL_MS = 48 * 60 * 60 * 1000;

/** Caps on a guest organization, generous enough that the sandbox still feels like the
 * real product but tight enough that an anonymous script can't grow one into a real
 * workload. Enforced in lib/store.ts's executeCommand/createMcpToken. */
export const GUEST_PROJECT_LIMIT = 2;
export const GUEST_WORK_ITEM_LIMIT = 60;
export const GUEST_MCP_TOKEN_LIMIT = 3;

function guestError(code: string, message: string, status = 403) {
  return Object.assign(new Error(message), { code, status });
}

export function guestLimitError(subject: string) {
  return guestError("GUEST_LIMIT_REACHED", `Guest sandboxes are capped at ${subject}. Sign up for a free account to remove the limit and keep this workspace.`);
}

export function guestIntegrationsDisabledError() {
  return guestError("GUEST_INTEGRATIONS_DISABLED", "Connecting a real integration needs a free account. Sign up to keep this sandbox and connect GitHub, Basecamp, Jira, or Slack.");
}

/** Marks an organization as an unclaimed guest sandbox and (re)starts its TTL. Called
 * from lib/store.ts's organizationFor on every request from an anonymous principal —
 * once to mark a brand-new organization, and again on each later visit so an anonymous
 * visitor who keeps coming back never loses it mid-exploration. */
export async function touchGuestOrganization(db: PgD1, organizationId: string) {
  await db.prepare(`UPDATE organizations SET is_guest = true, guest_expires_at = now() + (?::text || ' milliseconds')::interval WHERE id = ?`)
    .bind(String(GUEST_TTL_MS), organizationId).run();
}

export async function assertProjectCap(db: PgD1, organizationId: string, isGuest: boolean | undefined) {
  if (!isGuest) return;
  const row = await db.prepare("SELECT COUNT(*)::int AS count FROM projects WHERE organization_id = ? AND status <> 'archived'").bind(organizationId).first<{ count: number }>();
  if ((row?.count ?? 0) >= GUEST_PROJECT_LIMIT) throw guestLimitError(`${GUEST_PROJECT_LIMIT} projects`);
}

export async function assertWorkItemCap(db: PgD1, organizationId: string, isGuest: boolean | undefined) {
  if (!isGuest) return;
  const row = await db.prepare("SELECT COUNT(*)::int AS count FROM work_items WHERE organization_id = ? AND archived_at IS NULL").bind(organizationId).first<{ count: number }>();
  if ((row?.count ?? 0) >= GUEST_WORK_ITEM_LIMIT) throw guestLimitError(`${GUEST_WORK_ITEM_LIMIT} tasks`);
}

export async function assertMcpTokenCap(db: PgD1, organizationId: string, isGuest: boolean | undefined) {
  if (!isGuest) return;
  const row = await db.prepare("SELECT COUNT(*)::int AS count FROM mcp_tokens WHERE organization_id = ? AND revoked_at IS NULL").bind(organizationId).first<{ count: number }>();
  if ((row?.count ?? 0) >= GUEST_MCP_TOKEN_LIMIT) throw guestLimitError(`${GUEST_MCP_TOKEN_LIMIT} agent connections`);
}

/**
 * Reassigns an unclaimed guest workspace to the real account that just linked to it
 * (better-auth anonymous plugin's onLinkAccount, wired in lib/auth.ts), so signing up
 * keeps the sandbox instead of losing it. A no-op if the new account already owns a
 * workspace of its own — organizations.owner_user_id is UNIQUE, and a rare visitor who
 * went anonymous once and separately already has a real account should never have their
 * existing workspace silently overwritten by a demo one. The orphaned guest org is left
 * for the TTL cron rather than force-merged.
 */
export async function claimGuestOrganization(db: PgD1, anonymousUserId: string, newUserId: string) {
  if (anonymousUserId === newUserId) return;
  const alreadyOwned = await db.prepare("SELECT 1 FROM organizations WHERE owner_user_id = ?").bind(newUserId).first();
  if (alreadyOwned) return;
  const guestOrg = await db.prepare("SELECT id FROM organizations WHERE owner_user_id = ? AND is_guest = true").bind(anonymousUserId).first<{ id: string }>();
  if (!guestOrg) return;
  await db.batch([
    db.prepare("UPDATE organizations SET owner_user_id = ?, is_guest = false, guest_expires_at = NULL WHERE id = ?").bind(newUserId, guestOrg.id),
    db.prepare("UPDATE mcp_tokens SET owner_user_id = ? WHERE organization_id = ? AND owner_user_id = ?").bind(newUserId, guestOrg.id, anonymousUserId),
    db.prepare("UPDATE notifications SET recipient_user_id = ? WHERE organization_id = ? AND recipient_user_id = ?").bind(newUserId, guestOrg.id, anonymousUserId),
  ]);
}

/** Guest organizations whose TTL has passed, oldest first. Paged by the cleanup cron
 * (app/api/guest/cleanup/route.ts) rather than fetched all at once. */
export async function findExpiredGuestOrganizationIds(db: PgD1, limit = 25) {
  const rows = await db.prepare("SELECT id FROM organizations WHERE is_guest = true AND guest_expires_at < now() ORDER BY guest_expires_at LIMIT ?")
    .bind(limit).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

/**
 * Cascades a guest organization's data away entirely. None of this schema's
 * project-scoped tables carry ON DELETE CASCADE (see lib/contracts.ts's delete_project
 * comment), so this deletes table by table in dependency order, the same pattern
 * lib/store.ts's removeLegacyDemoData already uses for its two hard-coded legacy
 * projects — widened here to every table a guest session could plausibly have touched
 * and scoped by organization_id instead of a fixed project list. Returns false without
 * deleting anything if the organization is not (or is no longer) a guest workspace, so a
 * claim racing the cleanup cron can never delete a workspace someone just signed up to
 * keep.
 */
export async function deleteGuestOrganization(db: PgD1, organizationId: string) {
  const org = await db.prepare("SELECT owner_user_id FROM organizations WHERE id = ? AND is_guest = true").bind(organizationId).first<{ owner_user_id: string }>();
  if (!org) return false;
  await db.batch([
    db.prepare("DELETE FROM notifications WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM evidence WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM work_item_artifacts WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM work_item_tokens WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM work_item_embeddings WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM work_item_aliases WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM work_item_assignees WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM decision_options WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM reconciliation_judgment_requests WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM reconciliation_labels WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM simplification_findings WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM simplification_runs WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM import_requests WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM dependencies WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM work_claims WHERE work_item_id IN (SELECT id FROM work_items WHERE organization_id = ?)").bind(organizationId),
    db.prepare("DELETE FROM work_events WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM repo_observations WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM repo_symbols WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM interactions WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM work_items WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM external_items WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM work_item_external_links WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM integration_webhook_inbox WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM integration_outbox WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM integration_sync_runs WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM integration_channel_bindings WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM integration_bindings WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM integration_oauth_states WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM integration_connections WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM project_access_blocks WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM sources WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM coding_spaces WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM project_members WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM mcp_tokens WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM push_subscriptions WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM plan_conflicts WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM plan_ops WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM plan_refs WHERE project_id IN (SELECT id FROM projects WHERE organization_id = ?)").bind(organizationId),
    db.prepare("DELETE FROM data_migrations WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM projects WHERE organization_id = ?").bind(organizationId),
    db.prepare("DELETE FROM github_connections WHERE owner_user_id = ?").bind(org.owner_user_id),
    db.prepare("DELETE FROM organizations WHERE id = ?").bind(organizationId),
    // Cascades session/account/auth_principal_links via their own ON DELETE CASCADE FKs
    // (db/setup.ts). Usually already gone by the time this runs — better-auth's
    // anonymous plugin deletes the user row itself on a successful claim — so this only
    // ever fires for a sandbox nobody claimed.
    db.prepare(`DELETE FROM "user" WHERE id = ? AND "isAnonymous" = true`).bind(org.owner_user_id),
  ]);
  return true;
}
