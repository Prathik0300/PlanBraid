# Planbraid Graph Architecture

How the dependency graph is created, how the DAG is maintained in real time, and how
column assignment is derived from graph topology rather than asserted by hand.

This document is grounded in the code as it exists today (`apps/web`), not in the
aspirational design of `PRODUCT_ARCHITECTURE_PLAN.md`. Where the two diverge, the
divergence is called out.

---

## 1. What exists today

### 1.1 The graph data model is already there

`dependencies` is a real table with the right shape (`db/schema.ts:204-216`,
runtime DDL at `db/setup.ts:27-28`):

```sql
CREATE TABLE dependencies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  from_work_item_id TEXT NOT NULL,
  to_work_item_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'blocks',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(from_work_item_id, to_work_item_id, type),
  CHECK(from_work_item_id <> to_work_item_id)
);
CREATE INDEX idx_dependencies_to ON dependencies(to_work_item_id);
```

Traversal is indexed in **both** directions: upstream via `idx_dependencies_to`,
downstream via the `UNIQUE(from, to, type)` index used as a left-prefix on `from`.
Self-edges are rejected at the storage layer. This is a sound foundation.

There is also a **second, unused graph**: `work_items.parent_id` (`db/schema.ts:159`)
is declared, mapped into the `WorkItem` type (`lib/contracts.ts:48`), and never written
by any code path. Hierarchy is a tree, distinct from the dependency DAG — see §6.

### 1.2 Edge creation exists but is unreachable

`executeCommand` handles `add_dependency` (`lib/store.ts:241-259`) with validation,
cycle detection, event emission, and idempotency. It is correct code.

It is also **dead code in practice**. Searching the entire app for `add_dependency`
returns exactly two hits: the type declaration (`lib/contracts.ts:120`) and the
handler itself (`lib/store.ts:241`).

- It is **not** one of the 17 MCP tools (`worker/index.ts:66-84`). No agent can call it.
- It is **not** wired to any UI control. No human can click it.
- `create_work_items` has no dependency field in its input schema (`worker/index.ts:71`).
- The only way to reach it is hand-crafting a `POST /api/commands` body against the
  generic pass-through at `app/api/commands/route.ts:11-17`.

Meanwhile the `plan_project_work` prompt instructs agents to *"Record accepted tasks
with `create_work_items` and explicit dependencies"* (`worker/index.ts:243`) — asking
for something the tool surface cannot express. And `block_work`'s documented contract
in the plan is *"Input: item ID, blocker item IDs and/or structured external blocker"*
(`PRODUCT_ARCHITECTURE_PLAN.md:465`), but the shipped tool accepts only a free-text
`reason` (`worker/index.ts:74`, `transitionSchema()` at `:86-88`).

**Consequence: the `dependencies` table is empty in production and always will be
until an edge-creation tool ships.** Every graph feature is downstream of fixing this.

### 1.3 Columns are a stored string, not a derivation

The board is a `GROUP BY status` over a manually-asserted column
(`app/planbraid-app.tsx:306-307`):

```tsx
const columns: WorkStatus[] = ["proposed", "planned", "ready", "in_progress", "blocked", "in_review", "done"];
// ...
{items.filter((item) => item.status === status).map(...)}
```

`ALLOWED_TRANSITIONS` (`lib/store.ts:8-17`) is a pure status→status legality table.
It never consults `dependencies`. Nothing in the write path does.

The practical failure this produces: **blocked items go stale.** An item marked
`blocked` because it was waiting on `#12` stays `blocked` forever after `#12` completes.
Nothing recomputes it. A human — or the next agent to read the brief — has to notice
and manually transition it. This directly violates the plan's own rule:

> Resolving all hard blockers does not silently start work. It changes the item to
> `ready` and emits a notification. — `PRODUCT_ARCHITECTURE_PLAN.md:329`

Nothing implements that sentence. It is the single highest-value thing the graph buys.

### 1.4 Cycle detection: correct in spirit, two real defects

`dependencyWouldCycle` (`lib/store.ts:349-364`) loads every edge in the project into a
JS `Map` and runs an iterative DFS from `toId` looking for `fromId`.

**Defect 1 — no type filter.** The query is `SELECT from_work_item_id,
to_work_item_id FROM dependencies WHERE project_id = ?` with no `type` predicate. But
`type` spans both ordering edges and annotation edges. Per the plan
(`PRODUCT_ARCHITECTURE_PLAN.md:246-252`), `duplicates` and `relates_to` are inherently
**symmetric** — `A relates_to B` and `B relates_to A` are both meaningful and both
true. Under the current traversal, adding the second one is rejected as a cycle.
Annotation edges must be excluded from the DAG entirely.

**Defect 2 — unbounded materialization.** Every edge write pulls the whole project's
edge set into worker memory. Fine at 50 edges, not at 50,000. The plan explicitly
budgets for bounded traversal (`PRODUCT_ARCHITECTURE_PLAN.md:1601`, `:1877`).

### 1.5 Real-time plumbing already exists

`GET /api/events` (`app/api/events/route.ts`) is an SSE stream that polls
`work_events` every 3s for `project_revision > cursor` and closes at 25s.
`projects.revision` increments on every mutation and `work_events` carries a
`UNIQUE(project_id, project_revision)` constraint (`db/schema.ts:199`) — so revision
is a strict per-project event sequence number.

This is a well-designed spine. Graph propagation should ride on it, not around it.
Note the unique constraint carefully — it constrains fan-out design (§4.4).

---

## 2. The core problem: `status` conflates two different things

A single `status` column is being asked to encode two facts of completely different kinds:

| | Kind | Owner | Changes when |
|---|---|---|---|
| `in_progress`, `in_review`, `done`, `cancelled` | **Assertion** — somebody did something | The actor (agent or human) | An actor acts |
| `ready`, `blocked` | **Derivation** — a fact about the graph | The graph | *Any other item* changes |

`blocked` is not something an item *is*. It is something the item's **upstream
neighborhood** currently implies. Storing it means storing a cached derivation with no
invalidation, which is exactly why it goes stale.

The fix is not to add a graph view on the side. It is to **stop storing the derived
half** and compute it from topology.

### 2.1 Two axes

**Axis 1 — execution state (asserted, stored, actor-owned):**

```
proposed → planned → in_progress → in_review → done
                                                 ↓
                                             cancelled
```

**Axis 2 — readiness (derived, computed, graph-owned):**

```
unblocked | blocked_by_dependency | blocked_external
```

`blocked_external` is the one blocking case that is *not* derivable from the graph —
waiting on a human decision, a missing credential, a third-party outage. Per the plan
(`§5.4`), that is a structured external blocker and stays asserted, carried by the
existing `blocker_reason` column. So `status = 'blocked'` survives, but it now means
strictly "externally blocked," and dependency-blocking becomes derived.

This makes the change **additive rather than a rewrite** — the existing state machine,
`block_work` tool, and `blocker_reason` field all keep working unchanged.

### 2.2 The column is a pure function

```ts
export type Column =
  | "proposed" | "ready" | "blocked" | "in_progress" | "in_review" | "done" | "cancelled";

export function deriveColumn(item: WorkItem, readiness: Readiness): Column {
  // Terminal and actively-asserted states win: an actor's claim is never
  // overridden by topology.
  if (item.status === "cancelled")   return "cancelled";
  if (item.status === "done")        return "done";
  if (item.status === "in_review")   return "in_review";
  if (item.status === "in_progress") return "in_progress";

  // Not-yet-started work is positioned by the graph.
  if (item.status === "blocked")            return "blocked";  // asserted external blocker
  if (readiness.hardBlockers > 0)           return "blocked";  // derived from the DAG
  if (item.status === "proposed")           return "proposed";
  return "ready";                                              // planned + unblocked
}
```

Two properties worth stating explicitly:

**An actor's assertion is never overridden.** If Codex says it started something, it
shows as In progress even if an upstream prerequisite was just reopened. Topology does
not silently contradict a claim. Instead it raises a flag:

```ts
const anomaly = item.status === "in_progress" && readiness.hardBlockers > 0
  ? "started_while_blocked" : null;
```

That anomaly is a genuinely useful multi-agent signal: *Codex is working on something
whose prerequisite Claude just reopened.* It's the class of collision this product
exists to catch, and it is only detectable once the graph exists.

**Unblocking is free.** When the last upstream blocker completes, every downstream item
moves Blocked → Ready with no write to those items at all. The column is a function of
`(status, blocking_count)`, and `blocking_count` changed. That is the whole payoff.

---

## 3. Which edges are DAG edges

Not every row in `dependencies` participates in the DAG. Getting this wrong is what
produces defect 1 in §1.4.

| `type` | Ordering? | Counts toward blocking? | In topological sort? |
|---|---|---|---|
| `blocks` | yes, hard | **yes** | yes |
| `requires` | yes, soft | yes (configurable per project) | yes |
| `conflicts_with` | no — mutual exclusion | no | no (see §7.3) |
| `relates_to` | no — symmetric | no | **no** |
| `duplicates` | no — symmetric | no | **no** |
| `supersedes` | no — resolution, not order | no | **no** |

Define one constant and use it everywhere:

```ts
export const DAG_EDGE_TYPES = ["blocks", "requires"] as const;
```

Every traversal — cycle check, counter maintenance, layering, critical path — filters
on this set. Annotation edges are stored in the same table, rendered in the UI, and
invisible to all graph math.

---

## 4. How the DAG is maintained in real time

### 4.1 Three candidate strategies

**A. Derive on read, client-side.** `DashboardState` already ships every work item and
every dependency to the browser (`lib/store.ts:141`, `lib/contracts.ts:108`). A
topological pass in React is ~30 lines and needs zero schema or write-path changes.

*Good:* ships in an afternoon, correct by construction, no drift possible.
*Bad:* MCP clients get nothing unless the worker duplicates the logic; dies past a few
thousand items; recomputes the whole project on every keystroke.

**B. Derive on read, server-side, memoized on `projects.revision`.** Compute in the
worker; cache the result keyed on the project's current revision.

The elegance here: `projects.revision` already increments on **every** mutation
(`lib/store.ts:233`, `:253`, `:302`, `:324`) and is already the SSE cursor. It is a
free, always-correct cache key. Cache invalidation is automatic — a stale revision is
a cache miss by definition.

*Good:* one implementation serves UI and MCP; exact; no drift.
*Bad:* O(V+E) on the first read after any change. On a hot project that is every read.

**C. Incremental counter maintenance (Kahn's algorithm, incrementalized).** Store a
per-item count of unresolved upstream blockers and adjust it in the same transaction
as the mutation that changes it.

*Good:* O(out-degree) per write, O(1) per read; propagation is exact and instant;
naturally emits unblock events.
*Bad:* it is a materialized derivation, so it can drift and needs a repair job.

### 4.2 Recommendation: C for readiness, B for analysis

These solve different problems and compose cleanly.

- **Counters (C)** answer *"is this blocked?"* — needed on every read, on the hot path,
  must be exact and instant. Cheap to maintain.
- **Memoized topological analysis (B)** answers *"what's the critical path / layer /
  unlock count?"* — needed on graph render and on `get_ready_work`, tolerates being
  computed once per revision.

Strategy A is still worth shipping first as a throwaway, because it validates the
column-derivation UX before any schema migration.

### 4.3 The counter invariant

Add to `work_items`:

```sql
ALTER TABLE work_items ADD COLUMN blocking_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN unblocked_at TEXT;
```

The invariant, which the repair job checks:

```sql
blocking_count(X) = (
  SELECT COUNT(*)
  FROM dependencies d
  JOIN work_items u ON u.id = d.from_work_item_id
  WHERE d.to_work_item_id = X
    AND d.type IN ('blocks','requires')
    AND u.status NOT IN ('done','cancelled')
)
```

**`cancelled` must count as resolved.** If it doesn't, cancelling an upstream task
deadlocks its entire downstream subtree permanently and invisibly. This is the single
easiest way to get this design wrong.

### 4.4 Maintenance points

Every one of these is a plain SQL statement that slots into the `db.batch()` array that
`commitMutation` (`lib/store.ts:168-178`) already builds. No new transaction machinery.

| Trigger | Effect |
|---|---|
| `add_dependency(U → X)`, hard type, U unresolved | `blocking_count(X) += 1` |
| `remove_dependency(U → X)`, hard type, U unresolved | `blocking_count(X) -= 1` |
| U transitions **into** `done`/`cancelled` | `blocking_count -= 1` for all hard-downstream of U |
| U transitions **out of** `done`/`cancelled` (reopen) | `blocking_count += 1` for all hard-downstream of U |
| item created | `blocking_count = 0` (no edges yet) |

The propagation statement, for U becoming resolved:

```sql
UPDATE work_items
   SET blocking_count = blocking_count - 1,
       unblocked_at   = CASE WHEN blocking_count = 1 THEN ?now ELSE unblocked_at END,
       updated_at     = ?now
 WHERE blocking_count > 0
   AND id IN (SELECT to_work_item_id
                FROM dependencies
               WHERE from_work_item_id = ?U
                 AND type IN ('blocks','requires'));
```

One indexed statement, O(out-degree of U). Note this does **not** bump the downstream
items' `version` — their asserted state didn't change, so bumping version would spuriously
invalidate every agent's `expected_version` and cause phantom 409s. Readiness is not
part of the optimistic-concurrency contract.

**The fan-out / revision collision.** `work_events` has
`UNIQUE(project_id, project_revision)` (`db/schema.ts:199`) — one event per revision,
which is what makes the SSE cursor work. If completing `#3` unblocks five items, five
separate `work_item.unblocked` events need five distinct revisions.

Two ways out:

1. **One aggregate event (recommended).** Emit a single `work_item.unblocked` event
   whose `metadata` carries the unblocked item IDs. One revision, one notification
   ("3 tasks are now ready") instead of a notification storm. Better UX and simpler.
2. **Window-function revision allocation.** `SELECT ?base + ROW_NUMBER() OVER (ORDER BY
   id)` in an `INSERT...SELECT`, then set `projects.revision` to the max. Preserves
   one-event-per-item granularity. SQLite/D1 supports window functions.

Take option 1 unless per-item event granularity turns out to matter.

### 4.5 Cycle prevention becomes load-bearing

Under strategy B a cycle is a rendering annoyance. Under strategy C **a cycle is a
permanent, silent deadlock** — counters in a cycle never reach zero, so the items are
stuck in Blocked with no upstream you can point at. Cycle prevention stops being a
nicety and becomes a correctness invariant.

Replace the in-memory DFS with a bounded recursive CTE:

```sql
WITH RECURSIVE downstream(id, depth) AS (
  SELECT ?to, 0
  UNION
  SELECT d.to_work_item_id, downstream.depth + 1
    FROM dependencies d
    JOIN downstream ON d.from_work_item_id = downstream.id
   WHERE d.type IN ('blocks','requires')
     AND downstream.depth < 64
)
SELECT 1 FROM downstream WHERE id = ?from LIMIT 1;
```

A row means: `to` already reaches `from`, so adding `from → to` closes a cycle.
`UNION` (not `UNION ALL`) dedupes, so this terminates even on a pre-existing cycle.
Depth 64 bounds worst-case cost. This fixes both defects in §1.4 — type filtering and
unbounded materialization — in one change.

---

## 5. What the DAG lets you compute

One topological pass (memoized on `projects.revision`) yields everything below.

### 5.1 Layer — and why it doubles as the parallelism certificate

```
layer(X) = 0                              if X has no hard upstream
layer(X) = 1 + max(layer(U) for U → X)    otherwise
```

Layer is the longest path from any root. It gives you the left-to-right coordinate for
graph layout for free.

It also gives you something better. **If a path exists from A to B, then
`layer(A) < layer(B)` strictly.** Contrapositive: `layer(A) == layer(B)` ⟹ no path
either way ⟹ **A and B are provably safe to work in parallel.**

So layer equality is a *sound* parallelism certificate, computed as a side effect of
layout, with no reachability queries. It is incomplete — items in different layers may
also be parallel — but it is free and never wrong. Same-layer items are exactly the
"parallel batch" of work: hand layer *k* to five agents simultaneously with a guarantee
they cannot be sequentially dependent on each other.

For the complete answer on a specific pair, run the bounded CTE from §4.5 in both
directions.

### 5.2 Unlock count — the greedy scheduling signal

```
unlock_count(X) = |{ Y : X → Y is hard, and blocking_count(Y) == 1 }|
```

How many items become *immediately* ready the moment X completes. Directly answers the
plan's *"what unlocks if this finishes?"* (`PRODUCT_ARCHITECTURE_PLAN.md:943`) and is
the best single-number priority heuristic for a greedy scheduler.

### 5.3 Critical path — the schedule-determining spine

```
height(X) = 0                                  if X has no hard downstream
height(X) = cost(X) + max(height(Y) for X → Y) otherwise
```

`height(X)` is the longest remaining chain through X. The project's finish time is
`max(height(root))`, and the path achieving it is the critical path. Delaying anything
on it delays everything.

`cost(X)` needs an estimate field — there is none today. Start with uniform cost 1
(critical path = longest chain by item count), and add `estimate_minutes` later if it
proves useful. Uniform cost is a decent proxy and requires no schema change.

### 5.4 Blocker explanation

*"Why is #14 blocked?"* is a bounded upstream walk filtered to unresolved items — the
same CTE with the edge direction reversed. Ranking that set by `unlock_count`
identifies the one task that frees the most work. That is the answer both a human and
an agent actually want, and it is impossible to produce without the graph.

---

## 6. Hierarchy is a second, separate graph

`work_items.parent_id` exists and is unused. When it gets populated, keep it strictly
separate from the dependency DAG:

- **Dependencies** are a DAG expressing *order*: X cannot start until U finishes.
- **Parenthood** is a tree expressing *composition*: X is part of E.

Mixing them corrupts both. A parent is not blocked by its children in the ordering
sense — it *is* its children.

Rollup rules run as a separate derivation:

- parent is `done` when all children are `done`/`cancelled`
- parent's column is Blocked if every non-terminal child is blocked
- parent's column is In progress if any child is in progress
- `blocking_count(parent)` is its **own** upstream edges, never inherited from children

Rendering: collapse a parent to one node with a child-count badge, expand on demand.
This is also the main lever for keeping large graphs renderable.

---

## 7. New MCP surface

### 7.1 `link_work_items` — unblocks everything else

The missing primitive. `executeCommand`'s `add_dependency` handler already implements
it; this is a tool-registration and argument-mapping change in `worker/index.ts`,
roughly 15 lines.

```jsonc
{
  "name": "link_work_items",
  "description": "Declare an ordering or annotation relationship between two work items. Use 'blocks' when the target genuinely cannot start until the source is done.",
  "inputSchema": {
    "type": "object",
    "required": ["project_id", "from_work_item_id", "to_work_item_id", "idempotency_key"],
    "properties": {
      "project_id":         { "type": "string" },
      "from_work_item_id":  { "type": "string", "description": "The prerequisite." },
      "to_work_item_id":    { "type": "string", "description": "The dependent item." },
      "type": { "enum": ["blocks", "requires", "relates_to", "duplicates", "supersedes"], "default": "blocks" },
      "reason":             { "type": "string" },
      "idempotency_key":    { "type": "string" }
    }
  }
}
```

The `from`/`to` direction is a coin-flip that agents will get wrong roughly half the
time. Name the fields for their *role* (prerequisite vs dependent), not their position,
and say so in the description. Consider accepting `blocked_by` as an inverted alias.

### 7.2 `create_work_items` with in-batch dependencies

Agents plan in DAGs natively — *"first migrate the schema, then update the API, then
the client; docs can happen any time."* Forcing that into N+M round trips guarantees
half the edges never get written.

Let a single call carry the whole plan, with items referring to each other by a local
handle scoped to the request:

```jsonc
{
  "items": [
    { "ref": "schema", "title": "Add blocking_count column" },
    { "ref": "api",    "title": "Derive columns in the worker", "depends_on": ["schema"] },
    { "ref": "ui",     "title": "Render the graph view",        "depends_on": ["api"] },
    { "ref": "docs",   "title": "Document the derivation" }
  ]
}
```

Resolve `ref` → real ID server-side, write items and edges in one `db.batch()`, and
reject the whole batch if the implied edge set contains a cycle. `docs` having no
`depends_on` is how an agent expresses "this is parallel" — the absence of an edge, not
a flag.

This one change is what makes the graph get *populated* rather than merely *possible*.

### 7.3 `get_ready_work` — where the intelligence actually lands

Today an agent calls `list_work_items` (`worker/index.ts:157-161`), gets a flat array,
and guesses. Everything in this document exists to replace that guess with an answer.

```jsonc
{
  "name": "get_ready_work",
  "description": "Get work that is actually actionable right now: unblocked by dependencies, not claimed by another active session, ranked by how much it unlocks. Prefer this over list_work_items when deciding what to do next.",
  "inputSchema": {
    "type": "object",
    "required": ["project_id"],
    "properties": {
      "project_id":        { "type": "string" },
      "source_id":         { "type": "string", "description": "Excludes work that would collide with other active sessions." },
      "limit":             { "type": "number", "default": 5 },
      "avoid_collisions":  { "type": "boolean", "default": true }
    }
  }
}
```

Ranking:

1. exclude `blocking_count > 0` and `status = 'blocked'`
2. exclude items in any active source's `current_task_ids` — **this field already
   exists and is already maintained** by `heartbeat_agent_session`
   (`lib/store.ts:460-465`, `lib/contracts.ts:39`)
3. when `avoid_collisions`, deprioritize items sharing a `conflicts_with` edge or a
   file scope with another session's active work
4. rank by `unlock_count` desc, then `height` desc (critical path), then `priority`

Steps 2 and 3 are the multi-agent differentiator. Every todo app can do step 1. Only a
system that knows which sessions are live and what they hold — which Planbraid already
tracks — can do the rest. This is the tool that turns "shared task list" into
"coordinator."

### 7.4 `get_work_graph` and `explain_blocked`

`get_work_graph` returns a bounded neighborhood (default depth 2, node cap 200, per the
plan's `<150ms` budget at `PRODUCT_ARCHITECTURE_PLAN.md:1582`) with layers and
derived columns precomputed — serving both the UI renderer and agent reasoning from one
projection.

`explain_blocked` returns the unresolved upstream chain plus the highest-`unlock_count`
item in it: *"#14 is blocked by #9 and #11; finishing #9 unblocks 4 items."*

### 7.5 Also surface it as an MCP resource

`planbraid://projects/{id}/graph` alongside the existing `brief` and `active` resources
(`worker/index.ts:217-220`). Resources are cached by MCP clients with the existing
`ttlMs`/`cacheScope` mechanism, so agents can hold the topology without re-fetching.

---

## 8. Real-time propagation, end to end

Completing `#3`, which is a hard prerequisite for `#7`, `#8`, `#9`:

1. Agent calls `report_completion` on `#3` (`worker/index.ts:184-195`).
2. `executeCommand` runs its existing `transition_item` batch (`lib/store.ts:323-329`):
   project revision bump, item update, work event, notification, idempotency record.
3. **New, same batch:** the decrement statement from §4.4. `#7`, `#8`, `#9` drop to
   `blocking_count = 0`.
4. **New, same batch:** one aggregate `work_item.unblocked` event with
   `metadata.unblockedIds = ["#7","#8","#9"]`, plus one notification.
5. Batch commits atomically. Either everything moved or nothing did — no window where
   `#3` is done but `#7` still looks blocked.
6. SSE picks up the new revisions within 3s (`app/api/events/route.ts`) and the client
   refetches state.
7. `deriveColumn` re-runs in the browser. `#7`, `#8`, `#9` render in Ready. **Zero
   writes to those three rows' asserted state, zero version bumps, zero human action.**
8. The next agent to call `get_ready_work` sees three new candidates ranked by unlock
   count.

Steps 3–4 are the entire mechanism. Everything else is machinery that already exists.

Latency is bounded by the 3s SSE poll, comfortably inside the plan's `<250ms p50 /
<1s p99` realtime budget only if the poll interval drops — worth noting that the
current 3s tick is the binding constraint on perceived responsiveness, not the graph.

---

## 9. Rendering

**Layout.** Layered (Sugiyama-lite): x = layer from §5.1, y = packed within layer,
with a barycenter pass to reduce edge crossings. No layout library required — the layer
assignment falls out of the same topological pass that feeds the counters.

**Encoding.** Node fill = derived column (identical palette as the board, so the two
views are visibly the same data). Border = provenance (which agent created it). Bold
spine = critical path. Hard edges solid, soft dashed, annotation edges dotted, grey,
and excluded from layout.

**Bounding.** Neighborhood-only by default, depth ±2 from the selected node, cap ~200
nodes, collapse parents to badges. The plan says the same
(`PRODUCT_ARCHITECTURE_PLAN.md:938-944`) and it is right: a whole-project graph is
unreadable past about 40 nodes regardless of how good the layout is.

**Accessibility.** Keep a list/tree fallback. The graph is a lens on the board, never
the only way to reach an item.

The board and the graph then become two projections of one computation: the board
groups by `deriveColumn`, the graph positions by `layer`. They cannot disagree, because
there is only one derivation.

---

## 10. Correctness and operations

**Counter drift.** Materialized derivations drift — bugs, manual DB edits, partial
failures. Ship the repair query from §4.3 as a periodic job that recomputes
`blocking_count` from scratch and reports mismatches. Drift is not hypothetical; plan
for it from day one rather than discovering it as a mystery stuck task.

**Cycles.** Enforced on write (§4.5), and the repair job should also detect any cycle
that slipped in — a strongly-connected component of size > 1 among hard edges is a bug
report, not a user error.

**Fan-out bounds.** The propagation statement must fit inside one D1 batch. Realistic
out-degrees are small (< 20), but cap it: beyond N downstream, degrade to an
asynchronous pass and accept eventual consistency for that one item, with the
inconsistency visible rather than silent.

**Idempotency.** `link_work_items` needs an idempotency key like every other mutation
— `executeCommand` already enforces this (`lib/store.ts:190-192`). The
`UNIQUE(from, to, type)` constraint provides a second layer: a duplicate edge write
surfaces through `commitMutation`'s existing translation to `CONCURRENT_MODIFICATION`
(`lib/store.ts:168-178`), which is arguably the wrong code for this case — a duplicate
edge should be a no-op success, not a 409.

**Concurrent edge writes.** Two agents adding edges simultaneously can each pass the
cycle check independently and together create a cycle. The plan anticipates this and
prescribes lock ordering (`PRODUCT_ARCHITECTURE_PLAN.md:1665-1672`). On D1 the
practical mitigation is to include the project revision in the edge-write predicate so
one of the two writes loses and retries against the new graph.

---

## 11. Scaling — and the wall that isn't the graph

The graph work is cheap: O(out-degree) per write, O(1) per read, one memoized O(V+E)
pass per revision.

The actual scaling wall is `loadDashboard` (`lib/store.ts:132-156`). It fetches **all**
projects, coding spaces, sources, unarchived work items, 250 events, 100 notifications,
**all** dependencies, and **all** evidence for the organization — in one batch, on
every call. And `callTool` invokes it via `state()` for nearly every read tool
(`worker/index.ts:148`), as does `/api/state` on every SSE-triggered refetch.

At a few hundred items this is fine and pleasantly simple. At ten thousand it is fatal,
and adding edges makes it worse, not better. Before the graph work lands at any real
scale:

- scope queries to the selected project rather than the whole org
- serve the graph from the revision-keyed cache, never inline in the full-state payload
- paginate work items; the plan already targets 10,000-item boards with virtualization
  (`PRODUCT_ARCHITECTURE_PLAN.md:1591`)
- send revision deltas over SSE instead of triggering a full refetch

The graph is not what makes this system slow. But it is the feature that will make the
existing slowness matter.

---

## 12. Getting edges without asking for them

Agents will under-declare dependencies even with a good tool. Supplement with inference,
but **never auto-apply hard edges** — that contradicts the plan's "never auto-merge"
philosophy (`PRODUCT_ARCHITECTURE_PLAN.md:335`) and would silently deadlock work.

Write inferred edges with `type = 'inferred_blocks'` and a confidence score. They are
excluded from `DAG_EDGE_TYPES`, so they affect nothing until a human confirms them in
the Inbox — which already exists as a surface.

Ranked by precision:

1. **Item-key references in blocker text.** `block_work` already accepts free-text
   `reason` (`lib/store.ts:313`). Parsing `#12` out of *"blocked on #12"* is a regex
   over text that is already being written, and item keys are unambiguous within a
   project. Highest precision, near-zero cost, ship first.
2. **Batch ordering.** Items created together in one `create_work_items` call carry a
   weak sequential prior. Low precision — use it only to pre-fill the confirmation UI.
3. **Shared file scope.** The `evidence` table already supports a `file_change` type
   (`PRODUCT_ARCHITECTURE_PLAN.md:266`). Two in-flight items touching the same file are
   a `conflicts_with` candidate — mutual exclusion, not ordering, and exactly the
   collision signal `get_ready_work` needs for §7.3 step 3.
4. **Language cues** — "after", "once X lands", "depends on". Lowest precision; treat
   as a hint only.

---

## 13. Sequencing

| Phase | Work | Unlocks |
|---|---|---|
| **0** | `link_work_items` MCP tool; `depends_on` in `create_work_items`; type filter + recursive-CTE cycle check | Edges can exist at all. Everything below is blocked on this. |
| **1** | `deriveColumn` client-side (strategy A); board columns derived; blocker chain in task drawer | Auto-unblocking visible in the UI with no schema change. Validates the model. |
| **2** | `blocking_count` column, propagation in `commitMutation`, aggregate `work_item.unblocked` event, repair job | Server-side truth; agents see it; real-time propagation. |
| **3** | Revision-memoized topological pass: layer, height, unlock_count | Ranking and layout inputs. |
| **4** | `get_ready_work` with claim-awareness and collision avoidance | The actual differentiator. |
| **5** | Layered graph view, `get_work_graph`, `explain_blocked` | Visualization and agent reasoning. |
| **6** | Inferred edges into the Inbox | Graph populates without perfect agent discipline. |

Phase 0 is small — roughly a day — and strictly gates everything else. Phase 1 is where
the idea becomes visible without committing to a migration. Phase 4 is where the product
stops being a shared list and becomes a coordinator.

---

## 14. Findings summary

Defects and gaps identified in the current implementation while researching this:

1. **`add_dependency` is unreachable** from MCP and from the UI (`lib/store.ts:241`
   vs. the tool list at `worker/index.ts:66-84`). The `dependencies` table cannot be
   populated by any shipped interface. — *blocking, trivial to fix*
2. **Cycle detection ignores `type`** (`lib/store.ts:350`), so symmetric annotation
   edges (`relates_to`, `duplicates`) produce false cycle rejections. — *correctness*
3. **Cycle detection materializes all project edges** in worker memory per write
   (`lib/store.ts:350-352`), against the plan's own bounded-traversal requirement. —
   *scaling*
4. **Blocked items never auto-resolve.** `PRODUCT_ARCHITECTURE_PLAN.md:329` specifies
   auto-transition to `ready` on blocker resolution; nothing implements it. — *the core
   product gap*
5. **`block_work` cannot reference blocker items**, only free text
   (`worker/index.ts:74`), diverging from the plan's spec at `:465`.
6. **`plan_project_work` instructs agents to record "explicit dependencies"**
   (`worker/index.ts:243`) via a tool surface that cannot express them. — *prompt/tool
   mismatch*
7. **`work_items.parent_id` is declared and never written** (`db/schema.ts:159`) —
   hierarchy is unimplemented.
8. **`loadDashboard` fetches the entire org's state on every MCP read tool call**
   (`lib/store.ts:132-156`, `worker/index.ts:148`). — *the real scaling wall*
9. **Duplicate-edge writes surface as `CONCURRENT_MODIFICATION` 409s** via
   `commitMutation`'s error translation (`lib/store.ts:173`) rather than as an
   idempotent no-op.
