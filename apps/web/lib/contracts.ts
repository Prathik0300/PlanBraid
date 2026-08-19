export const WORK_STATUSES = ["proposed", "planned", "ready", "in_progress", "blocked", "in_review", "done", "cancelled"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/**
 * Planning maturity: whether this is work yet, or still something somebody said.
 *
 * Deliberately a second axis rather than five more statuses. `status` is a state machine
 * with a transition table, derived board columns and a resolved-set that three modules
 * read; maturity is a property of the item's standing, and the two vary independently —
 * a proposal can be blocked, an accepted task can be proposed again.
 *
 * `supported` is absent on purpose: independent corroboration is derived from aliases by
 * provider family, never stored, for the same reason the board column is derived.
 */
export const MATURITIES = ["idea", "proposal", "accepted", "committed"] as const;
export type Maturity = (typeof MATURITIES)[number];

/** Maturity at or below which an agent may write without a human's say-so. */
export const AGENT_WRITABLE_MATURITIES: readonly Maturity[] = ["idea", "proposal"];

/**
 * Why a terminal item ended the way it did. `unspecified` is a real value, not a gap:
 * "cancelled and nobody recorded why" is itself worth knowing, and inventing a reason
 * would be worse than admitting there isn't one.
 */
export const RESOLUTIONS = ["completed", "rejected", "deferred", "superseded", "duplicate", "abandoned", "obsolete", "unspecified"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** How a maturity promotion was authorized. An agent reporting that the user agreed is
 * weaker evidence than the user clicking accept, and the two must never be recorded
 * identically. */
export const AUTHORITIES = ["human_approved", "human_stated", "agent_proposed"] as const;
export type Authority = (typeof AUTHORITIES)[number];
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
  /** When true, work no human has accepted is kept out of the board's working columns and
   * listed in the Proposals queue instead. Off until a project turns it on. */
  gateProposals: boolean;
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
  /** Which of the owner's agent logins this session belongs to. Two CLI aliases for one
   * model share a provider but not an account, so this is what separates them. Null for
   * sessions registered before agent accounts existed. */
  agentAccountId: string | null;
  agentAccountLabel: string | null;
  /** The same id the Setup dialog's connection list shows and revokes (mcp_tokens.id or
   * the oauth token family id) — the real access-control boundary for set_project_access.
   * Null for sessions registered before this column existed; those can't be blocked until
   * they reconnect. */
  credentialId: string | null;
  /** Whether set_project_access has blocked credentialId from this project. Always false
   * when credentialId is null. */
  accessBlocked: boolean;
};

export type WorkItem = {
  id: string;
  projectId: string;
  sequence: number;
  itemKey: string;
  type: string;
  title: string;
  description: string;
  status: WorkStatus;
  /** Whether this is accepted work or still a proposal. See MATURITIES. */
  maturity: Maturity;
  /** Set only in a terminal status: why it ended this way. */
  resolution: Resolution | null;
  resolutionReason: string | null;
  /** "Not now, revisit on this date." Excluded from ready work until it passes. */
  deferredUntil: string | null;
  priority: "urgent" | "high" | "normal" | "low" | "none";
  assignee: string | null;
  sourceId: string | null;
  codingSpaceId: string | null;
  completionConfidence: string;
  verificationStatus: string;
  blockerReason: string | null;
  /** How the item's current status was learned. See lib/trust/provenance.ts. */
  statusProvenance: string | null;
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
  /** How this claim was learned, when the write path recorded it. */
  provenance: string | null;
  /** Structured "why", separate from `summary`'s prose. */
  reason: string | null;
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
  evidence: Array<{ id: string; workItemId: string; sourceId: string | null; type: string; label: string; uri: string | null; result: string | null; createdAt: string }>;
  /** Restatements from other proposals that were matched into a work item instead of creating a duplicate. */
  aliases: Array<{ id: string; workItemId: string; title: string; description: string; sourceId: string | null; matchMethod: string; matchReason: string; createdAt: string }>;
  /** Open "report everything you know" requests to a specific connected agent. See requestImport in lib/store.ts. */
  importRequests: Array<{ id: string; projectId: string; sourceId: string; createdAt: string }>;
  /** Live work_claims leases (F1) not yet expired — who holds what right now, and until
   * when. See lib/read/rows.ts's mapClaim for why this is kept distinct from source_id. */
  claims: Array<{ id: string; workItemId: string; sourceId: string; mode: string; leaseExpiresAt: string; heartbeatAt: string }>;
  serverTime: string;
};

export type Command =
  | { action: "create_project"; name: string; directory?: string; description?: string; gitRemote?: string; idempotencyKey: string }
  | { action: "update_project"; projectId: string; name?: string; description?: string; directory?: string; gitRemote?: string; gateProposals?: boolean; idempotencyKey: string }
  /** Soft-delete: sets status to 'archived' rather than removing rows. Every project-scoped
   * table (work_items, sources, decisions, evidence, ...) has no ON DELETE CASCADE, so a
   * hard delete would need to touch two dozen tables correctly or leave orphans; archiving
   * is what findMatchingProject and listProjects already treat as gone. */
  | { action: "delete_project"; projectId: string; idempotencyKey: string }
  /** Renames how a source displays for this project. Cosmetic only — see
   * set_project_access for the real per-project access boundary. */
  | { action: "update_source"; projectId: string; sourceId: string; title: string; idempotencyKey: string }
  /** Removes one session from the project's connected-agent surfaces without erasing
   * its historical provenance. A later explicit reconnect of the same session restores
   * it, while set_project_access remains the durable credential-level access control. */
  | { action: "remove_source"; projectId: string; sourceId: string; idempotencyKey: string }
  /** The real access boundary update_source can't provide: blocks (or unblocks) the
   * credential behind a source from this one project, enforced server-side on every MCP
   * call, and unaffected by that credential reconnecting under a new session or marker. */
  | { action: "set_project_access"; projectId: string; credentialId: string; blocked: boolean; idempotencyKey: string }
  | { action: "create_item"; projectId: string; title: string; description?: string; status?: WorkStatus; maturity?: Maturity; priority?: WorkItem["priority"]; sourceId?: string; contentFingerprint?: string; type?: string; idempotencyKey: string }
  | { action: "update_item"; projectId: string; itemId: string; expectedVersion: number; title?: string; description?: string; priority?: WorkItem["priority"]; assignee?: string | null; sourceId?: string; idempotencyKey: string }
  | { action: "transition_item"; projectId: string; itemId: string; expectedVersion: number; status: WorkStatus; reason?: string; resolution?: Resolution; resolutionReason?: string; deferredUntil?: string | null; sourceId?: string; idempotencyKey: string }
  /** Promote or demote planning maturity. `statedBy` names the person whose decision this
   * was, and is what lets an agent record an acceptance it witnessed without being able to
   * manufacture one. */
  | { action: "set_maturity"; projectId: string; itemIds: string[]; maturity: Maturity; statedBy?: string; reason?: string; sourceId?: string; idempotencyKey: string }
  | { action: "add_note"; projectId: string; itemId: string; summary: string; sourceId?: string; idempotencyKey: string }
  | { action: "add_evidence"; projectId: string; itemId: string; type: string; label: string; uri?: string; result?: string; sourceId?: string; idempotencyKey: string }
  | { action: "add_dependency"; projectId: string; fromWorkItemId: string; toWorkItemId: string; type?: string; reason?: string; sourceId?: string; idempotencyKey: string }
  | { action: "split_alias"; projectId: string; aliasId: string; idempotencyKey: string }
  | { action: "merge_items"; projectId: string; winnerItemId: string; loserItemId: string; reason?: string; sourceId?: string; idempotencyKey: string }
  | { action: "mark_notification"; notificationId: string; read?: boolean; resolved?: boolean; idempotencyKey: string };
