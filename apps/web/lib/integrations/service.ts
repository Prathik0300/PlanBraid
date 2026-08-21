import type { PgD1 } from "@/db/pg-d1";
import type { Proposal } from "@/lib/dedup/match";
import { createBasecampWebhook, fetchBasecampProjectItems, fetchBasecampTodo, listBasecampProjects, listBasecampResources } from "@/lib/integrations/basecamp";
import { domainError, integrationProvider, requireOwnedConnection, requireOwnedProject } from "@/lib/integrations/core";
import { createJiraWebhook, fetchJiraIssue, fetchJiraProjectItems, listJiraProjects, listJiraResources, refreshJiraWebhook } from "@/lib/integrations/jira";
import type { ExternalCandidate, IntegrationBindingSummary, IntegrationProvider, NormalizedExternalItem, ProviderRequest } from "@/lib/integrations/types";
import { constantTimeEqual, integrationId, parseJson, randomSecret, sha256, stableJson } from "@/lib/integrations/utils";
import { openSecret, sealSecret } from "@/lib/crypto-box";
import { createWorkItemsDeduplicated, executeCommand, organizationFor, type Principal } from "@/lib/store";

type Row = Record<string, unknown>;

export async function providerResources(db: PgD1, principal: Principal, provider: IntegrationProvider, connectionId: string, fetcher: ProviderRequest = fetch) {
  await requireOwnedConnection(db, principal, connectionId, provider);
  return provider === "basecamp" ? listBasecampResources(db, connectionId, fetcher) : listJiraResources(db, connectionId, fetcher);
}

export async function providerProjects(db: PgD1, principal: Principal, provider: IntegrationProvider, connectionId: string, accountId: string, fetcher: ProviderRequest = fetch) {
  await requireOwnedConnection(db, principal, connectionId, provider);
  return provider === "basecamp" ? listBasecampProjects(db, connectionId, accountId, fetcher) : listJiraProjects(db, connectionId, accountId, fetcher);
}

export async function createBinding(db: PgD1, principal: Principal, input: {
  projectId: string | null;
  provider: IntegrationProvider;
  connectionId: string;
  externalAccountId: string;
  externalProjectId: string;
  filterQuery?: string;
  origin: string;
  projectIdempotencyKey?: string;
}, fetcher: ProviderRequest = fetch) {
  if (!input.projectId && input.provider !== "basecamp") throw domainError("VALIDATION_FAILED", "Choose a Planbraid project for this integration", 422);
  if (input.provider === "jira" && /\border\s+by\b/i.test(input.filterQuery ?? "")) {
    throw domainError("JIRA_FILTER_INVALID", "Enter only Jira filter conditions; Planbraid controls result ordering", 422);
  }
  const { organizationId } = await requireOwnedConnection(db, principal, input.connectionId, input.provider);
  const projects = await providerProjects(db, principal, input.provider, input.connectionId, input.externalAccountId, fetcher);
  const external = projects.find((project) => project.id === input.externalProjectId);
  if (!external) throw domainError("EXTERNAL_PROJECT_NOT_FOUND", "The selected external project is not available to this connection", 404);

  let projectId = input.projectId;
  let projectCreated = false;
  if (!projectId) {
    const created = await executeCommand(db, principal, {
      action: "create_project",
      name: external.name,
      description: external.description,
      idempotencyKey: input.projectIdempotencyKey ?? `basecamp-import-${crypto.randomUUID()}`,
    }) as { projectId: string; status?: string };
    projectId = String(created.projectId);
    projectCreated = created.status === "created";
  }
  await requireOwnedProject(db, organizationId, projectId);

  const bindingId = integrationId("ibn");
  const callbackSecret = randomSecret(32);
  const callbackHash = await sha256(callbackSecret);
  const row = await db.prepare("INSERT INTO integration_bindings (id, organization_id, project_id, connection_id, provider, external_account_id, external_account_name, external_project_id, external_project_key, external_project_name, external_base_url, filter_query, settings, webhook_secret, webhook_secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, provider, external_account_id, external_project_id) DO UPDATE SET connection_id = excluded.connection_id, external_account_name = excluded.external_account_name, external_project_key = excluded.external_project_key, external_project_name = excluded.external_project_name, external_base_url = excluded.external_base_url, filter_query = excluded.filter_query, settings = excluded.settings, status = 'active', updated_at = now() RETURNING *")
    .bind(bindingId, organizationId, projectId, input.connectionId, input.provider, external.accountId, external.accountName, external.id, external.key, external.name, external.baseUrl, input.filterQuery?.trim().slice(0, 2000) ?? "", JSON.stringify({ externalProjectUrl: external.url }), await sealSecret(callbackSecret), callbackHash).first<Row>();
  if (!row) throw domainError("BINDING_SAVE_FAILED", "The integration binding could not be stored", 500);

  // Provider webhook destinations must be public HTTPS. Local development retains a
  // fully usable manual/reconciliation binding and reports webhook_pending_local rather
  // than attempting to register an invalid callback URL.
  const normalizedOrigin = input.origin.replace(/\/$/, "");
  if (normalizedOrigin.startsWith("https://") && !row.webhook_id) {
    try { await registerBindingWebhook(db, row, normalizedOrigin, fetcher); }
    catch (error) { await markBindingError(db, String(row.id), errorCode(error)); }
  } else {
    await markBindingError(db, String(row.id), "WEBHOOK_PENDING_HTTPS");
  }
  return { bindingId: String(row.id), externalProject: external, projectId, projectCreated };
}

export async function listBindings(db: PgD1, principal: Principal, projectId: string): Promise<IntegrationBindingSummary[]> {
  const organizationId = await organizationFor(db, principal);
  await requireOwnedProject(db, organizationId, projectId);
  const result = await db.prepare(`SELECT b.*,
      COUNT(e.id) FILTER (WHERE e.review_status = 'pending') AS pending_count,
      COUNT(e.id) FILTER (WHERE e.review_status IN ('imported','matched')) AS imported_count
    FROM integration_bindings b LEFT JOIN external_items e ON e.binding_id = b.id
    WHERE b.organization_id = ? AND b.project_id = ? AND b.status <> 'disconnected'
    GROUP BY b.id ORDER BY b.created_at`)
    .bind(organizationId, projectId).all<Row>();
  return result.results.map(mapBinding);
}

/** Same as listBindings but across every project in the org - the account-level
 * Integrations tab has no single project in view, unlike the per-project dialog. */
export async function listAllBindings(db: PgD1, principal: Principal): Promise<IntegrationBindingSummary[]> {
  const organizationId = await organizationFor(db, principal);
  const result = await db.prepare(`SELECT b.*,
      COUNT(e.id) FILTER (WHERE e.review_status = 'pending') AS pending_count,
      COUNT(e.id) FILTER (WHERE e.review_status IN ('imported','matched')) AS imported_count
    FROM integration_bindings b LEFT JOIN external_items e ON e.binding_id = b.id
    WHERE b.organization_id = ? AND b.status <> 'disconnected'
    GROUP BY b.id ORDER BY b.created_at`)
    .bind(organizationId).all<Row>();
  return result.results.map(mapBinding);
}

export async function listCandidates(db: PgD1, principal: Principal, bindingId: string, limit = 200): Promise<ExternalCandidate[]> {
  const binding = await ownedBinding(db, principal, bindingId);
  const result = await db.prepare(`SELECT e.*, l.work_item_id, w.item_key
    FROM external_items e
    LEFT JOIN work_item_external_links l ON l.external_item_id = e.id
    LEFT JOIN work_items w ON w.id = l.work_item_id
    WHERE e.binding_id = ? AND e.organization_id = ? AND e.tombstoned_at IS NULL
    ORDER BY CASE e.review_status WHEN 'pending' THEN 0 WHEN 'matched' THEN 1 WHEN 'imported' THEN 2 ELSE 3 END, e.updated_at DESC
    LIMIT ?`).bind(bindingId, String(binding.organization_id), Math.max(1, Math.min(limit, 500))).all<Row>();
  return result.results.map(mapCandidate);
}

export async function syncBinding(db: PgD1, principal: Principal, bindingId: string, runType = "manual", fetcher: ProviderRequest = fetch) {
  const binding = await ownedBinding(db, principal, bindingId);
  return syncBindingRow(db, binding, runType, fetcher);
}

export async function syncBindingRow(db: PgD1, binding: Row, runType: string, fetcher: ProviderRequest = fetch) {
  const runId = integrationId("isr");
  await db.prepare("INSERT INTO integration_sync_runs (id, organization_id, project_id, binding_id, provider, run_type) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(runId, binding.organization_id, binding.project_id, binding.id, binding.provider, runType).run();
  try {
    const provider = integrationProvider(String(binding.provider));
    const items = provider === "basecamp" ? await fetchBasecampProjectItems(db, binding, fetcher) : await fetchJiraProjectItems(db, binding, fetcher);
    const changed = await persistExternalItems(db, binding, items, true);
    await db.batch([
      db.prepare("UPDATE integration_sync_runs SET status = 'completed', fetched_count = ?, changed_count = ?, tombstoned_count = ?, completed_at = now() WHERE id = ?")
        .bind(items.length, changed.changed, changed.tombstoned, runId),
      db.prepare("UPDATE integration_bindings SET status = 'active', last_sync_at = now(), last_success_at = now(), last_error_code = NULL, last_error_at = NULL, updated_at = now() WHERE id = ?").bind(binding.id),
      db.prepare("UPDATE integration_connections SET status = 'connected', last_success_at = now(), last_error_code = NULL, last_error_at = NULL, updated_at = now() WHERE id = ?").bind(binding.connection_id),
    ]);
    return { runId, fetched: items.length, changed: changed.changed, tombstoned: changed.tombstoned };
  } catch (error) {
    const code = errorCode(error);
    await db.batch([
      db.prepare("UPDATE integration_sync_runs SET status = 'failed', error_count = 1, error_summary = ?, completed_at = now() WHERE id = ?").bind(code, runId),
      db.prepare("UPDATE integration_bindings SET status = 'degraded', last_error_code = ?, last_error_at = now(), updated_at = now() WHERE id = ?").bind(code, binding.id),
    ]);
    throw error;
  }
}

export async function applyCandidates(db: PgD1, principal: Principal, bindingId: string, externalItemIds?: string[]) {
  const binding = await ownedBinding(db, principal, bindingId);
  const organizationId = String(binding.organization_id);
  const requested = externalItemIds?.length ? [...new Set(externalItemIds)].slice(0, 100) : null;
  const query = requested
    ? "SELECT e.*, l.work_item_id, l.last_applied_hash FROM external_items e LEFT JOIN work_item_external_links l ON l.external_item_id = e.id WHERE e.binding_id = ? AND e.organization_id = ? AND e.id = ANY(?::text[]) AND e.tombstoned_at IS NULL"
    : "SELECT e.*, l.work_item_id, l.last_applied_hash FROM external_items e LEFT JOIN work_item_external_links l ON l.external_item_id = e.id WHERE e.binding_id = ? AND e.organization_id = ? AND e.review_status = 'pending' AND e.tombstoned_at IS NULL LIMIT 100";
  const rows = requested
    ? await db.prepare(query).bind(bindingId, organizationId, requested).all<Row>()
    : await db.prepare(query).bind(bindingId, organizationId).all<Row>();
  if (!rows.results.length) return { results: [], created: 0, matched: 0, updatedLinks: 0 };

  // Already-linked changes remain external observations. A deliberate Apply records a
  // concise note on the Planbraid item but never overwrites its title/description/status.
  const linked = rows.results.filter((row) => row.work_item_id);
  const integrationPrincipal: Principal = { ...principal, authentication: "oauth", displayName: `${providerLabel(String(binding.provider))} import` };
  for (const row of linked) {
    if (row.last_applied_hash === row.content_hash) continue;
    await executeCommand(db, integrationPrincipal, {
      action: "add_note", projectId: String(binding.project_id), itemId: String(row.work_item_id),
      summary: `${providerLabel(String(binding.provider))} update for ${String(row.external_key ?? row.external_id)}: ${String(row.external_status || "changed")}${row.canonical_url ? ` · ${String(row.canonical_url)}` : ""}`.slice(0, 2000),
      idempotencyKey: `external-update:${row.id}:${row.content_hash}`,
    });
    await db.batch([
      db.prepare("UPDATE work_item_external_links SET last_applied_hash = ?, updated_at = now() WHERE external_item_id = ?").bind(row.content_hash, row.id),
      db.prepare("UPDATE external_items SET review_status = 'imported', updated_at = now() WHERE id = ?").bind(row.id),
    ]);
  }

  const unlinked = rows.results.filter((row) => !row.work_item_id).sort((left, right) => Number(Boolean(left.parent_external_id)) - Number(Boolean(right.parent_external_id)));
  if (!unlinked.length) return { results: linked.map((row) => ({ externalItemId: row.id, status: "updated_link" })), created: 0, matched: 0, updatedLinks: linked.length };
  const proposals: Proposal[] = unlinked.map((row) => ({
    ref: String(row.external_id), title: String(row.title), status: "proposed", priority: String(row.priority),
    description: externalDescription(row, binding),
  }));
  const outcome = await createWorkItemsDeduplicated(db, integrationPrincipal, {
    projectId: String(binding.project_id), proposals, idempotencyKey: `external-import:${bindingId}:${await sha256(unlinked.map((row) => `${row.id}:${row.content_hash}`).join("|"))}`,
  });
  const results = (outcome as { results?: Array<Record<string, unknown>> }).results ?? [];
  const targetByExternalId = new Map<string, string>();
  for (const result of results) {
    const ref = result.ref ? String(result.ref) : null;
    const workItemId = result.workItemId ? String(result.workItemId) : null;
    if (ref && workItemId) targetByExternalId.set(ref, workItemId);
  }
  for (const row of unlinked) {
    const workItemId = targetByExternalId.get(String(row.external_id));
    if (!workItemId) continue;
    const result = results.find((entry) => String(entry.ref ?? "") === String(row.external_id));
    await db.batch([
      db.prepare("INSERT INTO work_item_external_links (id, organization_id, project_id, binding_id, external_item_id, work_item_id, link_kind, last_applied_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (external_item_id) DO UPDATE SET work_item_id = excluded.work_item_id, link_kind = excluded.link_kind, last_applied_hash = excluded.last_applied_hash, updated_at = now()")
        .bind(integrationId("xel"), organizationId, binding.project_id, bindingId, row.id, workItemId, result?.status === "matched" ? "matched" : "imported", row.content_hash),
      db.prepare("UPDATE external_items SET review_status = ?, updated_at = now() WHERE id = ?")
        .bind(result?.status === "matched" ? "matched" : "imported", row.id),
    ]);
  }
  await applyExternalRelations(db, integrationPrincipal, binding, rows.results);
  return {
    results: [...linked.map((row) => ({ externalItemId: row.id, status: "updated_link" })), ...results],
    created: results.filter((entry) => entry.status === "created").length,
    matched: results.filter((entry) => entry.status === "matched").length,
    updatedLinks: linked.length,
  };
}

export async function ignoreCandidate(db: PgD1, principal: Principal, bindingId: string, externalItemId: string) {
  const binding = await ownedBinding(db, principal, bindingId);
  const result = await db.prepare("UPDATE external_items SET review_status = 'ignored', updated_at = now() WHERE id = ? AND binding_id = ? AND organization_id = ? RETURNING id")
    .bind(externalItemId, bindingId, binding.organization_id).first();
  if (!result) throw domainError("EXTERNAL_ITEM_NOT_FOUND", "External item not found", 404);
}

export async function disconnectBinding(db: PgD1, principal: Principal, bindingId: string) {
  const binding = await ownedBinding(db, principal, bindingId);
  // Disconnect is deliberately local-only. Planbraid must never delete Basecamp or
  // Jira data or configuration, including provider-side webhook registrations. A stale
  // provider delivery is harmless: this binding no longer resolves and is ignored.
  await db.prepare("UPDATE integration_bindings SET status = 'disconnected', webhook_id = NULL, updated_at = now() WHERE id = ? AND organization_id = ?")
    .bind(bindingId, binding.organization_id).run();
}

export async function refreshDueJiraWebhooks(db: PgD1, fetcher: ProviderRequest = fetch) {
  const result = await db.prepare("SELECT * FROM integration_bindings WHERE provider = 'jira' AND status <> 'disconnected' AND webhook_id IS NOT NULL AND (webhook_expires_at IS NULL OR webhook_expires_at < now() + interval '7 days') LIMIT 50").all<Row>();
  let refreshed = 0;
  for (const binding of result.results) {
    try {
      const expiresAt = await refreshJiraWebhook(db, binding, fetcher);
      await db.prepare("UPDATE integration_bindings SET webhook_expires_at = ?, status = 'active', last_error_code = NULL, updated_at = now() WHERE id = ?").bind(expiresAt, binding.id).run();
      refreshed += 1;
    } catch (error) { await markBindingError(db, String(binding.id), errorCode(error)); }
  }
  return refreshed;
}

/** Webhooks reduce latency, but neither provider promises they are a permanent ledger.
 * This reconciliation pass heals missed/deactivated deliveries and also registers a
 * webhook for bindings first created on localhost once they reach an HTTPS deployment. */
export async function reconcileDueBindings(db: PgD1, origin: string, fetcher: ProviderRequest = fetch) {
  const result = await db.prepare("SELECT * FROM integration_bindings WHERE status <> 'disconnected' AND (last_sync_at IS NULL OR last_sync_at < now() - interval '6 hours') ORDER BY COALESCE(last_sync_at, created_at) LIMIT 20").all<Row>();
  let synced = 0;
  let registeredWebhooks = 0;
  for (const binding of result.results) {
    try {
      if (!binding.webhook_id && origin.startsWith("https://")) { await registerBindingWebhook(db, binding, origin.replace(/\/$/, ""), fetcher); registeredWebhooks += 1; }
      await syncBindingRow(db, binding, "scheduled_reconcile", fetcher);
      synced += 1;
    } catch (error) { await markBindingError(db, String(binding.id), errorCode(error)); }
  }
  return { synced, registeredWebhooks };
}

export async function receiveWebhook(db: PgD1, providerValue: string, bindingId: string, callbackSecret: string, authorization: string | null, deliveryKey: string | null, payloadText: string) {
  const provider = integrationProvider(providerValue);
  const binding = await db.prepare("SELECT * FROM integration_bindings WHERE id = ? AND provider = ? AND status <> 'disconnected'").bind(bindingId, provider).first<Row>();
  if (!binding) throw domainError("BINDING_NOT_FOUND", "Integration binding not found", 404);
  const actualHash = await sha256(callbackSecret);
  if (!constantTimeEqual(actualHash, String(binding.webhook_secret_hash))) throw domainError("WEBHOOK_UNAUTHORIZED", "Webhook callback secret is invalid", 401);
  if (provider === "jira") {
    const { verifyJiraWebhookBearer } = await import("@/lib/integrations/jira");
    if (!verifyJiraWebhookBearer(authorization)) throw domainError("WEBHOOK_UNAUTHORIZED", "Jira webhook signature is invalid", 401);
  }
  let payload: Row;
  try { payload = JSON.parse(payloadText) as Row; } catch { throw domainError("WEBHOOK_INVALID", "Webhook payload is not valid JSON", 400); }
  const payloadHash = await sha256(payloadText);
  const key = (deliveryKey || webhookDeliveryKey(provider, payload, payloadHash)).slice(0, 240);
  const inboxId = integrationId("iwh");
  const inserted = await db.prepare("INSERT INTO integration_webhook_inbox (id, organization_id, binding_id, provider, delivery_key, payload_hash, payload) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (binding_id, delivery_key) DO NOTHING RETURNING id")
    .bind(inboxId, binding.organization_id, bindingId, provider, key, payloadHash, payloadText).first<{ id: string }>();
  return { inboxId: inserted?.id ?? null, duplicate: !inserted };
}

export async function processWebhookInbox(db: PgD1, inboxId: string, fetcher: ProviderRequest = fetch) {
  const inbox = await db.prepare("UPDATE integration_webhook_inbox SET status = 'processing', attempts = attempts + 1 WHERE id = ? AND status IN ('pending','failed') RETURNING *").bind(inboxId).first<Row>();
  if (!inbox) return { processed: false };
  const binding = await db.prepare("SELECT * FROM integration_bindings WHERE id = ? AND status <> 'disconnected'").bind(inbox.binding_id).first<Row>();
  if (!binding) {
    await db.prepare("UPDATE integration_webhook_inbox SET status = 'processed', processed_at = now(), last_error = 'BINDING_DISCONNECTED' WHERE id = ?").bind(inboxId).run();
    return { processed: true };
  }
  const payload = parseJson<Row>(inbox.payload, {});
  try {
    const provider = integrationProvider(String(inbox.provider));
    if (provider === "basecamp") {
      const recording = payload.recording && typeof payload.recording === "object" ? payload.recording as Row : {};
      const type = String(recording.type ?? "");
      if (type === "Todo" && recording.id) {
        if (String(payload.kind ?? "").includes("trashed")) await tombstoneExternalItem(db, String(binding.id), String(recording.id));
        else await persistExternalItems(db, binding, [await fetchBasecampTodo(db, binding, String(recording.id), fetcher)], false);
      } else {
        await syncBindingRow(db, binding, "webhook_reconcile", fetcher);
      }
    } else {
      const issue = payload.issue && typeof payload.issue === "object" ? payload.issue as Row : {};
      const issueId = issue.id ? String(issue.id) : "";
      const event = String(payload.webhookEvent ?? "");
      if (issueId && event.includes("deleted")) await tombstoneExternalItem(db, String(binding.id), issueId);
      else if (issueId) await persistExternalItems(db, binding, [await fetchJiraIssue(db, binding, issueId, fetcher)], false);
      else await syncBindingRow(db, binding, "webhook_reconcile", fetcher);
    }
    await db.prepare("UPDATE integration_webhook_inbox SET status = 'processed', processed_at = now(), last_error = NULL WHERE id = ?").bind(inboxId).run();
    return { processed: true };
  } catch (error) {
    const attempts = Number(inbox.attempts ?? 1);
    const next = new Date(Date.now() + Math.min(60 * 60_000, 2 ** attempts * 30_000)).toISOString();
    await db.prepare("UPDATE integration_webhook_inbox SET status = 'failed', next_attempt_at = ?, last_error = ? WHERE id = ?").bind(next, errorCode(error), inboxId).run();
    throw error;
  }
}

export async function processPendingWebhooks(db: PgD1, fetcher: ProviderRequest = fetch) {
  const result = await db.prepare("SELECT id FROM integration_webhook_inbox WHERE status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY received_at LIMIT 50").all<{ id: string }>();
  let processed = 0;
  for (const row of result.results) {
    try { const outcome = await processWebhookInbox(db, row.id, fetcher); if (outcome.processed) processed += 1; } catch { /* retained for next retry */ }
  }
  return processed;
}

async function registerBindingWebhook(db: PgD1, binding: Row, origin: string, fetcher: ProviderRequest) {
  const secret = await openSecret(String(binding.webhook_secret));
  if (!secret) throw domainError("WEBHOOK_SECRET_UNREADABLE", "The webhook secret can no longer be decrypted", 503);
  const callbackUrl = `${origin}/api/integrations/webhooks/${binding.provider}/${binding.id}/${secret}`;
  const registered = binding.provider === "basecamp"
    ? await createBasecampWebhook(db, binding, callbackUrl, fetcher)
    : await createJiraWebhook(db, binding, callbackUrl, fetcher);
  await db.prepare("UPDATE integration_bindings SET webhook_id = ?, webhook_expires_at = ?, status = 'active', last_error_code = NULL, last_error_at = NULL, updated_at = now() WHERE id = ?")
    .bind(registered.id, registered.expiresAt, binding.id).run();
}

async function ownedBinding(db: PgD1, principal: Principal, bindingId: string) {
  const organizationId = await organizationFor(db, principal);
  const row = await db.prepare("SELECT b.* FROM integration_bindings b JOIN integration_connections c ON c.id = b.connection_id WHERE b.id = ? AND b.organization_id = ? AND c.owner_user_id = ? AND b.status <> 'disconnected'")
    .bind(bindingId, organizationId, principal.userId).first<Row>();
  if (!row) throw domainError("BINDING_NOT_FOUND", "Integration binding not found", 404);
  return row;
}

async function persistExternalItems(db: PgD1, binding: Row, items: NormalizedExternalItem[], fullSync: boolean) {
  const seen: string[] = [];
  let changed = 0;
  for (const item of items) {
    seen.push(item.externalId);
    const normalized = { ...item, raw: undefined };
    const contentHash = await sha256(stableJson(normalized));
    const existing = await db.prepare("SELECT id, content_hash FROM external_items WHERE binding_id = ? AND external_id = ?").bind(binding.id, item.externalId).first<{ id: string; content_hash: string }>();
    if (!existing || existing.content_hash !== contentHash) changed += 1;
    await db.prepare(`INSERT INTO external_items (id, organization_id, project_id, binding_id, provider, external_id, external_key, item_type, title, description, external_status, normalized_status, priority, assignee, due_at, parent_external_id, canonical_url, external_revision, content_hash, normalized_snapshot, raw_snapshot, review_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      ON CONFLICT (binding_id, external_id) DO UPDATE SET external_key = excluded.external_key, item_type = excluded.item_type, title = excluded.title, description = excluded.description, external_status = excluded.external_status, normalized_status = excluded.normalized_status, priority = excluded.priority, assignee = excluded.assignee, due_at = excluded.due_at, parent_external_id = excluded.parent_external_id, canonical_url = excluded.canonical_url, external_revision = excluded.external_revision, normalized_snapshot = excluded.normalized_snapshot, raw_snapshot = excluded.raw_snapshot, review_status = CASE WHEN external_items.content_hash = excluded.content_hash THEN external_items.review_status WHEN external_items.review_status = 'ignored' THEN 'ignored' ELSE 'pending' END, content_hash = excluded.content_hash, tombstoned_at = NULL, last_seen_at = now(), updated_at = CASE WHEN external_items.content_hash = excluded.content_hash THEN external_items.updated_at ELSE now() END`)
      .bind(existing?.id ?? integrationId("ext"), binding.organization_id, binding.project_id, binding.id, binding.provider, item.externalId, item.externalKey, item.itemType, item.title.slice(0, 500), item.description.slice(0, 20_000), item.externalStatus.slice(0, 200), item.normalizedStatus, item.priority, item.assignee?.slice(0, 500) ?? null, item.dueAt, item.parentExternalId, item.canonicalUrl.slice(0, 2_000), item.externalRevision, contentHash, JSON.stringify(normalized), JSON.stringify(item.raw)).run();
  }
  let tombstoned = 0;
  if (fullSync) {
    const result = seen.length
      ? await db.prepare("UPDATE external_items SET tombstoned_at = COALESCE(tombstoned_at, now()), review_status = 'pending', updated_at = now() WHERE binding_id = ? AND tombstoned_at IS NULL AND NOT (external_id = ANY(?::text[])) RETURNING id").bind(binding.id, seen).all()
      : await db.prepare("UPDATE external_items SET tombstoned_at = COALESCE(tombstoned_at, now()), review_status = 'pending', updated_at = now() WHERE binding_id = ? AND tombstoned_at IS NULL RETURNING id").bind(binding.id).all();
    tombstoned = result.results.length;
  }
  return { changed, tombstoned };
}

async function tombstoneExternalItem(db: PgD1, bindingId: string, externalId: string) {
  await db.prepare("UPDATE external_items SET tombstoned_at = COALESCE(tombstoned_at, now()), review_status = 'pending', updated_at = now() WHERE binding_id = ? AND external_id = ?").bind(bindingId, externalId).run();
}

async function applyExternalRelations(db: PgD1, principal: Principal, binding: Row, importedRows: Row[]) {
  const result = await db.prepare(`SELECT e.external_id, e.parent_external_id, e.normalized_snapshot, l.work_item_id
    FROM external_items e JOIN work_item_external_links l ON l.external_item_id = e.id WHERE e.binding_id = ?`).bind(binding.id).all<Row>();
  const workByExternal = new Map(result.results.map((row) => [String(row.external_id), String(row.work_item_id)]));
  for (const row of importedRows) {
    const current = workByExternal.get(String(row.external_id));
    if (!current) continue;
    if (row.parent_external_id) {
      const parent = workByExternal.get(String(row.parent_external_id));
      if (parent && parent !== current) await safeAddRelation(db, principal, binding, current, parent, "relates_to", `Imported parent from ${providerLabel(String(binding.provider))}`);
    }
    const snapshot = parseJson<{ relations?: Array<{ externalId: string; type: string; label: string }> }>(row.normalized_snapshot, {});
    for (const relation of snapshot.relations ?? []) {
      const other = workByExternal.get(relation.externalId);
      if (!other || other === current) continue;
      if (relation.type === "blocks") await safeAddRelation(db, principal, binding, current, other, "blocks", relation.label);
      else if (relation.type === "blocked_by") await safeAddRelation(db, principal, binding, other, current, "blocks", relation.label);
      else await safeAddRelation(db, principal, binding, current, other, "relates_to", relation.label);
    }
  }
}

async function safeAddRelation(db: PgD1, principal: Principal, binding: Row, from: string, to: string, type: string, reason: string) {
  try {
    await executeCommand(db, principal, { action: "add_dependency", projectId: String(binding.project_id), fromWorkItemId: from, toWorkItemId: to, type, reason, idempotencyKey: `external-relation:${binding.id}:${from}:${to}:${type}` });
  } catch (error) {
    if (errorCode(error) !== "BLOCKING_CYCLE") throw error;
  }
}

function externalDescription(row: Row, binding: Row) {
  const lines = [String(row.description ?? "").trim(), "", `Imported from ${providerLabel(String(binding.provider))}: ${String(row.external_key ?? row.external_id)}`, `External status: ${String(row.external_status || "unknown")}`];
  if (row.assignee) lines.push(`External assignee: ${String(row.assignee)}`);
  if (row.due_at) lines.push(`External due date: ${String(row.due_at).slice(0, 10)}`);
  if (row.canonical_url) lines.push(`Source: ${String(row.canonical_url)}`);
  return lines.filter((line, index) => line || index === 1).join("\n").slice(0, 10_000);
}

function mapBinding(row: Row): IntegrationBindingSummary {
  return {
    id: String(row.id), projectId: String(row.project_id), connectionId: String(row.connection_id), provider: integrationProvider(String(row.provider)),
    externalAccountId: String(row.external_account_id), externalAccountName: String(row.external_account_name), externalProjectId: String(row.external_project_id),
    externalProjectKey: row.external_project_key ? String(row.external_project_key) : null, externalProjectName: String(row.external_project_name),
    filterQuery: String(row.filter_query ?? ""), status: String(row.status), lastSyncAt: row.last_sync_at ? String(row.last_sync_at) : null,
    lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null, lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    pendingCount: Number(row.pending_count ?? 0), importedCount: Number(row.imported_count ?? 0),
  };
}

function mapCandidate(row: Row): ExternalCandidate {
  return {
    id: String(row.id), bindingId: String(row.binding_id), provider: integrationProvider(String(row.provider)), externalId: String(row.external_id),
    externalKey: row.external_key ? String(row.external_key) : null, itemType: String(row.item_type), title: String(row.title), description: String(row.description),
    externalStatus: String(row.external_status), normalizedStatus: String(row.normalized_status), priority: String(row.priority), assignee: row.assignee ? String(row.assignee) : null,
    dueAt: row.due_at ? String(row.due_at) : null, parentExternalId: row.parent_external_id ? String(row.parent_external_id) : null,
    canonicalUrl: String(row.canonical_url), reviewStatus: String(row.review_status), workItemId: row.work_item_id ? String(row.work_item_id) : null,
    workItemKey: row.item_key ? String(row.item_key) : null, planningHints: planningHints(row),
  };
}

function planningHints(row: Row) {
  const hints: string[] = [];
  if (!String(row.description ?? "").trim()) hints.push("Description or acceptance criteria are missing");
  if (row.parent_external_id) hints.push("Part of an external parent/child hierarchy");
  const snapshot = parseJson<{ relations?: unknown[] }>(row.normalized_snapshot, {});
  if (snapshot.relations?.length) hints.push(`${snapshot.relations.length} external relationship${snapshot.relations.length === 1 ? "" : "s"} will be reconciled`);
  if (["done", "cancelled"].includes(String(row.normalized_status))) hints.push("Already resolved externally; import remains a proposal until reviewed");
  return hints;
}

function webhookDeliveryKey(provider: IntegrationProvider, payload: Row, payloadHash: string) {
  if (provider === "basecamp" && payload.id) return `basecamp:${payload.id}`;
  const issue = payload.issue && typeof payload.issue === "object" ? payload.issue as Row : {};
  return `jira:${String(payload.webhookEvent ?? "event")}:${String(issue.id ?? "unknown")}:${String(payload.timestamp ?? payloadHash)}`;
}

function providerLabel(provider: string) { return provider === "basecamp" ? "Basecamp" : "Jira"; }
function errorCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "INTEGRATION_FAILED"; }
async function markBindingError(db: PgD1, bindingId: string, code: string) {
  await db.prepare("UPDATE integration_bindings SET status = 'degraded', last_error_code = ?, last_error_at = now(), updated_at = now() WHERE id = ?").bind(code.slice(0, 120), bindingId).run();
}
