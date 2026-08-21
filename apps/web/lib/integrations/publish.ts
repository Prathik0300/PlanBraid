import type { PgD1, PgD1PreparedStatement } from "@/db/pg-d1";
import { domainError, integrationProvider, requireOwnedConnection, requireOwnedProject } from "@/lib/integrations/core";
import { ProviderHttpError } from "@/lib/integrations/http";
import { listSlackChannels, postSlackMessage, type SlackBlock } from "@/lib/integrations/slack";
import type { ChannelBindingScope, IntegrationChannelBindingSummary, ProviderRequest, PublicationProvider } from "@/lib/integrations/types";
import { integrationId, parseJson, sha256 } from "@/lib/integrations/utils";
import { organizationFor, type Principal } from "@/lib/store";

type Row = Record<string, unknown>;

/**
 * The publication side of the shared integration foundation (db/setup.ts's
 * integration_connections + integration_outbox), parallel to service.ts's import side
 * (integration_bindings + external_items). Publication bindings live in their own table,
 * integration_channel_bindings, because the concepts genuinely differ: an import binding
 * names one external project for one Planbraid project, while a channel binding can
 * blanket every current-and-future project, carries its own per-event toggles, and is
 * driven by domain events inside Planbraid rather than a provider webhook.
 */

export const PUBLICATION_EVENT_TYPES = ["work_item.blocked", "work_item.completion_verified", "work_item.completion_reported", "work_item.downstream_unblocked"] as const;
export type PublicationEventType = (typeof PUBLICATION_EVENT_TYPES)[number];
const DEFAULT_EVENT_TYPES: PublicationEventType[] = ["work_item.blocked", "work_item.completion_verified", "work_item.downstream_unblocked"];

const EVENT_LABEL: Record<PublicationEventType, string> = {
  "work_item.blocked": "New blockers",
  "work_item.completion_verified": "Work completed",
  "work_item.completion_reported": "Work submitted for review",
  "work_item.downstream_unblocked": "Ready work",
};

export function publicationEventLabel(eventType: string) {
  return EVENT_LABEL[eventType as PublicationEventType] ?? eventType;
}

export async function providerChannels(db: PgD1, principal: Principal, provider: PublicationProvider, connectionId: string, fetcher: ProviderRequest = fetch) {
  await requireOwnedConnection(db, principal, connectionId, provider);
  return listSlackChannels(db, connectionId, fetcher);
}

export async function listChannelBindings(db: PgD1, principal: Principal, projectId: string): Promise<IntegrationChannelBindingSummary[]> {
  const organizationId = await organizationFor(db, principal);
  await requireOwnedProject(db, organizationId, projectId);
  // A project's own bindings plus every all-projects binding that has not excluded it -
  // both are "what publishes for this project" from the settings dialog's point of view.
  const result = await db.prepare(`SELECT b.*, p.name AS project_name FROM integration_channel_bindings b LEFT JOIN projects p ON p.id = b.project_id
    WHERE b.organization_id = ? AND b.status <> 'disconnected'
      AND ((b.scope_type = 'project' AND b.project_id = ?) OR (b.scope_type = 'all_projects' AND NOT (b.excluded_project_ids::jsonb @> ?::jsonb)))
    ORDER BY b.created_at`).bind(organizationId, projectId, JSON.stringify([projectId])).all<Row>();
  const overlap = await overlappingChannelIds(db, organizationId, result.results);
  return result.results.map((row) => mapBinding(row, overlap));
}

export async function listAllChannelBindings(db: PgD1, principal: Principal): Promise<IntegrationChannelBindingSummary[]> {
  const organizationId = await organizationFor(db, principal);
  const result = await db.prepare("SELECT b.*, p.name AS project_name FROM integration_channel_bindings b LEFT JOIN projects p ON p.id = b.project_id WHERE b.organization_id = ? AND b.status <> 'disconnected' ORDER BY b.created_at")
    .bind(organizationId).all<Row>();
  const overlap = await overlappingChannelIds(db, organizationId, result.results);
  return result.results.map((row) => mapBinding(row, overlap));
}

function overlappingChannelIds(db: PgD1, organizationId: string, rows: Row[]) {
  const counts = new Map<string, number>();
  for (const row of rows) { const key = `${row.connection_id}:${row.external_channel_id}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
  return db.prepare("SELECT connection_id, external_channel_id, COUNT(*) AS n FROM integration_channel_bindings WHERE organization_id = ? AND status <> 'disconnected' GROUP BY connection_id, external_channel_id HAVING COUNT(*) > 1")
    .bind(organizationId).all<{ connection_id: string; external_channel_id: string }>()
    .then((result) => new Set(result.results.map((entry) => `${entry.connection_id}:${entry.external_channel_id}`)));
}

export async function createChannelBinding(db: PgD1, principal: Principal, input: {
  provider: PublicationProvider; connectionId: string; scopeType: ChannelBindingScope; projectId: string | null;
  channelId: string; channelName: string; eventTypes?: string[]; confirmedAllProjects?: boolean;
}) {
  const { organizationId } = await requireOwnedConnection(db, principal, input.connectionId, input.provider);
  if (input.scopeType === "project") {
    if (!input.projectId) throw domainError("VALIDATION_FAILED", "projectId is required for a single-project binding", 422);
    await requireOwnedProject(db, organizationId, input.projectId);
  } else if (!input.confirmedAllProjects) {
    // §4.5: "Enabling this scope requires a prominent confirmation that future projects
    // will automatically publish to the channel." Enforced server-side, not only in the
    // dialog copy, since this is the one binding shape that silently grows its own scope.
    throw domainError("ALL_PROJECTS_CONFIRMATION_REQUIRED", "Confirm that future projects will automatically publish to this channel", 422);
  }
  const eventTypes = (input.eventTypes ?? []).filter((entry): entry is PublicationEventType => (PUBLICATION_EVENT_TYPES as readonly string[]).includes(entry));
  const bindingId = integrationId("icb");
  await db.prepare("INSERT INTO integration_channel_bindings (id, organization_id, connection_id, provider, scope_type, project_id, external_channel_id, external_channel_name, event_types) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(bindingId, organizationId, input.connectionId, input.provider, input.scopeType, input.scopeType === "project" ? input.projectId : null, input.channelId, input.channelName.slice(0, 200), JSON.stringify(eventTypes.length ? eventTypes : DEFAULT_EVENT_TYPES)).run();
  return { bindingId };
}

export async function updateChannelBinding(db: PgD1, principal: Principal, bindingId: string, input: { eventTypes?: string[]; excludedProjectIds?: string[] }) {
  const binding = await ownedChannelBinding(db, principal, bindingId);
  const eventTypes = input.eventTypes ? input.eventTypes.filter((entry): entry is PublicationEventType => (PUBLICATION_EVENT_TYPES as readonly string[]).includes(entry)) : null;
  await db.prepare("UPDATE integration_channel_bindings SET event_types = COALESCE(?, event_types), excluded_project_ids = COALESCE(?, excluded_project_ids), updated_at = now() WHERE id = ?")
    .bind(eventTypes ? JSON.stringify(eventTypes) : null, input.excludedProjectIds ? JSON.stringify(input.excludedProjectIds.slice(0, 500)) : null, binding.id).run();
}

/** Returns the channel id Slack itself confirms it posted to (chat.postMessage echoes
 * this back), not just the id we intended - the caller can compare the two directly
 * instead of trusting our own binding row was the one that actually got hit. */
export async function sendTestMessage(db: PgD1, principal: Principal, bindingId: string, fetcher: ProviderRequest = fetch) {
  const binding = await ownedChannelBinding(db, principal, bindingId);
  const result = await postSlackMessage(db, String(binding.connection_id), String(binding.external_channel_id), [
    { type: "section", text: { type: "mrkdwn", text: ":white_check_mark: *This channel is connected to Planbraid.*" } },
    { type: "context", elements: [{ type: "mrkdwn", text: String(binding.scope_type) === "all_projects" ? "Updates from every current and future eligible project will post here." : "Updates from one Planbraid project will post here." }] },
  ], "Planbraid test message", fetcher);
  return { intendedChannelId: String(binding.external_channel_id), confirmedChannelId: result.channel };
}

export async function disconnectChannelBinding(db: PgD1, principal: Principal, bindingId: string) {
  const binding = await ownedChannelBinding(db, principal, bindingId);
  await db.prepare("UPDATE integration_channel_bindings SET status = 'disconnected', updated_at = now() WHERE id = ?").bind(binding.id).run();
}

/**
 * Slack's app_uninstalled/tokens_revoked events name a team, not a Planbraid connection
 * id - there is no signed-in principal for a webhook, so this bypasses the normal owned-
 * connection checks and disconnects directly by workspace identity. Delivery order
 * between the two event types is not guaranteed (Slack's own docs say so explicitly),
 * so both call this and it is idempotent either way.
 */
export async function revokeSlackConnectionsByTeam(db: PgD1, teamId: string) {
  const rows = await db.prepare("SELECT id FROM integration_connections WHERE provider = 'slack' AND status <> 'disconnected' AND metadata::jsonb->>'teamId' = ?").bind(teamId).all<{ id: string }>();
  for (const row of rows.results) {
    await db.batch([
      db.prepare("UPDATE integration_connections SET status = 'disconnected', access_token = '', refresh_token = NULL, updated_at = now() WHERE id = ?").bind(row.id),
      db.prepare("UPDATE integration_channel_bindings SET status = 'disconnected', updated_at = now() WHERE connection_id = ?").bind(row.id),
    ]);
  }
  return rows.results.length;
}

async function ownedChannelBinding(db: PgD1, principal: Principal, bindingId: string) {
  const organizationId = await organizationFor(db, principal);
  const row = await db.prepare("SELECT b.* FROM integration_channel_bindings b JOIN integration_connections c ON c.id = b.connection_id WHERE b.id = ? AND b.organization_id = ? AND c.owner_user_id = ? AND b.status <> 'disconnected'")
    .bind(bindingId, organizationId, principal.userId).first<Row>();
  if (!row) throw domainError("CHANNEL_BINDING_NOT_FOUND", "Integration channel binding not found", 404);
  return row;
}

function mapBinding(row: Row, overlap: Set<string>): IntegrationChannelBindingSummary {
  return {
    id: String(row.id), connectionId: String(row.connection_id), provider: integrationProvider(String(row.provider)) as PublicationProvider,
    scopeType: String(row.scope_type) as ChannelBindingScope, projectId: row.project_id ? String(row.project_id) : null,
    projectName: row.project_name ? String(row.project_name) : null, channelId: String(row.external_channel_id), channelName: String(row.external_channel_name),
    excludedProjectIds: parseJson<string[]>(row.excluded_project_ids, []), eventTypes: parseJson<string[]>(row.event_types, []),
    status: String(row.status), lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null, lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    overlapping: overlap.has(`${row.connection_id}:${row.external_channel_id}`),
  };
}

// --- domain-event -> outbox -----------------------------------------------------------

export type PublicationEvent = {
  organizationId: string; projectId: string; projectName: string; eventType: PublicationEventType;
  workItemId: string | null; itemKey: string | null; title: string; summary: string;
};

/**
 * Builds the integration_outbox INSERT statements for one domain event, to be spliced
 * into the *same* commitMutation statement array as the work_events/notifications rows
 * that already exist at each call site - so a publication is durably queued in the exact
 * commit that made it true, never as a separate at-most-once side effect. Never touches
 * the network: that is entirely the drain worker's job, run outside any transaction.
 */
export async function buildPublicationStatements(db: PgD1, event: PublicationEvent): Promise<PgD1PreparedStatement[]> {
  const bindings = await matchingBindings(db, event.organizationId, event.projectId, event.eventType);
  const statements: PgD1PreparedStatement[] = [];
  for (const binding of bindings) {
    const effectKey = await sha256(`${binding.id}:${event.eventType}:${event.workItemId ?? "none"}:${event.summary}`);
    const payload = {
      channelId: String(binding.external_channel_id), connectionId: String(binding.connection_id),
      eventType: event.eventType, projectId: event.projectId, projectName: event.projectName,
      workItemId: event.workItemId, itemKey: event.itemKey, title: event.title, summary: event.summary,
    };
    // The debounce window: rows land `pending` but not due for 20s, so a burst of events
    // for the same channel (a batch accept, a chain of transitions) accumulates before the
    // drain ever looks at them, and one drain pass sends one consolidated message instead
    // of one per event. UNIQUE(provider, effect_key) makes a replayed command idempotent.
    statements.push(db.prepare("INSERT INTO integration_outbox (id, organization_id, binding_id, provider, effect_key, operation, payload, next_attempt_at) VALUES (?, ?, ?, 'slack', ?, 'chat.postMessage', ?, now() + interval '20 seconds') ON CONFLICT (provider, effect_key) DO NOTHING")
      .bind(integrationId("iob"), event.organizationId, binding.id, effectKey, JSON.stringify(payload)));
  }
  return statements;
}

async function matchingBindings(db: PgD1, organizationId: string, projectId: string, eventType: PublicationEventType) {
  const result = await db.prepare(`SELECT * FROM integration_channel_bindings
    WHERE organization_id = ? AND provider = 'slack' AND status = 'active'
      AND event_types::jsonb @> ?::jsonb
      AND ((scope_type = 'project' AND project_id = ?) OR (scope_type = 'all_projects' AND NOT (excluded_project_ids::jsonb @> ?::jsonb)))`)
    .bind(organizationId, JSON.stringify([eventType]), projectId, JSON.stringify([projectId])).all<Row>();
  // A channel bound both directly and via an all-projects feed must still receive exactly
  // one message (§4.5's overlap guarantee): keep the more specific, project-scoped
  // binding and drop the portfolio one for this send.
  const byChannel = new Map<string, Row>();
  for (const row of result.results) {
    const key = `${row.connection_id}:${row.external_channel_id}`;
    const existing = byChannel.get(key);
    if (!existing || (existing.scope_type === "all_projects" && row.scope_type === "project")) byChannel.set(key, row);
  }
  return [...byChannel.values()];
}

// --- worker drain ------------------------------------------------------------------

const MAX_ATTEMPTS = 8;

export async function drainSlackOutbox(db: PgD1, fetcher: ProviderRequest = fetch, limit = 100) {
  const due = await db.prepare("SELECT * FROM integration_outbox WHERE provider = 'slack' AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY created_at LIMIT ?").bind(limit).all<Row>();
  const byBinding = new Map<string, Row[]>();
  for (const row of due.results) {
    const key = String(row.binding_id);
    const list = byBinding.get(key) ?? [];
    list.push(row);
    byBinding.set(key, list);
  }
  let sent = 0;
  let deferred = 0;
  let deadLettered = 0;
  for (const [bindingId, rows] of byBinding) {
    const payloads = rows.map((row) => parseJson<Record<string, unknown>>(row.payload, {}));
    const connectionId = String(payloads[0]?.connectionId ?? "");
    const channelId = String(payloads[0]?.channelId ?? "");
    if (!connectionId || !channelId) { await markRows(db, rows, "completed", { lastError: "MISSING_DESTINATION" }); continue; }
    try {
      const result = await postSlackMessage(db, connectionId, channelId, renderConsolidatedBlocks(payloads), fallbackText(payloads), fetcher);
      await markRows(db, rows, "completed", { providerResponseId: result.ts });
      await db.prepare("UPDATE integration_channel_bindings SET status = 'active', last_success_at = now(), last_error_code = NULL, last_error_at = NULL, updated_at = now() WHERE id = ?").bind(bindingId).run();
      sent += 1;
    } catch (error) {
      // A rate limit is Slack asking to wait, not a failed send: it does not count
      // against the dead-letter cap, and the outbox honors Retry-After exactly.
      const rateLimited = error instanceof ProviderHttpError && error.retryAfterSeconds !== null;
      const attempts = Math.max(...rows.map((row) => Number(row.attempts ?? 0))) + (rateLimited ? 0 : 1);
      if (!rateLimited && attempts >= MAX_ATTEMPTS) {
        await markRows(db, rows, "dead_letter", { lastError: errorCode(error), attempts });
        await db.prepare("UPDATE integration_channel_bindings SET status = 'degraded', last_error_code = ?, last_error_at = now(), updated_at = now() WHERE id = ?").bind(errorCode(error), bindingId).run();
        deadLettered += 1;
        continue;
      }
      const delaySeconds = rateLimited ? (error as ProviderHttpError).retryAfterSeconds! : Math.min(3600, 30 * 2 ** attempts);
      await db.batch(rows.map((row) => db.prepare("UPDATE integration_outbox SET attempts = ?, next_attempt_at = now() + (? || ' seconds')::interval, last_error = ? WHERE id = ?").bind(attempts, String(delaySeconds), errorCode(error), row.id)));
      if (error instanceof ProviderHttpError && error.status === 401) await db.prepare("UPDATE integration_channel_bindings SET status = 'reauthorization_required', last_error_code = ?, last_error_at = now(), updated_at = now() WHERE id = ?").bind(errorCode(error), bindingId).run();
      deferred += 1;
    }
  }
  return { channelsSent: sent, channelsDeferred: deferred, channelsDeadLettered: deadLettered, eventsProcessed: due.results.length };
}

async function markRows(db: PgD1, rows: Row[], status: "completed" | "dead_letter", extra: { providerResponseId?: string; lastError?: string; attempts?: number }) {
  await db.batch(rows.map((row) => db.prepare("UPDATE integration_outbox SET status = ?, provider_response_id = COALESCE(?, provider_response_id), last_error = COALESCE(?, last_error), attempts = COALESCE(?, attempts), completed_at = now() WHERE id = ?")
    .bind(status, extra.providerResponseId ?? null, extra.lastError ?? null, extra.attempts ?? null, row.id)));
}

function errorCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "SLACK_PUBLISH_FAILED"; }

// --- Block Kit rendering ------------------------------------------------------------

const EVENT_EMOJI: Record<PublicationEventType, string> = {
  "work_item.blocked": ":red_circle:",
  "work_item.completion_verified": ":white_check_mark:",
  "work_item.completion_reported": ":mag:",
  "work_item.downstream_unblocked": ":unlock:",
};

function planbraidOrigin() {
  return (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");
}

function itemUrl(projectId: string, workItemId: string | null) {
  const origin = planbraidOrigin();
  const path = `/?project=${encodeURIComponent(projectId)}${workItemId ? `&item=${encodeURIComponent(workItemId)}` : ""}`;
  return origin ? `${origin}${path}` : path;
}

/** One event per line, grouped under a single project-labeled header - §4.2's "compact
 * projection" for a single-project channel, and §4.2's "label every entry with project
 * name" for a portfolio one. A consolidated send groups several events for the same
 * channel that landed inside one debounce window; each keeps its own line and link. */
export function renderConsolidatedBlocks(payloads: Array<Record<string, unknown>>): SlackBlock[] {
  const projectNames = new Set(payloads.map((entry) => String(entry.projectName ?? "")));
  const portfolio = projectNames.size > 1;
  const blocks: SlackBlock[] = [{
    type: "section",
    text: { type: "mrkdwn", text: portfolio ? "*Planbraid updates*" : `*${escapeMrkdwn(String(payloads[0]?.projectName ?? "Planbraid"))}*` },
  }];
  for (const entry of payloads.slice(0, 20)) {
    const eventType = String(entry.eventType) as PublicationEventType;
    const emoji = EVENT_EMOJI[eventType] ?? ":speech_balloon:";
    const key = entry.itemKey ? `${entry.itemKey} · ` : "";
    const title = escapeMrkdwn(String(entry.title ?? entry.summary ?? "Update"));
    const link = itemUrl(String(entry.projectId), entry.workItemId ? String(entry.workItemId) : null);
    const project = portfolio ? ` _(${escapeMrkdwn(String(entry.projectName ?? ""))})_ ` : " ";
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${emoji} ${key}<${link}|${title}>${project}` } });
  }
  if (payloads.length > 20) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `+ ${payloads.length - 20} more update${payloads.length - 20 === 1 ? "" : "s"}` }] });
  const projectLink = payloads[0]?.projectId ? itemUrl(String(payloads[0].projectId), null) : planbraidOrigin() || "/";
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${projectLink}|Open in Planbraid>` }] });
  return blocks;
}

function fallbackText(payloads: Array<Record<string, unknown>>) {
  return payloads.map((entry) => `${entry.itemKey ? `${entry.itemKey}: ` : ""}${String(entry.title ?? entry.summary ?? "Update")}`).join(" · ").slice(0, 3900);
}

function escapeMrkdwn(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
