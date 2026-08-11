export const WORK_STATUSES = ["proposed", "planned", "ready", "in_progress", "blocked", "in_review", "done", "cancelled"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
/** Free-form MCP client or model-provider identifier supplied by the connecting client. */
export type Provider = string;

export type Project = {
  id: string;
  name: string;
  description: string;
  directory: string;
  gitRemote: string | null;
  defaultBranch: string;
  revision: number;
  status: string;
  updatedAt: string;
};

export type CodingSpace = {
  id: string;
  projectId: string;
  label: string;
  safePath: string;
  branch: string;
  kind: string;
  status: string;
  lastSeenAt: string;
};

export type Source = {
  id: string;
  projectId: string;
  codingSpaceId: string | null;
  provider: Provider;
  externalId: string;
  title: string;
  model: string | null;
  status: string;
  assurance: "enforced" | "observed" | "instructed" | "manual";
  currentTaskIds: string[];
  lastSeenAt: string;
};

export type WorkItem = {
  id: string;
  projectId: string;
  sequence: number;
  itemKey: string;
  parentId: string | null;
  type: string;
  title: string;
  description: string;
  status: WorkStatus;
  priority: "urgent" | "high" | "normal" | "low" | "none";
  assignee: string | null;
  sourceId: string | null;
  codingSpaceId: string | null;
  completionConfidence: string;
  verificationStatus: string;
  blockerReason: string | null;
  /** Count of unresolved hard-dependency prerequisites. Drives the derived board column: see lib/graph/column.ts. */
  blockingCount: number;
  unblockedAt: string | null;
  version: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkEvent = {
  id: string;
  projectId: string;
  projectRevision: number;
  workItemId: string | null;
  sourceId: string | null;
  interactionId: string | null;
  actorName: string;
  eventType: string;
  summary: string;
  fromStatus: WorkStatus | null;
  toStatus: WorkStatus | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type Notification = {
  id: string;
  projectId: string;
  workItemId: string | null;
  sourceId: string | null;
  interactionId: string | null;
  eventType: string;
  priority: string;
  title: string;
  body: string;
  deepLink: string;
  requiresAction: boolean;
  readAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

export type DashboardState = {
  viewer: { id: string; name: string; email: string };
  projects: Project[];
  codingSpaces: CodingSpace[];
  sources: Source[];
  workItems: WorkItem[];
  events: WorkEvent[];
  notifications: Notification[];
  dependencies: Array<{ id: string; fromWorkItemId: string; toWorkItemId: string; type: string; reason: string }>;
  evidence: Array<{ id: string; workItemId: string; type: string; label: string; uri: string | null; result: string | null; createdAt: string }>;
  /** Restatements from other proposals that were matched into a work item instead of creating a duplicate. */
  aliases: Array<{ id: string; workItemId: string; title: string; description: string; sourceId: string | null; matchMethod: string; matchReason: string; createdAt: string }>;
  serverTime: string;
};

export type Command =
  | { action: "create_project"; name: string; directory?: string; description?: string; idempotencyKey: string }
  | { action: "create_item"; projectId: string; title: string; description?: string; status?: WorkStatus; priority?: WorkItem["priority"]; sourceId?: string; contentFingerprint?: string; idempotencyKey: string }
  | { action: "update_item"; projectId: string; itemId: string; expectedVersion: number; title?: string; description?: string; priority?: WorkItem["priority"]; assignee?: string | null; idempotencyKey: string }
  | { action: "transition_item"; projectId: string; itemId: string; expectedVersion: number; status: WorkStatus; reason?: string; sourceId?: string; idempotencyKey: string }
  | { action: "add_note"; projectId: string; itemId: string; summary: string; sourceId?: string; idempotencyKey: string }
  | { action: "add_evidence"; projectId: string; itemId: string; type: string; label: string; uri?: string; result?: string; sourceId?: string; idempotencyKey: string }
  | { action: "add_dependency"; projectId: string; fromWorkItemId: string; toWorkItemId: string; type?: string; reason?: string; idempotencyKey: string }
  | { action: "split_alias"; projectId: string; aliasId: string; idempotencyKey: string }
  | { action: "mark_notification"; notificationId: string; read?: boolean; resolved?: boolean; idempotencyKey: string };
