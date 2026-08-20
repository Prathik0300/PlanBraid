# Planbraid Collaboration and Work-System Integrations

Status: Basecamp and Jira read-only integration implemented and repository-verified; live OAuth smoke testing awaits deployment credentials  
Last updated: 2026-08-20  
Planbraid work: #86, #87, #88

## 1. Purpose

This document is the shared implementation handoff for adding two integration families to Planbraid:

1. Publish Planbraid planning updates into Slack and Microsoft Teams channels.
2. Import work from Basecamp, Jira, and Azure DevOps, then use Planbraid to reconcile, improve, and optimize that work for implementation.

The implementation must preserve these product boundaries:

- Planbraid is the authoritative planning and decision system.
- Slack and Microsoft Teams are communication surfaces, not alternate plan databases.
- Basecamp, Jira, and Azure DevOps are external work sources.
- Imported items and AI-generated improvements remain proposals until a person accepts them.
- Provider failures must never make a core Planbraid transaction fail.
- No provider credential or company data may enter repository files, fixtures, logs, evidence text, or command-line arguments.

### Implemented snapshot (2026-08-20)

The Basecamp/Jira portion now ships in `apps/web`:

- provider-neutral encrypted OAuth connections, project bindings, external snapshots,
  Planbraid links, webhook inbox, outbox schema, and sync-run history;
- Basecamp OAuth refresh, account/project discovery, to-do set/list/to-do import,
  project webhooks, pagination, rate-limit handling, and periodic reconciliation;
- Jira Cloud 3LO with rotating refresh tokens, site/project discovery, enhanced JQL
  pagination, ADF normalization, hierarchy and issue-link import, signed dynamic
  webhooks, renewal, scoped custom filters, and periodic reconciliation;
- a project-level UI for connecting accounts, selecting external projects, syncing,
  reviewing candidates, selectively applying or ignoring them, and disconnecting;
- human-review boundaries: external changes reopen review and never silently overwrite
  Planbraid fields; imported work uses the existing deduplication/matching pipeline;
- focused adapter/security/retry tests plus the complete repository verification suite.

Deployment and provider-live verification still require real OAuth applications and a
public HTTPS deployment. No credentials are stored in this repository. Slack, Teams,
Azure DevOps, and all write-back phases remain planned rather than implemented.

## 2. Confirmed product decisions

### 2.1 Channel binding scopes

Every Slack or Microsoft Teams channel binding must use one explicit scope.

#### Single-project scope

The selected channel acts as the dedicated conversation for one Planbraid project.

- Only that project's updates are delivered.
- Each message links back to the authoritative Planbraid project or work item.
- Updates may include blockers, decisions, ready work, progress, completion, and scheduled digests.
- Updates from another project must never appear in this channel through this binding.

#### All-current-and-future-projects scope

The selected channel acts as a portfolio feed.

- All currently eligible projects are included.
- Future eligible projects are enrolled automatically.
- Every notification is visibly labeled with its project.
- Portfolio updates are consolidated to control noise.
- Users can exclude individual projects.
- Restricted projects are excluded unless the installer is authorized and explicitly opts them in.
- Enabling this scope requires a prominent confirmation that future projects will automatically publish to the channel.

A channel may have multiple bindings, but Planbraid must detect overlapping scopes and prevent duplicate notifications.

### 2.2 External provider order

Provider delivery order is:

1. Basecamp
2. Jira Cloud
3. Azure DevOps Services

Basecamp ships first because the product owner uses it at their company and can test the integration against real workflows. Testing must use a non-production project or a company project explicitly approved for integration testing.

### 2.3 Read-only before write-back

The initial versions are deliberately read-only:

- Slack and Teams receive Planbraid updates but cannot mutate the plan.
- Basecamp, Jira, and Azure DevOps feed import candidates into Planbraid but Planbraid does not write changes back.

Chat-side approvals and bidirectional tracker synchronization are later phases. They require user identity linking, project RBAC, field ownership, optimistic concurrency, conflict resolution, replay protection, and complete audit history.

## 3. Shared integration foundation — Planbraid #86

Both feature families depend on one provider-neutral integration core.

### 3.1 Required domain records

Names may be adjusted to match repository conventions, but the model must cover these responsibilities.

#### `integration_connections`

Represents an installed provider account or workspace.

Suggested fields:

- `id`
- `owner_account_id` or future organization ID
- `provider`
- `external_tenant_id`
- `external_tenant_name`
- `status`: connected, degraded, reauthorization_required, disconnected
- `granted_scopes`
- `access_token_expires_at`
- `last_success_at`
- `last_error_code`
- `last_error_at`
- timestamps and optimistic version

#### `integration_secrets`

References reversibly encrypted OAuth material.

- Access and refresh tokens must use envelope encryption or a managed KMS-backed secret mechanism.
- Encryption keys must not be stored beside ciphertext.
- Tokens must never be returned to browser clients after the OAuth callback.
- The existing one-way hashing approach used for inbound Planbraid/MCP credentials is not suitable for outbound OAuth refresh tokens.

#### `project_integration_bindings`

Connects an external destination or source scope to Planbraid.

Suggested fields:

- `connection_id`
- `binding_kind`: publication or import
- `scope_type`: project or all_projects
- `project_id`, nullable only for all-project publication bindings
- external container identifiers
- `include_future_projects`
- exclusion policy
- privacy/redaction policy
- enabled event policy
- digest schedule and timezone
- status and optimistic version

#### `external_items`

Stores normalized provider objects and their external revisions.

- Provider and tenant identity
- External item ID and human-readable key
- External project/container ID
- Item type
- Canonical URL
- Normalized snapshot
- Provider revision, ETag, or content hash
- First-seen, last-seen, and tombstoned timestamps

#### `work_item_external_links`

Links external items to Planbraid work items while preserving provenance.

- Link type and reconciliation result
- Sync mode
- Future per-field ownership
- Last imported revision
- Last outbound effect identity

#### `webhook_inbox`

Durably records incoming webhook deliveries before processing.

- Provider delivery identity or deterministic payload identity
- Verified tenant/connection
- Payload or restricted payload reference
- Received and acknowledged times
- Processing status
- Attempts, retry time, and dead-letter details
- Unique deduplication constraint

#### `integration_outbox`

Durably records outbound provider effects.

- Idempotency/effect key
- Provider operation
- Destination binding
- Restricted payload
- Attempts and next retry
- Provider response identity
- Completed or dead-letter state

#### `sync_runs`

Tracks backfills and reconciliation jobs.

- Binding and provider
- Run type: initial, webhook, scheduled reconciliation, manual
- Cursor/checkpoint
- Counts: fetched, new, matched, uncertain, ignored, failed
- Started/completed state and failure summary

### 3.2 Provider adapter contract

Each adapter should implement only the capabilities it supports. A suggested boundary is:

```ts
interface IntegrationAdapter {
  authorize(...): Promise<AuthorizationResult>;
  refreshCredentials(...): Promise<CredentialResult>;
  revoke(...): Promise<void>;
  validateConnection(...): Promise<ConnectionHealth>;
  listContainers?(...): Promise<ExternalContainer[]>;
  fetchChanges?(...): Promise<ExternalPage>;
  fetchCanonicalItem?(...): Promise<ExternalItem>;
  registerWebhook?(...): Promise<WebhookRegistration>;
  refreshWebhook?(...): Promise<WebhookRegistration>;
  removeWebhook?(...): Promise<void>;
  verifyWebhook?(...): Promise<VerifiedWebhook>;
  publish?(...): Promise<PublicationResult>;
}
```

Domain logic must consume normalized results and must not branch throughout the application on provider-specific response shapes.

### 3.3 Reliable processing flow

```text
Planbraid transaction
    -> integration outbox record in the same commit
    -> durable worker
    -> provider adapter
    -> Slack or Microsoft Teams

Provider webhook
    -> authenticate and deduplicate
    -> acknowledge quickly
    -> webhook inbox
    -> fetch canonical provider object
    -> normalize and reconcile
    -> human import review
    -> accepted Planbraid domain transaction
```

Required reliability behavior:

- Exponential backoff with jitter
- Provider-aware rate limiting
- Honor `Retry-After`
- Idempotent processing of redelivered hooks and jobs
- Dead-letter state with an operator-visible retry action
- Periodic reconciliation even when webhooks appear healthy
- Disconnect and credential-revocation handling
- Health state visible in the project integration UI
- No external network call inside a database transaction

## 4. Slack and Microsoft Teams publishing — Planbraid #87

### 4.1 Connection user experience

Suggested setup flow:

1. Open **Project or Account Settings -> Integrations**.
2. Select Slack or Microsoft Teams.
3. Complete provider installation/OAuth.
4. Select the target workspace/team and channel.
5. Select **One project** or **All current and future projects**.
6. Configure exclusions when using the all-project scope.
7. Select events and delivery mode.
8. Preview the exact message and destination.
9. Send a test message.
10. Confirm the binding.

Suggested controls:

```text
Share updates from:

( ) One project
    [Select project]

( ) All current and future projects
    [Manage excluded projects]

Delivery:
[x] Important plan changes
[x] New blockers
[x] Decisions requiring input
[x] Work completed
[x] Daily digest
[ ] Every work-item change
```

### 4.2 Notification content

Messages should be compact projections rather than full plan copies.

Include as relevant:

- Project identity
- Objective or current milestone
- Status totals
- New or unresolved blockers
- Ready next actions
- Decisions needing input
- Material progress or completion
- Link to the authoritative Planbraid view

For a single-project channel:

- Maintain one project snapshot/root message when supported.
- Add material changes as thread replies or consolidated updates.

For an all-project channel:

- Label every entry with project name.
- Prefer daily/weekly portfolio digests.
- Group changes by project.
- Avoid emitting one message for every work-item mutation.

### 4.3 Slack adapter

Use:

- Slack OAuth v2 workspace installation
- Bot token and least-privilege bot scopes
- Block Kit
- `chat.postMessage` and message updates where appropriate
- Slack signing-secret verification for incoming events and interactions
- Workspace/channel identifiers rather than mutable names
- Uninstall and token-revocation handling

Slack generally permits roughly one posted message per second per channel and returns `Retry-After` when throttled. The outbox must consolidate bursts and respect provider limits.

Initial Slack release:

- Connect workspace
- Select channel and binding scope
- Preview/test message
- Publish snapshot and configured digests
- Disconnect/revoke

Later Slack release:

- `/planbraid status`
- Link unfurling
- View-blockers and open-plan actions
- Mutating actions only after identity linking and RBAC

### 4.4 Microsoft Teams adapter

Use a Teams app containing a notification bot:

- Install the bot in the target team/channel.
- Save the conversation/channel reference.
- Send proactive bot messages.
- Render updates as Adaptive Cards.
- Process installation and removal lifecycle events.

Do not use Microsoft Graph application permission for ordinary background channel messages; application sending is limited to migration scenarios. Do not build the primary integration on deprecated Office 365 connectors.

### 4.5 Publication acceptance criteria

- A single-project binding never emits another project's information.
- An all-project binding includes current eligible projects and automatically enrolls future eligible projects.
- Exclusions and restricted-project permissions are always enforced.
- Overlapping bindings do not create duplicate messages.
- Every message identifies its project and links to Planbraid.
- Rapid events are consolidated according to the binding policy.
- Provider throttling does not lose updates.
- Disconnecting a binding stops future delivery.
- Revoked credentials produce a visible reauthorization state.
- Provider downtime never rolls back or blocks core Planbraid writes.

## 5. External work import and optimization — Planbraid #88

### 5.1 Shared import process

Each provider follows this process:

1. Connect with least-privilege OAuth scopes.
2. Select an explicit external account/project/filter.
3. Run a paginated initial backfill.
4. Store normalized external candidates without mutating accepted Planbraid work.
5. Reconcile against external IDs and existing Planbraid structure.
6. Present a human import review.
7. Accept, reject, ignore, or link candidates.
8. Process webhooks by fetching the canonical provider object.
9. Run periodic reconciliation to catch missed events.

### 5.2 Normalized work shape

Preserve at least:

- Provider and tenant/account
- External project/container
- External ID and display key
- Type
- Title and rich description
- Status and normalized status category
- Priority
- Assignee and creator provenance
- Labels, tags, and components
- Start and due dates
- Parent/hierarchy
- Explicit dependency and related-item links
- Iteration, sprint, or release
- Canonical URL
- External revision, ETag, or content hash
- Last-seen and tombstone state

Provider fields remain in external records. Do not add Basecamp-, Jira-, or Azure-specific columns directly to core `work_items`.

### 5.3 Import review outcomes

The review must explain every proposed action:

- New
- Exact external match
- Existing Planbraid match
- Resembles existing work
- Possible duplicate
- Conflict
- Ignored by rule
- Deleted externally
- Requires field mapping
- Requires human judgment

The review should reuse Planbraid's existing matching, typed relations, dependency graph, provenance, and acceptance workflow.

### 5.4 Smart planning and optimization

Run deterministic analysis before model-assisted analysis.

Deterministic findings:

- Duplicate external identities
- Similar work across systems
- Missing parents
- Orphan subtasks
- Invalid or circular dependencies
- Work marked ready despite unresolved prerequisites
- Completed parents with unfinished children
- Conflicting dates
- Unmapped statuses
- Deleted or inaccessible dependencies
- Stale work

Model-assisted proposals:

- Improve vague descriptions
- Identify missing acceptance criteria
- Decompose oversized features
- Group scattered tasks into coherent features
- Detect overlapping initiatives
- Propose dependency ordering
- Recommend implementation sequence
- Explain blockers
- Identify missing implementation information

Every model-assisted proposal must show its source items, explanation, confidence, proposed changes, dependency impact, and explicit accept/reject controls.

## 6. Basecamp-first implementation

### 6.1 MVP scope

The first working provider adapter supports:

- Basecamp OAuth authorization and refresh
- Account selection
- Project selection
- TodoSet -> TodoList -> Todo hierarchy
- Todo title and description/content
- Assignees
- Due dates
- Completion state
- Initial import and review
- Project-scoped webhook creation
- Todo and TodoList update processing
- Canonical refetch after webhook receipt
- Periodic reconciliation
- Webhook retry/deactivation health
- Disconnect and revoke

Basecamp does not express all engineering dependency concepts. Planbraid may suggest inferred dependencies, but they must be labeled as Planbraid proposals rather than Basecamp facts.

### 6.2 Basecamp operational constraints

- Send an identifying `User-Agent` as required by the Basecamp API.
- Follow pagination links rather than inventing page calculations.
- Use ETag/Last-Modified caching where supported.
- Honor `429` and `Retry-After`.
- Basecamp retries webhook deliveries and can deactivate a webhook after repeated failures; surface this state in the UI.
- Do not rely on webhook delivery as the only synchronization mechanism.

### 6.3 Basecamp test strategy

- Begin with a dedicated non-production Basecamp project when possible.
- If using a company project, obtain explicit approval for that project and keep the integration read-only.
- Seed a small hierarchy covering lists, todos, completion, assignment, and due-date changes.
- Verify repeat imports produce no duplicates.
- Verify redelivered webhook payloads are harmless.
- Verify a missed webhook is repaired by reconciliation.
- Verify disconnect stops API calls and removes/deactivates the webhook where supported.
- Sanitize recorded fixtures; never commit real company payloads or credentials.

## 7. Jira implementation after Basecamp

Use:

- Jira Cloud REST API v3
- OAuth 2.0 authorization-code/3LO flow
- JQL-scoped imports
- Atlassian Document Format conversion
- Issue hierarchy and issue links
- Dynamic webhooks
- Configurable project status/type mappings

Operational requirements:

- OAuth dynamic webhooks expire after 30 days and require scheduled renewal.
- OAuth webhook limits require consolidated filters rather than per-item hooks.
- Store rotating refresh tokens atomically.
- Periodically reconcile even when webhook renewal succeeds.

## 8. Azure DevOps implementation after Jira

Use:

- Microsoft Entra ID OAuth for new applications
- Work Item Tracking REST APIs
- WIQL or saved queries for import scope
- Batch fetching for selected work-item IDs
- Service Hooks for work-item changes
- Configurable process, type, state, area, and iteration mappings

Do not build new authentication on deprecated Azure DevOps OAuth.

## 9. Future bidirectional synchronization

Write-back is explicitly deferred until read-only imports are stable.

Each binding will require a field-ownership policy. A safe default is:

| Field | Default owner |
| --- | --- |
| External status | External tracker |
| External assignee | External tracker |
| Planbraid planning maturity | Planbraid |
| Suggested dependencies | Planbraid proposal |
| Accepted dependency link | Configurable |
| Title and description | External tracker until explicitly reassigned |

Every outbound mutation requires:

- Expected external revision or ETag
- Idempotent effect identity
- Echo suppression when the provider sends the change back by webhook
- Conflict detection and human resolution
- Full audit history
- Tombstones instead of deleting provenance

## 10. Delivery phases

| Phase | Work | Dependency |
| --- | --- | --- |
| 0 | Integration schema, encrypted secrets, bindings, webhook inbox, outbox, worker, health UI | Planbraid #86 |
| 1 | Basecamp OAuth, project selection, import, review, webhook, reconciliation | #86, then #88 |
| 2 | Slack OAuth, channel selection, single/all-project publishing, digests | #86, then #87 |
| 3 | Jira read-only import and reconciliation | Stable Basecamp adapter |
| 4 | Teams notification bot and Adaptive Cards | Stable publication contract |
| 5 | Azure DevOps import and reconciliation | Stable import contract |
| 6 | Identity-linked chat actions and controlled bidirectional write-back | Teams/RBAC and proven read-only integrations |

Basecamp may be implemented before Slack after the shared foundation because it is the highest-value testable provider for the product owner. Slack and Basecamp can proceed in parallel only after the shared contracts and migrations are stable.

## 11. Suggested Codex and Claude collaboration

Planbraid remains the coordination source of truth. Both agents must retrieve current context, reuse #86/#87/#88 and any child task IDs, record claims and progress, and sync before responding.

Recommended split after #86 is decomposed:

- One agent owns shared schema, encryption boundary, queue/outbox, and adapter contracts.
- One agent reviews the foundation and prepares the Basecamp adapter fixtures, mapping, and API client against the agreed contract.
- After the foundation merges, one agent implements Basecamp while the other implements Slack publishing.
- Neither agent edits the same migration or shared contract concurrently without an explicit handoff.
- Each provider adapter must have contract tests using sanitized fixtures.
- A feature is not marked verified until repository verification commands and provider-specific integration evidence pass.

Required repository verification:

```text
cd apps/web
npm run build
npm test
./node_modules/.bin/tsc --noEmit --pretty false
```

## 12. Security and privacy gates

- Least-privilege OAuth scopes
- OAuth `state` validation and PKCE where applicable
- Reversible secrets encrypted outside ordinary application data access
- Provider-specific webhook verification
- Replay and duplicate-delivery protection
- Tenant and destination binding checks
- No secret or raw company payload logging
- Project permission check at publication time, not only connection time
- Explicit confirmation for all-future-project publication
- Restricted-project exclusion by default
- Disconnect, revoke, data-retention, and audit controls
- HTTPS-only webhook destinations and callbacks
- Redacted operator diagnostics

## 13. Primary references

- Planbraid architecture: `PRODUCT_ARCHITECTURE_PLAN.md`
- Current shipped state: `IMPLEMENTATION_PLAN.md`
- Slack OAuth: https://docs.slack.dev/authentication/installing-with-oauth/
- Slack Events API: https://docs.slack.dev/apis/events-api/
- Slack rate limits: https://docs.slack.dev/apis/web-api/rate-limits/
- Teams proactive bots: https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/proactive-bots-and-messages/graph-proactive-bots-and-messages
- Microsoft Graph channel messages: https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0
- Basecamp API: https://github.com/basecamp/bc-api
- Basecamp authentication: https://github.com/basecamp/bc-api/blob/master/sections/authentication.md
- Basecamp todos: https://github.com/basecamp/bc-api/blob/master/sections/todos.md
- Basecamp webhooks: https://github.com/basecamp/bc-api/blob/master/sections/webhooks.md
- Jira REST v3: https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/
- Jira OAuth 2.0: https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
- Jira webhooks: https://developer.atlassian.com/cloud/jira/software/webhooks/
- Azure DevOps OAuth guidance: https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/oauth?view=azure-devops
- Azure DevOps WIQL: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1
- Azure DevOps Service Hooks: https://learn.microsoft.com/en-us/azure/devops/service-hooks/events?view=azure-devops

## 14. Definition of done for this initiative

The initiative is complete only when:

- The shared integration foundation is reliable and observable.
- Basecamp imports are repeatable, reviewable, and tested without exposing company data.
- A channel can safely bind to one project or all current and future eligible projects.
- Slack and Teams deliveries are idempotent, permission-aware, and noise-controlled.
- Jira and Azure adapters use the same stable import contract.
- Provider downtime, retries, revocation, deletion, and missed webhooks are recoverable.
- AI optimization remains explainable and human-controlled.
- Bidirectional synchronization, if later enabled, has explicit field ownership and conflict resolution.
- Build, tests, TypeScript validation, and provider-specific integration evidence pass.
