/**
 * Row → domain mapping, shared by every reader.
 *
 * These lived in lib/store.ts, which is also the only writer. Moving them here is what
 * lets lib/read/project-view.ts return real domain types without importing the write
 * path, and it keeps one definition of "what a work item row means" rather than two that
 * can drift — the mistake `PLANNING_INTELLIGENCE_ROADMAP.md` F14 records for the matcher.
 */
import type { Maturity, Notification, Project, ProjectMember, Resolution, Source, WorkEvent, WorkItem, WorkStatus } from "@/lib/contracts";
import { normalizeSourcePresence } from "@/lib/presence";

export type Row = Record<string, unknown>;

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function text(row: Row, key: string) { return String(row[key] ?? ""); }
export function nullable(row: Row, key: string) { return row[key] == null ? null : String(row[key]); }
export function number(row: Row, key: string) { return Number(row[key] ?? 0); }

export type ProjectSettings = { gateProposals?: boolean };

export function mapProject(row: Row): Project {
  const settings = parseJson<ProjectSettings>(text(row, "settings"), {});
  const integrationProviders = Array.isArray(row.integration_providers) ? row.integration_providers.map(String) : parseJson<string[]>(text(row, "integration_providers"), []);
  return { id: text(row, "id"), name: text(row, "name"), description: text(row, "description"), directory: text(row, "directory"), gitRemote: nullable(row, "git_remote"), defaultBranch: text(row, "default_branch"), revision: number(row, "revision"), status: text(row, "status"), updatedAt: text(row, "updated_at"), gateProposals: settings.gateProposals === true, integrationProviders };
}

export function mapSource(row: Row, now = Date.now()): Source {
  const lastSeenAt = text(row, "last_seen_at");
  const status = normalizeSourcePresence(text(row, "status"), lastSeenAt, now);
  const currentTaskIds = status === "ended" || status === "removed" ? [] : parseJson<string[]>(text(row, "current_task_ids"), []);
  return { id: text(row, "id"), projectId: text(row, "project_id"), codingSpaceId: nullable(row, "coding_space_id"), provider: text(row, "provider") as Source["provider"], externalId: text(row, "external_id"), title: text(row, "title"), model: nullable(row, "model"), status, assurance: text(row, "assurance") as Source["assurance"], currentTaskIds, lastSeenAt, agentAccountId: nullable(row, "agent_account_id"), agentAccountLabel: nullable(row, "agent_account_label"), credentialId: nullable(row, "credential_id"), accessBlocked: Boolean(row.access_blocked) };
}

export function mapItem(row: Row): WorkItem {
  const memberIds = Array.isArray(row.assignee_member_ids) ? row.assignee_member_ids.map(String) : parseJson<string[]>(text(row, "assignee_member_ids"), []);
  return { id: text(row, "id"), projectId: text(row, "project_id"), sequence: number(row, "sequence"), itemKey: text(row, "item_key"), type: text(row, "type"), title: text(row, "title"), description: text(row, "description"), status: text(row, "status") as WorkStatus, maturity: (nullable(row, "maturity") ?? "accepted") as Maturity, resolution: nullable(row, "resolution") as Resolution | null, resolutionReason: nullable(row, "resolution_reason"), deferredUntil: nullable(row, "deferred_until"), priority: text(row, "priority") as WorkItem["priority"], assignee: nullable(row, "assignee"), assigneeMemberIds: memberIds, sourceId: nullable(row, "source_id"), codingSpaceId: nullable(row, "coding_space_id"), completionConfidence: text(row, "completion_confidence"), verificationStatus: text(row, "verification_status"), blockerReason: nullable(row, "blocker_reason"), statusProvenance: nullable(row, "status_provenance"), blockingCount: number(row, "blocking_count"), unblockedAt: nullable(row, "unblocked_at"), version: number(row, "version"), startedAt: nullable(row, "started_at"), completedAt: nullable(row, "completed_at"), createdAt: text(row, "created_at"), updatedAt: text(row, "updated_at") };
}

export function mapProjectMember(row: Row): ProjectMember {
  return { id: text(row, "id"), projectId: text(row, "project_id"), provider: text(row, "provider") as ProjectMember["provider"], externalId: nullable(row, "external_id"), name: text(row, "name"), email: nullable(row, "email"), avatarUrl: nullable(row, "avatar_url"), title: nullable(row, "title"), active: Boolean(row.active) };
}

export function mapEvent(row: Row): WorkEvent {
  return { id: text(row, "id"), projectId: text(row, "project_id"), projectRevision: number(row, "project_revision"), workItemId: nullable(row, "work_item_id"), sourceId: nullable(row, "source_id"), interactionId: nullable(row, "interaction_id"), actorName: text(row, "actor_name"), eventType: text(row, "event_type"), summary: text(row, "summary"), fromStatus: nullable(row, "from_status") as WorkStatus | null, toStatus: nullable(row, "to_status") as WorkStatus | null, metadata: parseJson(text(row, "metadata"), {}), provenance: nullable(row, "provenance"), reason: nullable(row, "reason"), createdAt: text(row, "created_at") };
}

export function mapNotification(row: Row): Notification {
  return { id: text(row, "id"), projectId: text(row, "project_id"), workItemId: nullable(row, "work_item_id"), sourceId: nullable(row, "source_id"), interactionId: nullable(row, "interaction_id"), eventType: text(row, "event_type"), priority: text(row, "priority"), title: text(row, "title"), body: text(row, "body"), deepLink: text(row, "deep_link"), requiresAction: Boolean(row.requires_action), readAt: nullable(row, "read_at"), resolvedAt: nullable(row, "resolved_at"), createdAt: text(row, "created_at") };
}

export function mapAlias(row: Row) {
  return { id: text(row, "id"), workItemId: text(row, "work_item_id"), title: text(row, "title"), description: text(row, "description"), sourceId: nullable(row, "source_id"), matchMethod: text(row, "match_method"), matchReason: text(row, "match_reason"), createdAt: text(row, "created_at") };
}

export function mapDependency(row: Row) {
  return { id: text(row, "id"), fromWorkItemId: text(row, "from_work_item_id"), toWorkItemId: text(row, "to_work_item_id"), type: text(row, "type"), reason: text(row, "reason") };
}

export function mapEvidence(row: Row) {
  return { id: text(row, "id"), workItemId: text(row, "work_item_id"), sourceId: nullable(row, "source_id"), type: text(row, "type"), label: text(row, "label"), uri: nullable(row, "uri"), result: nullable(row, "result"), createdAt: text(row, "created_at") };
}

/** A live work_claims lease (F1) — what "who holds what, and for how long" (M14) reads
 * from, deliberately distinct from work_items.source_id: a lease says who is holding an
 * item *right now*, a source_id says who originally proposed it. The two can name
 * different agents once work changes hands. */
export function mapClaim(row: Row) {
  return { id: text(row, "id"), workItemId: text(row, "work_item_id"), sourceId: text(row, "source_id"), mode: text(row, "mode"), leaseExpiresAt: text(row, "lease_expires_at"), heartbeatAt: text(row, "heartbeat_at") };
}
