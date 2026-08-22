# Slack Integration: Implementation Plan

Companion to `INTEGRATIONS_IMPLEMENTATION_PLAN.md` (the approved product requirements).
That document says *what* to build. This one says *how*, against the actual state of this
repository, and records the decisions that document left open.

Status: proposed, not started
Scope confirmed with product owner: public multi-workspace distribution, Vercel Pro,
full Phase 0 foundation before Slack, event-first delivery.

---

## 1. Context

Planbraid is the authoritative planning system; Slack is a communication surface that
receives updates and cannot mutate the plan. Today there is no integration code at all:
no `integration*` tables in `db/setup.ts`, no `lib/integrations/`, no Slack references.
The root `integrations/` directory is unrelated (it holds agent-side hook bridges).

Four things about this codebase decide most of the design below, and all four were
verified rather than assumed:

**There is no background execution path.** No `vercel.json`, no cron, no queue library,
no worker. The only post-response mechanism in the entire app is a single `waitUntil` in
`apps/web/lib/mcp/server.ts:65`, which is not durable. This integration builds the first
durable background path in the product.

**Outbound OAuth exists exactly once, and it is not a safe template.** `apps/web/lib/github.ts`
is the only place Planbraid connects *out* to another service. It works, but it sends **no
`state` parameter and verifies no CSRF nonce** on its callback, it stores `expires_at` but
never reads it (refresh is reactive-on-401 only), and it reads `process.env` directly
instead of the `lib/runtime-env.ts` `env` object every other subsystem uses. Copy its
*shape*, not its gaps. By contrast `apps/web/lib/oauth.ts` is Planbraid acting as an OAuth
**provider** for MCP clients and has no outbound client code to reuse.

**Reversible encryption exists but does not meet the bar this document sets.**
`apps/web/lib/crypto-box.ts` (`sealSecret`/`openSecret`) is real AES-256-GCM and is
production-proven on GitHub tokens. But it derives its key by hashing `BETTER_AUTH_SECRET`,
the same secret that signs sessions, and its ciphertext format is `iv.ciphertext` with no
key id or version, so **there is no key rotation path** — rotating that secret silently
invalidates every stored credential. `INTEGRATIONS_IMPLEMENTATION_PLAN.md` §3.1 explicitly
requires envelope encryption with keys not stored beside ciphertext. That is a real gap to
close, not a formality, because a public multi-workspace app holds other companies' bot tokens.

**MCP commands never touch `/api/commands`.** Browser mutations go through that route, but
agent mutations go straight from `lib/mcp/server.ts` into `executeCommand`. `/api/commands`
already does a post-commit fan-out for Web Push and consequently **misses every
agent-driven event**. Any integration hook placed in the route would inherit that bug. The
hook must live inside `lib/store.ts`.

---

## 2. Slack platform facts that constrain the design

Verified against current Slack documentation, August 2026.

| Constraint | Consequence |
| --- | --- |
| `chat.postMessage` is Special Tier: ~1 message/second/channel, workspace-wide cap, `429` + `Retry-After` | Event-first delivery **must** consolidate bursts. A worker-side per-channel token bucket is mandatory, not optional. |
| Events API request URLs must respond within **3 seconds** | Uninstall/revoke handling must verify, persist to `webhook_inbox`, return 200, and process later. Never process inline. |
| Signing secret verification: HMAC-SHA256 over `v0:{timestamp}:{raw_body}`, `v0=` prefix, 5-minute window, constant-time compare | Needs the **raw** body. Next.js route handlers must read `await request.text()` before any JSON parse. |
| Token rotation is **opt-in and irreversible once enabled**; 12h access tokens, single-use rotating refresh tokens, 2-active-token limit | See §4. Recommendation: build the code path, do not enable it yet. |
| Bot must be a channel member to post; `chat:write.public` covers public channels without joining | Request `chat:write.public` and skip `conversations.join` for public channels. Private channels require a human to invite the bot; the UI must say so. |
| Block Kit: 50 blocks/message, section text 3000 chars, 10 fields × 2000 chars | Rendering must truncate deliberately, not accidentally. |
| `chat.update` has no time-window limit for apps updating their own messages | A live-updating snapshot message is viable later without re-architecture. |
| May 2025 non-Marketplace rate limits apply to `conversations.history` / `conversations.replies` | **Does not affect us.** This is a write-only publisher; we never call either method. Worth stating explicitly in the Marketplace submission. |
| Public distribution is a prerequisite for Marketplace review; review is manual | Ship and dogfood on an unlisted public app first; submit for listing once stable. |

**Scopes to request (least privilege, and no more):**
`chat:write`, `chat:write.public`, `channels:read`, `groups:read`, `team:read`.
Deliberately excluded: anything that reads message content or user directories. This both
eases Marketplace review and keeps us clear of the read-path rate limits above.

---

## 3. Known gap in the product requirements

`INTEGRATIONS_IMPLEMENTATION_PLAN.md` §2.1 says restricted projects "are excluded unless
the installer is authorized and explicitly opts them in." **That has no implementation
basis today.** `organizations.owner_user_id` is `UNIQUE` — there is exactly one org per
user, no multi-user orgs, no project-level RBAC, and no notion of a restricted project.
Notifications are addressed to `principal.userId` (the actor), never fanned out to members.

For v1 this resolves cleanly: "all projects" means all projects in the installer's own org,
which they own outright, so the authorization question is vacuous. The plan below still
builds the **exclusion list** (real and useful) and adds a per-project `publishable` flag so
the primitive exists when RBAC arrives. The "restricted project" language should be marked
deferred in the requirements document rather than silently unimplemented.

---

## 4. Decision: do not enable Slack token rotation in v1

Rotation is the better long-term posture and Marketplace reviewers view it favorably. But
enabling it is **irreversible**, it forces 12-hour access tokens, and its refresh tokens are
single-use — meaning two concurrent serverless invocations refreshing the same connection
will race, and the loser's token gets revoked. Getting that right needs the advisory-lock
work (`db.lock()` inside `db.transaction()`) done deliberately.

Plan: ship with standard non-expiring bot tokens, but **build `refreshCredentials()` in the
adapter and store `access_token_expires_at` (null when not rotating) from day one**, so
enabling rotation later is a config change plus a lock, not a redesign. Revisit before
Marketplace submission.

---

## 5. Phase 0 — shared integration foundation

Per the requirements document, the full foundation lands before Slack.

### 5.1 Schema (`apps/web/db/setup.ts`)

There is no migration framework. New tables append to `SCHEMA_STATEMENTS` (one `db.batch`,
single transaction, runs on first request per cold start); new columns on existing tables
append to `MIGRATION_STATEMENTS`. Match existing conventions: `TEXT PRIMARY KEY` with typed
id prefixes, `TIMESTAMPTZ NOT NULL DEFAULT now()`, JSON payloads as `TEXT DEFAULT '{}'`,
`organization_id TEXT NOT NULL` on every tenant table, snake_case unquoted.

Eight tables per §3.1: `integration_connections`, `integration_secrets`,
`project_integration_bindings`, `external_items`, `work_item_external_links`,
`webhook_inbox`, `integration_outbox`, `sync_runs`.

Slack only exercises the first three plus `webhook_inbox` and `integration_outbox`; the
import-side three are created now (per the chosen scope) but stay unused until Basecamp.

Two additions beyond the document, both load-bearing:

- `integration_oauth_states` — random nonce, `owner_user_id`, intended `project_id`,
  `expires_at` (10 min), `used_at`. Single-use, mirroring the existing
  `oauth_authorization_requests` pattern in `lib/oauth.ts`. **This is the CSRF protection
  the GitHub flow lacks and must not be skipped.**
- `projects.publishable BOOLEAN NOT NULL DEFAULT true` via `MIGRATION_STATEMENTS` — the
  primitive behind §3's deferred restricted-project concept.

Key indexes: `integration_outbox(status, not_before)` for the drain claim,
`UNIQUE(effect_key)` for idempotency, `webhook_inbox UNIQUE(provider, delivery_id)` for
replay protection.

### 5.2 Envelope encryption (`apps/web/lib/integrations/secrets.ts`)

New module, not a change to `crypto-box.ts` (GitHub keeps working unchanged).

- Per-record random 32-byte DEK encrypts the token with AES-256-GCM.
- DEK is wrapped by a KEK read from a **dedicated** `INTEGRATION_KEK_<id>` env var, keyed by
  `INTEGRATION_KEK_ACTIVE` — deliberately separate from `BETTER_AUTH_SECRET`.
- Ciphertext format `v1.{kekId}.{wrappedDek}.{iv}.{ct}`, all base64url. The embedded `kekId`
  is what makes rotation possible: add a new KEK, re-wrap DEKs in a background pass, retire
  the old one — without ever decrypting or rewriting the payload ciphertext.
- `openSecret` returns `null` rather than throwing, matching `crypto-box.ts`, so an
  unreadable credential reads as a missing one and prompts reconnection.
- Interface kept narrow enough that swapping the KEK source for AWS/GCP KMS later is one
  function.

Tokens are never returned to the browser after the OAuth callback.

### 5.3 Adapter contract (`apps/web/lib/integrations/types.ts`)

The `IntegrationAdapter` interface from §3.2, with every capability optional except
`authorize`/`validateConnection`/`revoke`. Slack implements the publish half; Basecamp will
implement the fetch half. **Domain code consumes normalized results only** — no
provider-specific response shapes leak past the adapter boundary.

### 5.4 Outbox, worker, and cron

**Enqueue.** One outbox row per `(domain event, binding)`, written in the *same commit* as
the domain mutation. `commitMutation(db, statements)` in `lib/store.ts:292` is the existing
choke point through which every command's statement array passes; publication statements
are built by a new `enqueuePublications(...)` helper and spliced into that array at the
event sites listed in §6.1. Effect key is
`sha256(bindingId:eventType:workItemId:projectRevision)` under a unique constraint, so a
retried command cannot double-send. Provider failure can never fail a Planbraid transaction
because nothing here touches the network.

**Drain.** `apps/web/app/api/cron/integrations/route.ts`, authenticated by the
`Authorization: Bearer $CRON_SECRET` header Vercel sets automatically. Claims a bounded
batch with `SELECT ... FOR UPDATE SKIP LOCKED` inside `db.transaction()`, sends, records
results, returns. **Bounded and resumable, never a long loop** — the connection pool is
`max: 5` per instance (`lib/runtime-env.ts`) and a claiming transaction holds one for its
whole batch. Set `export const maxDuration` explicitly; no route in this repo currently does.

**Schedule.** New `apps/web/vercel.json` with `crons: [{ path: "/api/cron/integrations",
schedule: "* * * * *" }]`. Minute-level is available on Pro and is what makes fast retry
after a provider failure viable. Additionally `waitUntil(kickDrain())` after publishing
commits, purely as a latency optimization — the cron remains the durability guarantee.

**Consolidation and rate limiting.** This is what makes event-first delivery survivable.
Each outbox row carries `not_before` and a `coalesce_key`. Before sending, the worker groups
pending rows by `(binding, coalesce_key)` within a per-binding debounce window (default 30s)
and merges them into **one** Block Kit message. A per-channel token bucket enforces Slack's
~1/sec. On `429`, `not_before` advances by `Retry-After` and **attempts is not incremented**
— throttling is not failure. Other failures use exponential backoff with jitter and
dead-letter after a cap, with an operator-visible retry action.

**Reconciliation.** A periodic pass re-drives dead-lettered rows and re-validates connection
health, so a missed webhook or a transient outage self-heals rather than requiring a human.

---

## 6. Phase 1 — Slack

### 6.1 Which domain events publish

Verified event sites, all in `lib/store.ts`. There is no `recordEvent` helper — 19 raw
`INSERT INTO work_events` sites — so hooks attach at the specific transitions that matter:

| Toggle | Event type | Site |
| --- | --- | --- |
| New blockers | `work_item.blocked` | `store.ts:836` |
| Work completed | `work_item.completion_verified`, `.completion_reported` | `store.ts:836` |
| Ready work | `work_item.downstream_unblocked` | `store.ts:867` |
| Plan changes | `work_item.maturity_changed`, `.merged`, `dependency.added` | `store.ts:584/697/537` |
| Decisions | `work_item.created` filtered to `type: 'decision'` | `store.ts:499` |

`work_item.downstream_unblocked` is the single highest-signal event in the system — it fires
exactly when items cross the blocking threshold. Note decisions currently emit no
notification of their own, so the decision toggle filters on item type.

### 6.2 OAuth install (public, multi-workspace)

`/api/integrations/slack/connect` mints a single-use state row and redirects to
`https://slack.com/oauth/v2/authorize`. `/api/integrations/slack/callback` consumes the
state, rejects on mismatch or expiry, exchanges via `oauth.v2.access`, and stores the bot
token through §5.2. `redirect_uri` must be HTTPS and byte-identical in both steps.

### 6.3 Bindings and UI

Channel picker calls `conversations.list` (Tier 2, cursor-paginated, ≤200/page), storing
**channel IDs, never names**. Binding config covers scope (one project / all current and
future), exclusions, event toggles, and debounce.

Overlap suppression is enforced twice: a warning when a binding is created that overlaps an
existing one on the same `(connection, channel_id)`, and a hard guarantee at delivery time
where the fan-out dedupes by channel and prefers the more specific project binding. That
satisfies §4.5's "overlapping bindings do not create duplicate messages" even if a user
creates them anyway.

The all-projects scope requires a prominent confirmation that future projects auto-publish.

**UI placement.** `AgentsManageDialog` (`planbraid-app.tsx:639-671`) is the pattern to
clone — dialog shell, list rows, inline edit — and is far smaller and cleaner than
`SetupDialog` (~162 lines, account-level). Add an "Integrations" entry to `ProjectMenu`
(`planbraid-app.tsx:593-637`) for project bindings, and an account-level entry alongside the
existing GitHub panel in `ProfileDialog` for the workspace connection. REST routes under
`/api/integrations/*` follow the `/api/tokens` template rather than extending the `Command`
union, matching how connections are already managed.

### 6.4 Message rendering

Block Kit, every message labeled with its project and linking back to Planbraid.
`eventAction()` and `eventTone()` already exist in `planbraid-app.tsx` (~line 1660) as
client-side label maps; **extract them to a shared module** so server-rendered Slack copy and
the in-app activity feed cannot drift. Deep links reuse the existing `/?project=X&item=Y`
form. `getHandoffPackage` (`lib/planning/handoff.ts`) already emits a full prose project
summary and is the digest body when digests are enabled.

### 6.5 Uninstall and revocation

`/api/integrations/slack/events` verifies the signature against the raw body, answers the
`url_verification` challenge, dedupes on `X-Slack-Retry-Num` plus delivery id, writes to
`webhook_inbox`, and returns 200 **within 3 seconds**. Processing of `app_uninstalled` and
`tokens_revoked` happens on the next worker tick: mark the connection
`reauthorization_required` or `disconnected`, stop delivery, surface the state in the UI.

---

## 7. Files

**New:** `lib/integrations/{types,secrets,registry,outbox,worker,publish,render}.ts`,
`lib/integrations/slack/{adapter,api,verify}.ts`,
`app/api/integrations/**`, `app/api/cron/integrations/route.ts`, `vercel.json`.

**Modified:** `db/setup.ts` (tables), `lib/store.ts` (enqueue at §6.1 sites),
`app/planbraid-app.tsx` + `app/globals.css` (UI), `package.json` (test script),
`.env.example` (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`,
`INTEGRATION_KEK_ACTIVE`, `INTEGRATION_KEK_<id>`, `CRON_SECRET`).

---

## 8. Verification

Tests are `node --test` against real embedded Postgres (`tests/support/local-pg.mjs`, PGlite).
**There is no fetch mocking anywhere in this repo** — so the Slack adapter takes an injectable
transport, mirroring how `dispatchNotification(db, id, pushEnv)` takes an injectable env in
`lib/push.ts`. New test files must be added to the `test` script in `package.json` explicitly
or they will not run.

- Signature verification against known vectors, including the 5-minute replay window.
- Outbox: run real `executeCommand` transitions, assert rows land with correct effect keys;
  assert a replayed command produces no second row.
- Consolidation: enqueue 20 rapid events, assert exactly one Slack call.
- Throttling: stub transport returns `429` + `Retry-After`; assert `not_before` advances and
  attempts is **not** incremented.
- Scope isolation: assert a single-project binding never emits another project's events, and
  that overlapping bindings emit once.
- Uninstall: assert delivery stops and connection state becomes visible.

Caveat: PGlite does not enforce `pg_advisory_xact_lock`, so lock-based concurrency needs a
real Postgres to verify. `FOR UPDATE SKIP LOCKED` does work there.

Then the standard gate:

```
cd apps/web
npm run build
npm test
./node_modules/.bin/tsc --noEmit --pretty false
```

Note `tests/rendered-html.test.mjs` scans `app/planbraid-app.tsx` for em/en dashes and
`app/globals.css` for `font-size: 11px`. UI work here touches both.

Live verification: install into a real Slack workspace, bind a scratch project, drive
transitions from an agent over MCP (proving the `store.ts` hook covers the agent path that
`/api/commands` misses), confirm consolidation during a burst, then uninstall and confirm
delivery stops and the UI shows it.

---

## 9. Sequencing

| Step | Deliverable | Reviewable on its own |
| --- | --- | --- |
| 0a | Schema, envelope encryption, adapter contract | Yes — tests only |
| 0b | Outbox, worker, cron, backoff, dead-letter | Yes — tests only |
| 1a | Slack OAuth install, connection management, channel picker | Yes — connect and disconnect |
| 1b | Bindings, scopes, exclusions, overlap suppression | Yes — config only |
| 1c | Event publication, Block Kit, consolidation | Yes — first real messages |
| 1d | Events API, uninstall/revoke, health UI | Yes |
| 1e | Public distribution checklist and submission | Gated on Slack review |

Steps 0a and 0b are the largest and least visible. They are also where the reliability
guarantees actually live, so they should not be compressed.
