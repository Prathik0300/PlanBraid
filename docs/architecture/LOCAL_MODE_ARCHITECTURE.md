# Planbraid Local Mode

Keeping project and task data on the user's own machine, with an opt-in path back to
the cloud.

Companion to [`GRAPH_ARCHITECTURE.md`](./GRAPH_ARCHITECTURE.md) and
[`DEDUPLICATION_ARCHITECTURE.md`](./DEDUPLICATION_ARCHITECTURE.md). The sync engine
depends on the deduplication layer; see §7.

---

## 1. The structural problem: there is no "device" in the current architecture

The request assumes a filesystem at `~/.planbraid/`. Neither of Planbraid's two data
paths can reach one:

| Client | Where it runs | Filesystem access |
|---|---|---|
| Web UI | The user's browser, served from `planbraid.prathik0300.chatgpt.site` | None. IndexedDB/OPFS only, sandboxed per origin. |
| MCP server | A Cloudflare Worker at the edge | None. Workers have no filesystem at all. |

The agents are the only components actually running on the user's machine, and they
are *clients* — they call `https://planbraid…/mcp` over the network. The server they
call is not on the device.

So a storage toggle cannot work as described. If the web UI wrote to IndexedDB, MCP
agents could not see any of it, and the product's entire thesis — one task list shared
across every agent — breaks. The browser and the worker cannot share a store.

### 1.1 The reframe: this is a deployment mode, not a storage setting

"Data stays on my device" is only true if **the server is on the device**. Local mode
means shipping Planbraid as a local process:

```
~/.planbraid/planbraid.sqlite     ← the database
http://localhost:7777/mcp         ← the MCP endpoint agents connect to
http://localhost:7777/            ← the same web UI, served locally
```

Agents point their `.mcp.json` at localhost instead of the hosted URL. The cloud keeps
identity and nothing else. This is the only architecture where the privacy claim is
literally true rather than a promise about server behaviour.

It also reframes the toggle: switching to local mode requires *installing and running
something*, so the UI affordance is a guided setup flow, not a switch. §6 covers that.

---

## 2. Most of this already exists

The important practical finding: `npm run dev` is already a fully local Planbraid.

- `vite.config.ts:19-38` binds D1 to a local SQLite file under `.wrangler/state/v3/d1/`.
  The schema is identical to production because D1 *is* SQLite — `db/setup.ts` runs
  unchanged.
- `worker/index.ts:97-99` already grants a `local-demo-user` principal to unauthenticated
  requests on `localhost`, with full `work:read`/`work:write` scopes.

That combination is a working local MCP server with on-disk storage and no cloud
dependency. It is what I used to verify the deduplication work in this session — real
D1, real `/mcp`, no network.

Three things separate it from a shippable local mode:

1. **The web UI still requires cloud auth.** `principalFromRequest`
   (`lib/app-principal.ts:37-48`) demands a better-auth session with no localhost
   exception, so `/api/state` and `/api/commands` return 401 locally even though `/mcp`
   works. This asymmetry needs closing.
2. **The database lives in `.wrangler/state/`**, a build artifact directory, not a
   durable user-owned location.
3. **There is no distributable.** It runs from a checkout, not `npx planbraid`.

None of these is architecturally hard. The work is packaging and sync, not a rewrite.

---

## 3. Three tiers of privacy, and which to build

Local mode is the strongest answer but not the only one, and it is the most expensive.

| | What it protects | Cost to build | Cost to support |
|---|---|---|---|
| **Self-hosting** | Data lives in the user's own Cloudflare account | Low — a `wrangler.jsonc` and docs | Low |
| **Local mode** | Data never leaves the machine | High — packaging, sync, conflict resolution | Medium |
| **End-to-end encryption** | Server holds only ciphertext | High | High |

**End-to-end encryption should be rejected outright**, and it is worth saying why since
it is the reflexive answer to this requirement. Planbraid's server does real work on
task content: duplicate matching against titles and artifacts, search, project brief
generation, dependency reasoning. All of it needs plaintext. Encrypting client-side
would disable every server-side feature and leave an MCP API that can only store and
return opaque blobs. The features and the encryption are mutually exclusive.

**Self-hosting is the best value per unit of effort.** The app is already a Cloudflare
Worker with a D1 binding; the only reason it cannot be self-hosted today is the missing
`wrangler.jsonc` and the `.openai/hosting.json` coupling in `vite.config.ts`. For most
users who say "I don't want my roadmap on someone else's server," their own Cloudflare
account satisfies the concern completely.

**Both share the same prerequisite**: making the app runnable outside the OpenAI Sites
platform. Do that once and self-hosting falls out immediately, with local mode as the
follow-on. That sequencing means the cheap win ships first and is not wasted work.

---

## 4. What is actually sensitive

Worth being precise, because it bounds the design. The live sign-in page already
promises *"stores project and task state - not your chat transcripts,"* so transcripts
are out of scope. What remains in the database is genuinely revealing:

- `projects.name`, `projects.description` — what is being built
- `projects.directory` — local filesystem paths, often including the user's name
- `projects.git_remote` — the repository, often private
- `work_items.title`, `work_items.description` — the roadmap, unreleased features, security work
- `evidence.uri`, `evidence.label` — file paths, PR links, commit hashes
- `work_events.summary` — a chronological narrative of the project's development

Task titles alone leak a roadmap. `directory` and evidence paths leak architecture. The
concern is legitimate.

Two things are *not* protected by local mode and must be said plainly: the user's
account identity stays in the cloud by design, and if the cloud needs to enforce
anything about local projects (§9.4) it must know those project IDs exist.

---

## 5. Backend architecture

### 5.1 Packaging the local server

Two options, differing mainly in weight:

**a. Ship the existing Worker under Miniflare/workerd** (`npx planbraid`). Zero porting:
the same bundle, the same D1 SQLite, the same `ensureSchema`. Wrangler is already a
devDependency, so the runtime is proven. Cost is a large install — workerd is a native
binary in the tens of megabytes.

**b. Port to plain Node with a D1 shim.** Lighter and startup is faster, but the vinext
React app is built for the Workers runtime, so the UI needs a Node server adapter.

The shim itself is trivial, which is the point worth noting: `lib/store.ts` touches only
`prepare().bind().first()/all()/run()` and `batch()`. Against Node 24's built-in
`node:sqlite` that is roughly 80 lines:

```ts
class LocalD1 {
  #db = new DatabaseSync(path);
  prepare(sql: string) { return new LocalStatement(this.#db, sql); }
  async batch(statements: LocalStatement[]) {
    // db.batch() is atomic in D1 and the whole domain layer depends on that —
    // transition_item writes the item, the event, and the notification as one unit.
    this.#db.exec("BEGIN IMMEDIATE");
    try { const out = statements.map((s) => s.runSync()); this.#db.exec("COMMIT"); return out; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
}
```

The narrow storage interface is what makes local mode cheap. Preserve it — anything that
reaches for a D1-specific feature raises the cost of this later.

**Recommendation: (a) for v1.** Weight is a one-time download; correctness is permanent.
Revisit (b) if install size becomes a real complaint.

### 5.2 Storage location and format

```
~/.planbraid/
  planbraid.sqlite          primary durable storage
  planbraid.sqlite-wal
  config.json               port, identity token, sync state
  exports/                  timestamped bundles from manual export
  logs/
```

Two corrections to the sketch in the request:

- **Not `tmp/`.** This is primary durable storage, the only copy of the user's data. A
  path named `tmp` invites cleanup tools, and some are aggressive about it.
- **SQLite, not JSON files.** The domain layer depends on transactional `batch()`
  semantics. JSON files cannot give atomicity across the item, event, and notification
  writes that every status transition performs, and a crash mid-write would corrupt
  state in a way that is hard to detect.

Permissions: `0700` on the directory, `0600` on the database. The database is protected
by OS file permissions, not by an application password.

### 5.3 Authentication in local mode

The correct default is **no authentication for localhost**, extending the existing MCP
bypass to the UI path. The data is protected by filesystem permissions; adding a login
to a single-user local process is security theatre that mostly generates lockouts.

Bind to `127.0.0.1` explicitly, never `0.0.0.0`. On a shared or corporate machine that
distinction is the entire security boundary.

Identity is still needed for later sync attribution, so local mode supports an *optional*
sign-in that caches a token in `config.json`. Everything works fully offline without it;
only sync requires it.

### 5.4 Nothing in the data path calls out to the internet

Worth stating because it is a real constraint on this design and it is already
satisfied. Duplicate matching runs entirely in-process on structural signals — action,
object, and concrete artifacts — with no model, no API key, and no outbound request
(`lib/dedup/`). An earlier version had a semantic tier that posted task titles to an
external embedding API; in local mode that would have shipped exactly the content the
user chose local mode to protect. It was removed for unrelated cost reasons
(`DEDUPLICATION_ARCHITECTURE.md:§6.1`), and the privacy problem went with it.

The rule to preserve: **local mode must have no egress in the write path.** Any future
feature that wants a remote model has to be opt-in, off by default, and must name the
destination host before it sends anything.

## 6. Frontend

### 6.1 Why it cannot be a toggle switch

Two hard constraints:

1. **Switching to local mode requires installing software.** A switch that silently does
   nothing until the user runs a command is a broken affordance.
2. **The hosted UI cannot reliably talk to `http://localhost`.** An HTTPS page fetching
   plain HTTP loopback is blocked or gated as mixed content / private-network access, and
   the rules differ per browser and keep changing. Do not build on it.

The second constraint resolves cleanly: **the local server serves its own UI.** The user
opens `http://localhost:7777` and gets the same interface, same origin as its own API. No
mixed content, no CORS, no cross-origin auth. The two deployments never talk to each
other directly in the browser at all.

### 6.2 What the hosted UI actually shows

In Settings, a **Data location** section rather than a switch:

- Current state: *"Cloud — stored in your Planbraid workspace"* or *"Local — this account
  is in local mode"*
- **Switch to local mode** opens a guided flow: install command, a copy-able MCP config
  block pointing at localhost, a connection check, then the migration choice from §9.1.
- While in local mode the hosted UI shows a persistent banner with a link to
  `http://localhost:7777` and no task data, because it genuinely has none. The empty state
  must say *why* — an unexplained empty board reads as data loss and will generate support
  requests.

The existing `SetupDialog` already generates MCP config snippets and manages tokens, so
it is the natural host for the localhost variant.

### 6.3 What the local UI shows

The same app, plus:

- A **Local** badge in the header, so a user with both open never confuses them.
- **Storage path and size**, with a reveal-in-finder action.
- **Backup warning**, stated plainly and not buried: this machine holds the only copy.
- **Export now** → a timestamped bundle in `exports/`.
- **Sync to cloud** → §7.

---

## 7. The sync engine

### 7.1 Not a file upload

The request describes uploading the local file. That has one real advantage — atomicity —
and several problems: the Worker would need to parse a SQLite binary (no parser available
in that runtime), a whole-database upload cannot be resumed, and it bypasses every
validation and idempotency guarantee in the command layer.

**Sync as a structured bundle over the existing API instead.** The local server reads its
own database and posts records through the same command handlers the UI and MCP already
use. That inherits idempotency, validation, event emission, and — critically — the
deduplication layer.

### 7.2 Deduplication is the merge-conflict resolver

This is where the previous work pays off. The naive merge problem is: local has *"Add rate
limiting to /api/login"*, cloud has the same task from before the user went local, and a
plain upload produces two cards.

But `content_fingerprint` is already computed and stored on every item, and
`createWorkItemsDeduplicated` already resolves proposals against existing work. Sync
routes items through it and gets exact-restatement collapsing, artifact-veto protection,
and alias provenance for free. Overlapping work merges; genuinely distinct work does not.

The asymmetric-cost rule from the dedup design applies with more force here: on a merge, a
false split leaves a duplicate card, while a false merge destroys work that only ever
existed on one side. Sync should use the strictest thresholds available — fingerprint and
artifact matches only, with everything else surfaced for review rather than merged.

### 7.3 Order and idempotency

Upload order is forced by foreign keys: projects → coding spaces → sources → work items →
dependencies → evidence → events → interactions.

Sync must be resumable. A `sync_sessions` table on both sides tracks
`(session_id, table, last_local_id, status)`, every record carries an idempotency key of
`sha256(session_id + local_row_id)`, and a resumed sync replays from the last committed
cursor. Chunk at a few hundred rows per request to stay inside D1 batch limits; if bundles
grow large enough to need staging, the R2 binding is already declared in
`.openai/hosting.json` (currently `null`) and can be enabled.

Sync is **one-directional by design**: local → cloud. Bidirectional sync means a real
CRDT or operational-transform layer, which the plan explicitly defers
(`PRODUCT_ARCHITECTURE_PLAN.md:108`, "microservices, Kafka, Elasticsearch, or CRDTs before
scale requires them"). Cloud → local restore is a separate, simpler operation: a fresh
local database seeded from a cloud export, only ever into an empty local store.

---

## 8. Database changes

**Local:** none. The schema is identical — `db/setup.ts` runs unchanged against a local
SQLite file. That identity is worth protecting; it is what keeps the two deployments from
drifting.

**Cloud**, three additions:

```sql
-- Which projects are local-only, so the cloud can refuse writes that would silently split
-- a user's data across two stores. Stores IDs and mode only, never task content.
ALTER TABLE projects ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE projects ADD COLUMN local_since TEXT;

CREATE TABLE IF NOT EXISTS sync_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'local_to_cloud',
  status TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress | completed | failed | abandoned
  cursor TEXT NOT NULL DEFAULT '{}',           -- per-table resume position
  counts TEXT NOT NULL DEFAULT '{}',           -- uploaded / merged / conflicted
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

-- Maps a local row id to the cloud row it became, so re-sync is idempotent and
-- renumbered references (§9.2) can be rewritten correctly.
CREATE TABLE IF NOT EXISTS sync_id_map (
  session_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  local_id TEXT NOT NULL,
  cloud_id TEXT NOT NULL,
  resolution TEXT NOT NULL,   -- created | merged | skipped
  PRIMARY KEY (session_id, entity, local_id)
);
```

`sync_id_map` also lives locally, so the local server knows what it has already uploaded
and a second sync is a no-op rather than a duplicate.

---

## 9. Edge cases

### 9.1 Existing cloud data at the moment of switching

The worst option is silence. If the board empties with no explanation, it reads as data
loss regardless of what the settings page says.

Force an explicit choice, with the destructive option not preselected:

1. **Move down and delete from cloud** — what a privacy-motivated user actually wants.
   Order matters: download, write locally, **verify row counts match**, and only then
   delete. Never delete first. Keep an export in `exports/` regardless.
2. **Copy down, leave cloud copy** — safe, but says clearly that the data is still hosted.
3. **Start empty locally** — cloud data untouched and reachable by switching back.

### 9.2 Sequence and item-key collisions

`work_items` carries `UNIQUE(project_id, sequence)` and `UNIQUE(project_id, item_key)`.
Local creates `#1..#5` while cloud independently holds `#1..#3`. On sync they collide.

Primary keys are safe — `id()` uses `crypto.randomUUID()`. Only the human-facing counters
collide. Local items must renumber to continue after the cloud maximum.

Renumbering breaks references, because item keys appear in prose: `work_events.summary`,
`notifications.title`/`body`, blocker reasons, task descriptions, and the agent's own
memory of the conversation. There is direct precedent for the fix in this codebase —
`removeGeneratedProjectShorthands` (`lib/store.ts:104-114`) already does a bulk `replace()`
of item keys across event summaries and notification bodies. Sync needs the same treatment,
driven by `sync_id_map`.

Agents holding stale keys are unavoidable and acceptable: IDs remain stable, and
`get_work_item` takes an ID rather than a key.

### 9.3 Project revision and the SSE cursor

`work_events` has `UNIQUE(project_id, project_revision)` and `projects.revision` is the
SSE cursor (`app/api/events/route.ts`). Both stores number from 1, so every synced event
collides.

Append local events onto the end of the cloud sequence rather than interleaving.
Interleaving by wall-clock would renumber existing cloud events and invalidate every live
client cursor. Appending keeps `revision` as a pure sync cursor while preserving the
original `created_at` for display — which is already how the UI orders
(`lib/store.ts:139`, `ORDER BY created_at DESC, project_revision DESC`).

Connected clients see a revision jump and refetch, which the existing reconnect path
already handles.

### 9.4 An agent pointed at the wrong endpoint

The most likely real-world failure. The user switches to local, but Claude Code's
`.mcp.json` still points at the hosted URL. The agent writes to the cloud, the local UI
never shows it, and the user's work is silently split across two stores.

The cloud must refuse. With `projects.storage_mode = 'local'`, any write to that project
returns a structured error naming the cause and the fix:

```json
{ "error": { "code": "PROJECT_IS_LOCAL",
             "message": "This project moved to local mode. Point this client at http://localhost:7777/mcp.",
             "details": { "localEndpoint": "http://localhost:7777/mcp" } } }
```

Agents surface tool errors to the user, so this becomes a visible prompt to fix the config
instead of silent divergence. This is the reason the cloud must retain project IDs and
mode — disclose it rather than claiming nothing is stored.

### 9.5 Two devices, both local

Laptop and desktop each run local mode and diverge. There is no local↔local sync, and
building one means a CRDT.

State it as an explicit non-goal. Both can sync up to the same cloud project, where the
dedup layer merges the overlap — that is the supported path. A user who wants two machines
sharing live state wants cloud mode, and the UI should say so at the point of switching.

### 9.6 The local server is not running

Agents get connection-refused, which is a clear failure rather than a silent one. The
hosted UI cannot detect it either way, so its banner should be phrased conditionally
("open your local workspace") rather than asserting a state it cannot observe.

Worth adding: a launch agent / systemd unit so the server starts with the machine, and a
lockfile so two instances cannot open the same SQLite file. Two writers on one database is
the failure mode most likely to produce actual corruption.

### 9.7 Interrupted sync

Covered by §7.3 — session cursor, per-row idempotency keys, resume from last committed
chunk. Two additional rules: a sync session older than 24 hours is marked `abandoned` and
restarts cleanly rather than resuming into a changed dataset, and the local database is
never mutated (renumbering is applied cloud-side and recorded in `sync_id_map`) so a failed
sync leaves the local copy untouched and retryable.

### 9.8 Clock skew

Local `created_at` values come from the user's machine and can be arbitrarily wrong. Since
ordering after sync is by `created_at`, a skewed clock scrambles the timeline.

Preserve the local timestamp as authored, but also record `synced_at` from the server
clock, and detect implausible values on ingest (future-dated, or before the project was
created) and flag rather than silently rewrite them.

### 9.9 Web Push

Push requires a push service (FCM, Mozilla) that the local server can reach — outbound
network from the machine, which local mode does not forbid. The payload is encrypted per
the Web Push spec with the subscriber's keys, so the push service cannot read task content,
and `lib/push.ts` already implements this correctly.

Two real limitations: the service worker registration is per-origin, so a localhost UI needs
its own subscription and the hosted one does not carry over; and notifications only arrive
while the local server is running. For a machine-local tool, in-app plus OS notifications
may serve better than Web Push.

### 9.10 Deleting cloud data means deleting it

If a user chooses "move down and delete from cloud," rows must actually be removed, not
soft-deleted with `archived_at`. A privacy feature that leaves the data in the table with a
flag set is a false claim. `removeLegacyDemoData` (`lib/store.ts:81-102`) is a working
template for the deletion order across every dependent table.

Backups are the honest caveat: D1 point-in-time recovery may retain deleted rows for a
retention window. Say so rather than implying instant erasure.

### 9.11 Version skew

The local server is installed software and will fall behind. A local build older than the
cloud schema can produce a bundle the cloud cannot ingest.

Version the sync bundle format, have the cloud reject unknown versions with an upgrade
message, and keep the local server's `ensureSchema` authoritative for its own file. This is
also why the shared `SCHEMA_STATEMENTS` list should stay the single source of truth for both
deployments.

### 9.12 Support becomes harder

Once data is local, you cannot inspect it to diagnose problems. Local mode needs a
`planbraid doctor` producing a redactable diagnostic bundle — schema version, row counts,
integrity check, recent errors — with no task content.

---

## 10. Sequencing

| Phase | Work | Notes |
|---|---|---|
| **0** | `wrangler.jsonc`; decouple `vite.config.ts` from `.openai/hosting.json`; deploy docs | Delivers self-hosting on its own, and is the prerequisite for everything below |
| **1** | Local principal for the UI path (`lib/app-principal.ts`); DB path to `~/.planbraid/`; `127.0.0.1` bind; lockfile | Turns the existing dev server into a real local workspace |
| **2** | `npx planbraid` distributable; Local badge; storage path and backup warning; export | Shippable local mode, no sync |
| **3** | `projects.storage_mode`; `PROJECT_IS_LOCAL` write rejection; guided switch flow with the §9.1 choice | Prevents the silent-split failure — do not ship phase 2 to non-technical users without this |
| **4** | Sync engine: sessions, chunking, id map, renumbering, dedup-based merge | The hardest piece; §9.2 and §9.3 are the substance |
| **5** | `planbraid doctor`; launch agent; local embedding provider docs | Operational maturity |

Phase 0 is worth doing regardless of whether local mode ever ships — it removes a
single-platform dependency and answers most privacy requests on its own.

Phases 1–2 are small because the groundwork is already in place. Phase 3 is what makes it
safe. Phase 4 is where the genuine complexity lives, and it is worth confirming that users
actually want their local data merged upward before building it — many who choose local
mode never want the data in the cloud at all, which would make phase 4 unnecessary.

---

## 11. Recommendation

Build phase 0 now: it is small, it delivers self-hosting immediately, and it removes the
`.openai/hosting.json` coupling that currently blocks every alternative deployment.

Treat local mode as a real product decision rather than a settings toggle. It splits the
product into two deployments that must be versioned, supported, and kept schema-compatible
forever, and it forecloses multi-user collaboration for anyone using it. That is a
reasonable trade for a developer tool whose users are already comfortable running local
processes — but it should be chosen deliberately, not arrived at by adding a switch.

If the goal is specifically to answer "I don't want my roadmap on someone else's server,"
self-hosting answers it at a fraction of the cost, and phase 0 is the whole of it.
