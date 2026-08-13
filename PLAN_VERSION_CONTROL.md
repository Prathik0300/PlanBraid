# Plan Version Control

**Build status.** §3's op log — `plan_ops`, `plan_refs`, the content-addressed hash
(`hash = sha256(type ‖ canonicalPayload ‖ sortedParents)`), and advisory-locked atomic head
updates — is shipped (`lib/ops/hash.ts`, `lib/ops/log.ts`), wired into every genuine
mutation in `lib/store.ts`. `plan_conflicts` exists as schema only; population is gated on
the reconciliation engine's `CONFLICTS` relation type (E4) and is M19's job. §4's session
branches and merge, and §5's in-repo projection, are not built — deliberately deferred
past this milestone, exactly as this document specifies. See
`PLANNING_INTELLIGENCE_ROADMAP.md`'s M25 entry for what shipping this surfaced, including
one real cross-project hash-collision bug the first test run caught.

*Why can't Planbraid have a git-like algorithm for its action items, and make source
control the source of truth for conflicts, redundancy, and status?*

It can, and it should — but not by copying git. Git is the wrong model for this, and a
better one already exists in the version-control literature. This document separates two
claims that the question bundles together, because they have different answers and
different costs.

**Claim A — Planbraid's own store should behave like a version control system.**
Correct, high value, and the codebase is already two thirds of the way there without
anyone having framed it that way.

**Claim B — the repository should be the source of truth for the plan.**
Correct for *implementation state*, dangerous for *coordination state*. The resolution is
a projection, not a migration.

---

## 1. Why not git's model

Git stores **snapshots** and reconstructs changes by diffing. Merging is a heuristic —
three-way merge / diff3 — and it has three properties that are fine for source files and
wrong for a plan:

1. **Conflicts are a failure state.** A merge either succeeds or stops with markers in a
   file. There is no representation of "this plan is legitimately in a contested state,
   and that is the truth right now."
2. **Conflicts recur.** Resolve the same collision on two branches and you resolve it
   twice; `git rerere` exists specifically to paper over this. For planning that means
   *the same rejected approach comes back*, which is precisely the failure the roadmap's
   feature 25 describes: Claude proposes MongoDB again after the team chose Postgres.
3. **Merge is order-dependent and heuristic.** [There are real cases where three-way merge
   does the wrong thing](https://pijul.org/manual/why_pijul.html); it is a guess that
   usually works on line-oriented text.

[Pijul](https://pijul.org/) — building on Darcs' patch theory — stores **changes**, not
snapshots, and gets three properties that are exactly what a planning graph needs:

- **Changes merge by formal axioms, not heuristics.** Merge is a pushout in a category
  where states are objects and patches are arrows; every pair of diverging changes has a
  well-defined merge.
- **Conflicts are first-class objects, not failures.** The state space is *extended* to
  include conflicted states. A conflict is a legitimate value the plan can hold.
- **A resolution is itself a change, recorded against the pair of changes it resolves — so
  it travels, and the same conflict never comes back.**

That third property is the whole feature. Feature 8 says a planning conflict "should
remain explicit until resolved rather than allowing one agent's suggestion to silently
replace another." Feature 25 says a later MongoDB proposal must hit the existing decision.
Both are restatements of *conflicts as objects with durable resolutions* — which is patch
theory, arrived at independently.

---

## 2. What already exists

The current store is closer to an operation log than it looks:

| Present | Missing for a VCS |
|---|---|
| Every mutation goes through one `executeCommand` funnel | Operations are not addressable or replayable |
| `work_events` is append-only, with actor, source, from/to status | Events describe changes; they do not *constitute* them |
| `projects.revision` is a monotonic counter with `UNIQUE(project_id, project_revision)` | A single linear history — no branches, no partial order |
| `idempotency_records` deduplicates retries | Keyed by caller-supplied strings, not by content |
| `work_item_aliases` preserves every collapsed restatement, reversibly | No notion of two histories to reconcile |
| Optimistic concurrency via `version` + `expectedVersion` | Rejects divergence instead of merging it |

The last row is the crux. Today, two agents editing the same item concurrently produce a
`VERSION_CONFLICT` 409 and one of them loses. That is the right behaviour for a shared
mutable record and the wrong behaviour for a plan: both agents had a real intent, and the
system should hold both until something reconciles them.

---

## 3. Design: an operation log with content addressing

Additive. The existing tables stay and become a **materialized view** of the log — the
same strategy `blocking_count` used: derive the useful property, don't rewrite the store.

```sql
CREATE TABLE IF NOT EXISTS plan_ops (
  hash        TEXT PRIMARY KEY,     -- sha256(type ‖ canonical(payload) ‖ sorted parents)
  project_id  TEXT NOT NULL,
  type        TEXT NOT NULL,        -- propose | accept | link | transition | resolve | …
  payload     JSONB NOT NULL,
  parents     TEXT[] NOT NULL,      -- ops this one depends on; the partial order
  author_kind TEXT NOT NULL,        -- human | agent
  author_name TEXT NOT NULL,
  source_id   TEXT,
  branch      TEXT NOT NULL DEFAULT 'canonical',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS plan_refs (
  project_id TEXT NOT NULL, name TEXT NOT NULL,    -- 'canonical', 'session:src_…', 'branch:feature/auth'
  head TEXT[] NOT NULL,                            -- frontier: possibly several heads
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, name));

CREATE TABLE IF NOT EXISTS plan_conflicts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  kind TEXT NOT NULL,                              -- approach | scope | status | ordering
  op_a TEXT NOT NULL, op_b TEXT NOT NULL,          -- the two changes in tension
  subject_work_item_id TEXT, decision_work_item_id TEXT,
  state TEXT NOT NULL DEFAULT 'open',              -- open | resolved | superseded
  resolved_by_op TEXT, resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ,
  UNIQUE (project_id, op_a, op_b));
```

Four properties fall out, each of which the product currently pays for some other way:

**Content addressing replaces idempotency keys.** The hash *is* the identity. The same
operation submitted twice — by a retried hook, an at-least-once bridge delivery, or two
agents that genuinely agree — is one row, with no caller-supplied key to get wrong.
`idempotency_records` becomes a compatibility shim rather than the mechanism.

**`parents[]` gives a partial order instead of a global counter.** Two agents working
simultaneously produce two heads, not a 409. `projects.revision` stays as the
UI's real-time cursor; it stops being the concurrency mechanism.

**A merkle DAG makes sync trivial.** Two Planbraid instances, or an offline bridge and the
server, reconcile by exchanging missing hashes. That is the entire sync protocol, and it
is what makes §5's in-repo file safe.

**Conflicts become durable objects.** `plan_conflicts` holds the contested state; a
resolution is an op recorded against the *pair*. A third agent proposing the losing
approach later matches the resolved pair and is told the decision and its reason, instead
of quietly reopening it. Conflicts never come back — the Pijul property, in the domain
where it matters most.

### 3.1 Which operations commute

Patch theory's guarantees depend on knowing when two changes are independent. For a
planning graph this is unusually tractable, because most operations are on disjoint
subjects:

| Pair | Commutes? | Merge rule |
|---|---|---|
| `propose(A)` ‖ `propose(B)`, different subjects | Yes | Both apply |
| `propose(A)` ‖ `propose(A')`, same work | **Reconciliation decides** | §4 |
| `link(a→b)` ‖ `link(c→d)`, disjoint | Yes | Both apply |
| `link(a→b)` ‖ `link(b→a)` | No | Ordering conflict — would cycle |
| `transition(x, in_progress)` ‖ `transition(x, in_progress)` by two sources | No | Lease conflict; earliest lease wins, loser is told |
| `transition(x, done)` ‖ `transition(x, cancelled)` | No | Status conflict → decision |
| `accept(x)` ‖ `reject(x)` | No | Approach conflict → decision |
| `note`, `evidence`, `alias` | Yes, always | Append-only, order-irrelevant |

The append-only majority is the good news: notes, evidence, aliases and proposals are the
bulk of all traffic and they all commute unconditionally. The non-commuting minority is
small, enumerable, and maps one-to-one onto conflict kinds that a person can actually
adjudicate.

---

## 4. Reconciliation is the merge function

This is the unification worth building toward.

Merging two plan branches means: find the merge base (the greatest common ancestor set in
the op DAG), take the ops on each side, and decide for every cross pair whether they are
the same intent, compatible intents, or contradictory intents.

That is exactly `relate(A, B)` from `RECONCILIATION_ARCHITECTURE.md §10`:

```
merge(branch_x, branch_y):
  base   = common_ancestors(head(x), head(y))
  ops_x  = reachable(head(x)) \ base
  ops_y  = reachable(head(y)) \ base

  for each cross-pair (a, b):
      match relate(a, b):
        DUPLICATE            → collapse; record alias; keep both provenances
        SUBSET | SUPERSET    → apply both; record subtask_of
        OVERLAP              → apply both; record overlaps
        CONFLICT             → apply neither; open plan_conflict; raise decision item
        SEQUENCE             → apply both; record blocks
        NEW                  → apply
  commute-check the remainder; apply in any topological order
```

**The consequence is that plan merging costs almost nothing to build once the
reconciliation engine exists**, and it means the matcher's quality directly determines the
quality of merges. One module, one weight file, one evaluation harness — and a second
consumer that stress-tests it far harder than `create_work_items` does.

### 4.1 Session branches — what this buys a user

A connected agent gets `branch = session:<source_id>`. Its proposals land on its own
branch and merge into `canonical` at `sync_interaction`, or on explicit acceptance.

- An agent can plan speculatively without polluting the shared board. This is the
  roadmap's feature 10 obtained structurally rather than by a status column — and the two
  compose: `maturity` says how mature an item is, the branch says whose plan it is in.
- An agent returning after three days has a **stale base**. Rebasing its branch onto the
  current canonical head is a real, nameable operation, and its output is precisely the
  agent handoff package (feature 15) and pre-planning context (feature 3): *here is what
  changed under you, here is what your plan now duplicates, here is what got decided.*
- Two agents working in parallel produce two branches that merge with conflicts made
  explicit, instead of two boards' worth of silent duplicates.

Feature 4 — plan revision lineage — stops needing its own `plan_revisions` table. A
revision is a named range of ops on a branch. `changed_by`, `changed_at`, `reason`,
`supersedes`, `tasks_added/removed/modified` are all queries over the log.

---

## 5. Claim B: the repository as source of truth

Two different questions hide here, and they get opposite answers.

### 5.1 Source of truth for *implementation state* — yes, unreservedly

An agent's claim that it finished is not evidence. A commit that exists, touches the
files the task named, and passes the test command **is** evidence. Everything the roadmap
wants under features 6, 7 and 20 follows from treating git as authoritative for anything
verifiable:

| Question | Authority |
|---|---|
| Was this implemented? | Commits touching the item's artifacts |
| Is it still implemented? | The current tree — a later commit deleting the code un-satisfies the task |
| Did it pass? | The recorded exit status of the verification command; CI, when connected |
| Was it shipped? | Merge state of the branch it landed on |
| Are two tasks the same work? | **Partly git** — the same files changed twice for the same reason is the strongest redundancy signal there is |

That last row is the answer to *"source control as the source of truth for redundancy."*
Two items whose implementations touch the same functions are duplicates in the way that
matters, regardless of how differently they were worded — and it is a signal no
text-similarity method can access. It is feature f11 of the reconciliation engine, and it
is the one signal that is genuinely unavailable to every competitor that does not sit on
the developer's machine.

### 5.2 Source of truth for *coordination state* — no

Leases, live sessions, notifications, "who is working on this right now", and cross-agent
collision detection are inherently real-time and multi-writer. Git is a poor multi-writer
database for a single checkout: every write is a commit, there is no notion of a lease,
and two agents in one working tree serialize badly. Making git authoritative here would
trade the product's coordination value for file-format purity.

More importantly: **two sources of truth is the failure mode**, and it is worth being
blunt about that, because "put the plan in the repo" is an attractive idea that fails
exactly this way.

### 5.3 The resolution: a projection, and a transport

Export the op log to `.planbraid/plan.jsonl` — one op per line, sorted by hash, append-only.

The format is chosen so that **git's line-based merge is always correct by construction**:
ops are content-addressed and commutative-by-default, so a concurrent append on two
branches produces a union, which is exactly right. There is no scenario where the file
develops a conflict marker; the only merge git can perform on a sorted, append-only,
content-addressed line set is the correct one. Any *semantic* conflict is represented
inside the ops as a `plan_conflict`, where it belongs, rather than as a textual collision.

What that gives:

- **The plan branches with the code.** A feature branch's plan differs from `main`'s, and
  merging the PR merges the plan. This is the honest version of "source control is the
  source of truth for status."
- **Plan changes are reviewable in a pull request.** A diff showing three tasks proposed
  and one decision recorded is a genuinely useful review artifact.
- **Offline works.** The bridge queues ops locally and syncs on reconnect; content
  addressing makes replay idempotent.
- **No lock-in.** The user's plan is a readable file in their repository. That is a strong
  adoption argument and costs nothing to honour.
- **Branch-scoped views.** The board shows the plan for the branch you are on.

And the boundary that keeps it from becoming a second source of truth: **the file carries
ops; the server carries leases, presence, notifications and derived state.** The file is
durable history; the server is live coordination. Neither can drift from the other,
because the file *is* the log the server materializes from.

---

## 6. What this replaces, and what it does not

| Roadmap feature | How the op log delivers it |
|---|---|
| 4 · Plan revision lineage | A revision is a named op range. No separate table |
| 5 · Why-history | `reason` on the op that caused the state, addressable forever |
| 8 · Planning conflict detection | `plan_conflicts` as first-class state |
| 9 · Human decision required | An open conflict *is* the queue |
| 11 · Provenance | `author_kind`, `author_name`, `source_id` on every op, immutable |
| 14 · Cross-model session identity | Session branches complete the Human→Agent→Session→**Plan**→Action chain |
| 25 · Planning authority | A resolution recorded against a pair means the rejected approach stays rejected |

Not delivered by this, and still needed separately: the reconciliation engine itself
(§4 consumes it), leases (real-time, server-side), evidence ingestion, and the maturity
ladder — which stays a property of an item, not of the log.

---

## 7. Risks, and the honest cost

**This is the largest architectural change in the roadmap.** Three specific dangers:

| Risk | Mitigation |
|---|---|
| Rewriting the store to be log-first breaks a working, tested system | **Do not.** Write ops *alongside* existing mutations; keep current tables as the materialized view; adopt readers incrementally. The system must work identically with the log ignored |
| Merge semantics are subtle, and a bad merge loses work | The commute table (§3.1) is small and enumerable. Anything not on it does not auto-merge — it raises a conflict. Bias to conflicts exactly as the matcher biases to splits |
| Session branches confuse users ("where did my task go?") | Ship the log and conflicts first; ship branching only after the Proposals queue has taught the concept |
| The in-repo file becomes a second write path | It is a projection. The server never reads it as authority except through the sync protocol, which replays ops through the same validation as any other write |

**Cost, honestly:** the op log and content addressing are a solid week. Conflicts as
objects, another. Merge and session branches depend entirely on the reconciliation engine
and should not start before it. The in-repo projection is small once the log exists.

**Sequenced against value:** the op log's benefits (provenance, lineage, idempotency,
conflicts) arrive without branching. Branching is where the cost is. Build the log, ship
conflicts and lineage on it, and let real usage decide whether speculative agent branches
are wanted before building merge.

---

## Sources

- [Why Pijul — patch theory versus three-way merge](https://pijul.org/manual/why_pijul.html)
- [Pijul: conflicts as first-class objects](https://pijul.org/)
- [Merging, patches, and Pijul — a categorical treatment](https://jneem.github.io/pijul/)
