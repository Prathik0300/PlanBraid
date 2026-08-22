export const INTEGRATION_PROVIDERS = ["basecamp", "jira", "slack"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** External work systems are ingestion-only. Planbraid may read their projects/items
 * and register provider webhooks, but it never publishes task, comment, or status
 * mutations back to them and never deletes provider data or configuration. Disconnects
 * are local-only. Canonical work is changed only inside Planbraid. */
export const IMPORT_ONLY_PROVIDERS = ["basecamp", "jira"] as const;
export type ImportOnlyProvider = (typeof IMPORT_ONLY_PROVIDERS)[number];

/** Providers that publish Planbraid updates outward, as opposed to importing external
 * work (basecamp, jira). Kept as its own list rather than a field on IntegrationProvider
 * because the two families use entirely different binding shapes - see
 * integration_channel_bindings vs integration_bindings in db/setup.ts. */
export const PUBLICATION_PROVIDERS = ["slack"] as const;
export type PublicationProvider = (typeof PUBLICATION_PROVIDERS)[number];

export type ExternalResource = {
  id: string;
  name: string;
  url: string;
  scopes?: string[];
};

export type ExternalProject = {
  id: string;
  key: string | null;
  name: string;
  description: string;
  url: string;
  accountId: string;
  accountName: string;
  baseUrl: string;
  metadata?: Record<string, unknown>;
};

export type ExternalRelation = {
  externalId: string;
  type: "blocks" | "blocked_by" | "relates_to";
  label: string;
};

export type ExternalMember = {
  externalId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  title: string | null;
  active: boolean;
  raw: Record<string, unknown>;
};

export type NormalizedExternalItem = {
  externalId: string;
  externalKey: string | null;
  itemType: string;
  title: string;
  description: string;
  externalStatus: string;
  normalizedStatus: "proposed" | "planned" | "in_progress" | "blocked" | "in_review" | "done" | "cancelled";
  priority: "urgent" | "high" | "normal" | "low" | "none";
  assignee: string | null;
  assignees: ExternalMember[];
  dueAt: string | null;
  parentExternalId: string | null;
  canonicalUrl: string;
  externalRevision: string | null;
  relations: ExternalRelation[];
  raw: Record<string, unknown>;
};

export type IntegrationConnectionSummary = {
  id: string;
  provider: IntegrationProvider;
  label: string;
  status: string;
  configured: boolean;
  scopes: string[];
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  /** Provider identity that doesn't fit the other fields - currently only Slack's
   * {teamId, teamName, botUserId}. Empty object for providers that don't set it. */
  metadata: Record<string, unknown>;
};

export type IntegrationBindingSummary = {
  id: string;
  projectId: string;
  connectionId: string;
  provider: IntegrationProvider;
  externalAccountId: string;
  externalAccountName: string;
  externalProjectId: string;
  externalProjectKey: string | null;
  externalProjectName: string;
  filterQuery: string;
  status: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  pendingCount: number;
  importedCount: number;
};

export type ExternalCandidate = {
  id: string;
  bindingId: string;
  provider: IntegrationProvider;
  externalId: string;
  externalKey: string | null;
  itemType: string;
  title: string;
  description: string;
  externalStatus: string;
  normalizedStatus: string;
  priority: string;
  assignee: string | null;
  dueAt: string | null;
  parentExternalId: string | null;
  canonicalUrl: string;
  reviewStatus: string;
  workItemId: string | null;
  workItemKey: string | null;
  planningHints: string[];
};

export type ProviderRequest = typeof fetch;

export type ChannelBindingScope = "project" | "all_projects";

export type IntegrationChannelBindingSummary = {
  id: string;
  connectionId: string;
  provider: PublicationProvider;
  scopeType: ChannelBindingScope;
  projectId: string | null;
  projectName: string | null;
  channelId: string;
  channelName: string;
  excludedProjectIds: string[];
  eventTypes: string[];
  status: string;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  /** Another active binding already delivers to this same channel with an overlapping
   * scope - set at read time so the UI can warn without a second round trip. See
   * INTEGRATIONS_IMPLEMENTATION_PLAN.md §2.1: "Planbraid must detect overlapping scopes
   * and prevent duplicate notifications." Delivery itself is deduped independently
   * (publish.ts's matchingBindings prefers the more specific binding per channel), so
   * this flag is advisory, not the enforcement point. */
  overlapping: boolean;
};
