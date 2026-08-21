# Planbraid Implementation Plan

One ordered plan across the three design documents. This supersedes the individual
phase tables in [`GRAPH_ARCHITECTURE.md`](./GRAPH_ARCHITECTURE.md),
[`DEDUPLICATION_ARCHITECTURE.md`](./DEDUPLICATION_ARCHITECTURE.md), and
[`LOCAL_MODE_ARCHITECTURE.md`](./LOCAL_MODE_ARCHITECTURE.md) — those remain the
reference for *why* and *how*; this is *what* and *in what order*.

Sizes are relative: **S** = a sitting, **M** = a day or so, **L** = multi-day.

**Status: M0–M6 shipped.** The self-hosting/`wrangler.jsonc` half of M6 was deferred by
request until the OAuth/MCP flow was validated end to end, then superseded: once that
validation was done, the app was migrated off Cloudflare Workers/D1/`vinext` entirely
(standard Next.js, Postgres via Neon, deployed on Vercel with GitHub CI/CD) rather than
self-hosted on Cloudflare — the user's stated Vercel target from the start (see §9). The
milestone sections below are kept as the design record of what was built and why against
the original Cloudflare-based architecture; §1 reflects current state.

---

## 1. Where things stand

### Shipped and tested

| | Where |
|---|---|
| Structural duplicate matching (signature, vetoes, cascade) | `lib/dedup/` — no external dependencies |
| `create_work_items` deduplicates on write, and aliases are visible in the UI | `worker/index.ts`, `lib/store.ts:createWorkItemsDeduplicated`, `app/planbraid-app.tsx` |
| Alias split (unmerge a wrong match) | `split_alias` command, drawer action |
| Dependency edges: `link_work_items`, `depends_on` in `create_work_items`, type-filtered depth-bounded cycle check, idempotent duplicate edges | `lib/graph/edges.ts`, `worker/index.ts`, `lib/store.ts` |
| Auto-unblock: `blocking_count` propagation, aggregate `work_item.downstream_unblocked`/`downstream_reblocked` events, drift repair | `lib/store.ts:getReadyWork`'s sibling `downstreamOf`/`recomputeBlockingCounts`, `db/setup.ts` migration |
| Derived board columns, "waiting on" chain, started-while-blocked anomaly badge | `lib/graph/column.ts`, `app/planbraid-app.tsx` |
| `get_ready_work`: unlock-count ranking, live-session collision exclusion | `lib/store.ts:getReadyWork`, `worker/index.ts` |
| Connected-agent management: project-scoped session removal with preserved provenance, card delete controls, and compact modal identity/action rows | `lib/contracts.ts`, `lib/store.ts`, `app/planbraid-app.tsx`, `app/globals.css` |
| Server-normalized agent presence: shared active/idle/ended freshness policy, lease-aligned expiry, authoritative explicit end/removal, and reconnect-only terminal recovery | `lib/presence.ts`, `lib/read`, `lib/store.ts`, `app/planbraid-app.tsx`, `tests` |
| Ended-agent reuse: new external conversations adopt the latest ended source for the same project/provider/account, while active sessions, other accounts, and removed cards remain separate | `lib/store.ts:registerSourceSession`, `tests/agent-identity.test.mjs`, `tests/presence.test.mjs` |
| Unclipped project action menus: body-level portal positioning above scroll containers and all sidebar sections | `app/planbraid-app.tsx`, `app/globals.css`, `tests/rendered-html.test.mjs` |
| Project deletion visibility: archived tombstones are excluded from dashboard/project reads and reject later direct access while idempotent deletion retries remain valid | `lib/store.ts`, `lib/read/project-view.ts`, `app/api/events/route.ts`, `tests/project-management.test.mjs` |
| Basecamp and Jira read-only work integrations: encrypted OAuth grants, project bindings, provider discovery/import adapters, durable webhook inbox, Jira signature/renewal, scheduled reconciliation, review-before-import UI, and external provenance links | `lib/integrations/`, `app/api/integrations/`, `app/integrations-dialog.tsx`, `db/setup.ts`, `tests/integrations.test.mjs` — repository verified; live provider smoke test awaits deployment credentials |
| Basecamp zero-setup project onboarding: an omitted destination creates or reuses a same-named Planbraid project, active provider bindings drive dashboard grouping, and Basecamp-linked projects live in a collapsible sidebar section | `lib/integrations/service.ts`, `app/api/integrations/bindings/route.ts`, `lib/store.ts`, `app/integrations-dialog.tsx`, `app/planbraid-app.tsx`, `tests/integrations.test.mjs`, `tests/rendered-html.test.mjs` |
| Provider-aware import navigation and review clarity: Basecamp/Jira project groups use their official marks while projects retain letter avatars; fetch, review, and import are explicitly separate; Basecamp/Jira remain import-only, never receive Planbraid work mutations, and disconnect locally without deleting provider data or configuration | `app/integration-provider-mark.tsx`, `app/planbraid-app.tsx`, `app/integrations-dialog.tsx`, `lib/integrations/service.ts`, `lib/integrations/types.ts`, `tests/integrations.test.mjs`, `tests/rendered-html.test.mjs` |
| Auth-scoped client query cache: TanStack Query request sharing, freshness windows, revision-aware derived keys, mutation/SSE invalidation, and no unconditional dashboard polling | `CLIENT_QUERY_CACHE_ARCHITECTURE.md`, `apps/web/lib/query-cache.tsx`, `apps/web/lib/query-keys.ts`, `apps/web/tests/query-cache.test.mjs` |
| Rebrand: `PLANBRAID_*` primary with `RELAYBOARD_*` fallback, `planbraid-app.tsx`/`planbraid-hook.mjs` renamed | `integrations/`, root docs, `apps/web/app` |
| Domain-logic test coverage | `tests/dedup.test.mjs`, `tests/graph.test.mjs`, `tests/auto-unblock.test.mjs`, `tests/column.test.mjs`, `tests/ready-work.test.mjs` — 92 tests total, plus the 9-test build/rendered-HTML suite |

Verified end to end, live, against the real running app and browser session across every
milestone: multi-agent dedup collapsing proposals with corroboration, alias split
restoring an item, cycle rejection and idempotent duplicate edges over real MCP calls,
multi-blocker auto-unblock propagation (including the reblock/`unblocked_at`-reset path),
the started-while-blocked anomaly rendering correctly on the board and in the drawer, and
`get_ready_work` correctly excluding another live session's claim while still showing it
to the session that holds it.

### Superseded

Self-hosting on Cloudflare (`wrangler.jsonc`, decoupling `vite.config.ts` from
`.openai/hosting.json`) was deferred until the OAuth/MCP connection flow and the
platform overall were validated end to end. Once validated, the app moved directly to
Vercel/Postgres/Next.js instead — the Cloudflare-specific self-hosting path was never
built. See §9.

### Not built (deliberately)

See §10 — graph visualization, local mode, embeddings, inferred edges, critical path,
async reconciler, MCP sampling, multi-user.

---

## 2. The scoping principle

Two things drive every cut below.

**The graph's value is auto-unblocking, not a diagram.** A node-and-edge canvas is the
thing people ask for and the thing that gets opened twice. What actually changes a
workday is a task moving to Ready *by itself* when its blocker completes, and an agent
being handed the right next task. Both work with no visualization at all. The board is
already the graph, projected.

**Prefer invisible machinery over new surfaces.** Every new view is a thing to design,
teach, test, and maintain. The graph should show up as existing cards moving between
existing columns on their own.

---

## 3. Milestone 0 — Make deduplication visible (S)

Closes the half-finished feature. Nothing else should start before this.

**Goal:** when proposals collapse, the board says so in plain language.

| File | Change |
|---|---|
| `lib/contracts.ts` | Add `aliases: Array<{ workItemId, title, sourceId, matchMethod, createdAt }>` to `DashboardState` |
| `lib/store.ts` | Add the aliases query to the `loadDashboard` batch (project-scoped, capped); delete unused `listAliases` |
| `lib/dedup/match.ts` | Delete unused `buildProposal` |
| `app/planbraid-app.tsx` | `TaskCard`: small badge when an item has aliases. `TaskDrawer`: "Also proposed as" list with provider and wording |
| `tests/` | Assert aliases reach `DashboardState` and render |

**UX rules:**
- Show **why**, never a score. "Codex proposed this too" and "Same endpoint `/api/login`" — never `0.87`.
- Fold corroboration in here rather than as separate work; it is the same alias data
  counted by distinct provider. A card reading *"Proposed independently by Claude and
  Codex"* turns dedup from noise removal into a confidence signal, and costs one
  derived function.

**Done when:** running the two-agent scenario, the board shows 6 cards and each collapsed
one visibly names the agent that also proposed it.

---

## 4. Milestone 1 — Make a wrong match reversible (S)

The safety valve that makes automatic matching defensible. Without it, "reversible" is a
claim in a design document rather than a button.

| File | Change |
|---|---|
| `lib/contracts.ts` | New command: `{ action: "split_alias"; projectId; aliasId; idempotencyKey }` |
| `lib/store.ts` | Handler: create a real work item from the alias (preserving original title, description, source), delete the alias row, emit `work_item.split_from_alias` |
| `app/planbraid-app.tsx` | Drawer action on each alias: "Not the same — make separate task" |
| `tests/` | Split restores an independent item with its original wording and provenance |

**Not needed:** an MCP tool for this. Splitting is a human judgment about a machine's
mistake; the agent that caused it is the wrong one to adjudicate it.

---

## 5. Milestone 2 — Dependency edges can exist (M)

Today nothing can create a dependency. `add_dependency` is fully implemented at
`lib/store.ts:241` and unreachable from MCP and from the UI, so the `dependencies` table
is permanently empty. Everything graph-related is downstream of this.

| File | Change |
|---|---|
| `worker/index.ts` | New tool `link_work_items` → existing `add_dependency` command. Name fields for their role (`prerequisite` / `dependent`), not position — agents get from/to backwards about half the time |
| `worker/index.ts` | `create_work_items`: accept `depends_on: [ref]` per item |
| `lib/store.ts` | Resolve `depends_on` refs **after** dedup — a proposal that collapsed into `#4` must have its edge written against `#4`, not a dead ref |
| `lib/graph/edges.ts` *(new)* | `DAG_EDGE_TYPES = ["blocks", "requires"]`, shared by every traversal |
| `lib/store.ts` | Fix `dependencyWouldCycle`: filter by edge type, replace the in-memory DFS with a depth-bounded recursive CTE |
| `lib/store.ts` | Duplicate edge (`UNIQUE(from,to,type)`) → idempotent no-op, not the current misleading `CONCURRENT_MODIFICATION` 409 |
| `tests/` | Cycle rejection; symmetric `relates_to` **not** rejected; refs resolving through a merge; duplicate edge is a no-op |

**Two bugs fixed here, both live today:** the cycle check traverses every edge type, so
adding `A relates_to B` and `B relates_to A` is wrongly rejected as a cycle; and it
loads every project edge into worker memory on each write.

**UI:** none yet. Agents populate the graph; humans consume it in M3.

---

## 6. Milestone 3 — Blocked resolves itself (M)

The payoff. `PRODUCT_ARCHITECTURE_PLAN.md:329` already specifies this and nothing
implements it: today an item blocked on `#12` stays blocked forever after `#12`
completes, because `status` stores a derivation with no invalidation.

| File | Change |
|---|---|
| `db/setup.ts` | `work_items.blocking_count INTEGER NOT NULL DEFAULT 0`, `unblocked_at TEXT` via `MIGRATION_STATEMENTS` |
| `lib/store.ts` | `add_dependency`: increment when the prerequisite is unresolved |
| `lib/store.ts` | `transition_item`: on entering `done`/`cancelled`, decrement all hard-downstream; on leaving, increment. One indexed statement each, inside the existing `db.batch()` |
| `lib/store.ts` | Emit **one aggregate** `work_item.unblocked` event with the freed IDs in metadata — `work_events` has `UNIQUE(project_id, project_revision)`, so N events need N revisions, and one notification reading "3 tasks are now ready" beats three |
| `lib/store.ts` | Repair query recomputing `blocking_count` from scratch, for drift |
| `tests/` | Unblock on completion; re-block on reopen; **cancelled counts as resolved**; no version bump on downstream items |

**Two ways to get this wrong, both silent:**
- If `cancelled` doesn't count as resolved, cancelling one task deadlocks its entire
  downstream subtree permanently and invisibly.
- Downstream items must **not** get a `version` bump. Their asserted state didn't change,
  and bumping it would invalidate every agent's `expected_version` and cause phantom
  409s.

---

## 7. Milestone 4 — The board reflects the graph (S)

| File | Change |
|---|---|
| `lib/graph/column.ts` *(new)* | `deriveColumn(item, blockingCount)` — pure, no I/O |
| `app/planbraid-app.tsx` | Board groups by `deriveColumn`, not raw `status` |
| `app/planbraid-app.tsx` | Blocked card: "Waiting on #4". Drawer: the unresolved chain |
| `app/planbraid-app.tsx` | Anomaly badge when an item is `in_progress` with `blocking_count > 0` |
| `tests/` | The derivation table, including the anomaly case |

**The rule:** an actor's assertion is never overridden by topology. If Codex says it
started something, it stays in In Progress even if a prerequisite reopens — but it gets
flagged. That flag ("started while blocked") is the multi-agent collision this product
exists to catch, and it is undetectable without the graph.

`status = 'blocked'` survives as the *external* blocker (waiting on a human, a missing
credential), carried by the existing `blocker_reason`. Dependency-blocking becomes
derived. That keeps this additive rather than a rewrite of the state machine.

---

## 8. Milestone 5 — `get_ready_work` (M)

Where the intelligence actually lands. Today an agent calls `list_work_items`, gets a
flat array, and guesses.

| File | Change |
|---|---|
| `worker/index.ts` | New tool `get_ready_work`, described so agents prefer it over `list_work_items` for "what next" |
| `lib/store.ts` | Rank: exclude blocked → exclude items in another **live** session's `current_task_ids` → order by unlock count, then priority, then corroboration |
| `tests/` | Blocked excluded; another session's claims excluded; ranking order |

`sources.current_task_ids` already exists and is already maintained by
`heartbeat_agent_session`. Step 1 is table stakes — any todo app can do it. Steps 2 and 3
need to know which agent sessions are live and what they hold, which only this product
tracks. That is the differentiator, and it needs no new data.

---

## 9. Milestone 6 — Housekeeping (S, any time)

| Item | Change | Status |
|---|---|---|
| Finish the rebrand | `RELAYBOARD_*` → `PLANBRAID_*` in `integrations/` (old names kept as a one-release fallback in the bridge script); renamed `relayboard-hook.mjs` → `planbraid-hook.mjs` and `relayboard-app.tsx` → `planbraid-app.tsx`; updated `README.md`, `AGENTS.md`, `.mcp.json.example`, `integrations/README.md`, `integrations/gemini/GEMINI.md` | **Done** |
| Self-hosting on Cloudflare | Add `wrangler.jsonc`; decouple `vite.config.ts` from `.openai/hosting.json`; deploy docs | **Superseded** — once the OAuth/MCP flow and platform were validated end to end, the app moved to Vercel/Postgres/Next.js instead of self-hosting on Cloudflare |
| Migrate off Cloudflare/vinext/ChatGPT Sites to Vercel | Postgres (Neon) schema + `PgD1` compatibility shim replacing D1, `vinext` replaced with standard `next`, `worker/index.ts`'s `/mcp` and OAuth routing ported to Next.js route handlers, `.openai/hosting.json`/`vite.config.ts`/`wrangler` removed, Vercel + GitHub native CI/CD | **Done** |
| Rotate credential | `apps/web/.env.local` (formerly `.dev.vars`) holds a Google OAuth client secret in plaintext. It is correctly gitignored and never committed (verified — not in `git ls-files` or history) — rotate anyway if it is not disposable | **Flagged to the user**, not actionable by an agent |

---

## 10. What we are deliberately not building

| | Why |
|---|---|
| **Graph visualization** | The board *is* the graph. A canvas is a new surface to design, teach, and maintain, and it duplicates information already on screen. Revisit only if users ask after M3–M4 land |
| **Local mode** | Splits the product into two deployments to version and support forever, and forecloses multi-user. Self-hosting (M6) answers the same concern at a fraction of the cost |
| **Embeddings / semantic tier** | Built, measured, removed. See `DEDUPLICATION_ARCHITECTURE.md:§6.1` |
| **Inferred dependency edges** | Requires a review queue nobody has asked for. Let agents declare edges first and see whether they actually under-declare |
| **Critical path, layers, parallelism certificates** | Only pay off with a visualization. Deferred with it |
| **Async duplicate reconciler** | The synchronous matcher handles the real case. Add only if concurrent authorship proves common |
| **`content_fingerprint` unique index** | Would make a human typing an exact duplicate a hard error. The synchronous matcher already covers the normal case; the index only guards a narrow race and needs its own pass |
| **MCP sampling** | Needs streamed-SSE transport work before it is even possible |
| **Multi-user / teams** | Out of scope until there is a second user |

---

## 11. Open decisions

1. **Should `block_work` accept blocker item IDs?** **Done in M2.** `block_work` now
   accepts `blocker_work_item_ids`; each one becomes a `blocks` edge (fails loudly on a
   bad ID, since this is one deliberate action rather than a batch), and `reason` is
   auto-derived from the resolved item keys when not supplied.
2. **Should the UI let humans create dependencies, or only agents?** M2 ships
   agent-only. A drag-to-link affordance is real UI work; a "blocked by #N" field in the
   drawer is nearly free. Recommend the field, not the drag.
3. **Does `#N` renumbering ever matter?** Only for local-mode sync, which is not being
   built. Ignore it.

---

## 12. Order and rationale

```
M0  visible dedup      ─┐ finish what is half-built
M1  unmerge            ─┘ before starting anything new

M2  edges exist        ─┐
M3  auto-unblock        ├ the actual "smart" feature
M4  derived columns    ─┘

M5  get_ready_work       the differentiator

M6  housekeeping         independent, any time
```

M0 and M1 first because an unfinished feature in the codebase costs more than a missing
one — it is already running, already collapsing proposals, and already unable to explain
itself.

M2 is small and gates everything after it. M3 is where a user first notices the product
got smarter without being told to look anywhere new. M5 is the thing no single-agent tool
can copy.

Everything in §10 stays unbuilt until something concrete argues otherwise.
