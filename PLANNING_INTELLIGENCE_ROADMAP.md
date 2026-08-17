# Planbraid Planning-Intelligence Roadmap

How the 25-feature vision maps onto the system that actually exists, what is already
built, what conflicts with a decision this codebase already made and measured, and the
order to build the rest in.

This is a planning document, not a specification rewrite. It sits beside the existing
four:

| Document | Answers |
|---|---|
| `PRODUCT_ARCHITECTURE_PLAN.md` | The canonical domain model and long-form product spec |
| `GRAPH_ARCHITECTURE.md` | Why dependencies are a graph and how the DAG is maintained |
| `DEDUPLICATION_ARCHITECTURE.md` | Why proposals are matched structurally, and why embeddings were removed |
| `IMPLEMENTATION_PLAN.md` | What shipped, M0–M6 |
| `RECONCILIATION_ARCHITECTURE.md` | **The core module.** The full multi-signal reconciliation pipeline, its scoring model, calibration, and the intelligence tier |
| `PLAN_VERSION_CONTROL.md` | Plan-as-patch-log, conflicts as first-class objects, and where git is authoritative |
| `CAPTURE_ARCHITECTURE.md` | How Planbraid stays current without asking the model to cooperate |
| **This document** | What the planning-intelligence features cost, in what order, and what they collide with |

**Build status.** M7 (project-scoped reads, F2/F5 closed), M8 (maturity ladder, resolution
qualifier, proposals queue), M9 (provenance on every write, derived confidence, F4 closed),
M21 (planning-loop detection), F1 (`work_claims` leases, wired up end to end), F7
(`parent_id` removed — decided in favor of `objective_id` at M20, not built prematurely),
F9 (interaction reconciliation now attributed by `interaction_id`, closing the
overlapping-interaction cross-attribution bug), and F10 (Simplify finding corroboration —
`report_simplify_finding` MCP tool, `agreed_by` finally written, agent-originated findings
always informational-only) are shipped and tested. That closes every item on §13's
half-built list except the work bound up in the larger milestones below. The test harness
was also fixed along the way: it created a fresh WASM Postgres per test and never closed
one, which crashed the suite on a different file each run.

**E0 is also shipped**: `reconciliation_labels` table, label capture wired into
`merge_items` (positive), `split_alias` (negative, both the merge-restore and
never-merged-alias paths), and dismissing a duplicate-shaped Simplify finding (negative, at
weak confidence — a dismissal is real signal but weaker than an explicit split). The pure
`evaluateReconciliation()` function and a `npm run reconcile:eval` CLI report recall,
precision, the false-merge count (per `DEDUPLICATION_ARCHITECTURE.md §6.3`'s asymmetry,
the one number that can veto a release), and the "split true duplicates" residual §6.1 says
to watch before ever readmitting a semantic tier — 267 domain tests plus the 9-test build
suite, all green. The golden set is empty on a fresh deployment by design; it accumulates
from real merges, splits, and dismissals, which is the whole point of building this before
E1's blocking rebuild or E3's scorer.

**M25 (the Pijul-inspired plan operation log) is also shipped**, built with extra care per
explicit request: `plan_ops` (content-addressed, `hash = sha256(type ‖ canonicalPayload ‖
sortedParents)`, uniqueness scoped to `(project_id, hash)` — see the false-collision bug
below), `plan_refs` tracking each project's canonical-branch head under an advisory-locked
transaction, and a `plan_conflicts` table left genuinely unpopulated (raising a conflict
needs the reconciliation engine's `CONFLICTS` relation type — E4 — which doesn't exist
yet; wiring it is M19's job). Capture is wired into every genuine, non-replay mutation in
`executeCommand` — 9 command types — while `create_project`/`update_project` (project-level,
not plan content) and `mark_notification` (carries no `project_id`) are deliberately
excluded. All 267 pre-existing tests pass completely unmodified, proving the milestone's
central constraint: *the system works identically with the log ignored*.

Two real bugs surfaced by writing the tests first, both fixed before this was called done:

1. **A genuine collision bug**, not a test artifact: the hash formula is deliberately
   project-agnostic (matching the architecture doc), so two different projects' first-ever
   op can legitimately share identical content (empty parents, same type/payload) and hash
   identically. With `hash` alone as the primary key, the second project's op was silently
   dropped by `ON CONFLICT DO NOTHING` — a real cross-project data-loss bug caught by a test
   that create two projects and appended to both. Fixed by scoping the primary key to
   `(project_id, hash)`, the same fix git gets for free from one object store per
   repository.
2. **A pre-existing, completely uncovered bug** in `mark_notification`, unrelated to this
   milestone but found while exercising it for the first time in the whole test suite: a
   `CASE` mixing an untyped bound parameter, a bare `NULL`, and a `TIMESTAMPTZ` column
   left Postgres nothing to infer a type from. Fixed with explicit `::timestamptz` casts
   and real booleans instead of 0/1 integers.

One limitation is documented rather than papered over: the test harness
(`@electric-sql/pglite`, embedded single-instance WASM Postgres) does **not** actually
enforce `pg_advisory_xact_lock` blocking across concurrent transactions — three racing
transactions all "acquire" immediately with no serialization. This was verified directly
with an isolated probe, not assumed. `appendPlanOp`'s locking pattern reuses the exact
primitive `create_project` already depends on for an equivalent read-then-write race, and
is standard, correct Postgres practice — but genuine multi-connection concurrent-write
correctness for this function has only been verified by that reasoning, not by a passing
test against real concurrent backends, and the test file says so explicitly rather than
asserting a guarantee the harness cannot prove. What *is* verified: no op is ever lost or
corrupted under concurrent load regardless of serialization, and every sequential chain —
which this harness does correctly execute — is exactly correct.

**M11 (pre-planning intelligence) is also shipped** — the single highest-return item in
this document. `get_planning_context` reuses exactly the signature and thresholds the
shipped dedup matcher already trusts (`lib/dedup/signature.ts`, `THRESHOLDS.lexicalFloor`)
rather than building new retrieval, so "relevant to this objective" means the same thing
here as it does when two proposals are compared for being the same task — and the
retrieval function is isolated so E1–E7's real retrieval can swap in later without
touching the bucketing or guidance logic. Six buckets (alreadyDone, inProgress — with the
live lease holder from F1's `work_claims`, blocked — reusing Simplify's own chain-walk so
"why is this blocked" never has two answers, rejected — with resolution and reason,
openProposals — with corroboration, and planned), plus a guidance array generated only
from populated buckets, never a template firing on empty data. Wired into the server's
`initialize.instructions` and the `plan_project_work` prompt. 308 domain tests, all green,
including the roadmap's own literal "done when" bar: the two-agent scenario, where the
second agent's objective surfaces the first agent's completed work by item key.

One real bug surfaced by the tests, worth knowing about for future TypeScript work in this
codebase: `PlanningContextItem`'s optional `reason?: string` and `PlanningContextRejectedItem`'s
intended `reason: string | null` collided under `&` intersection — `(string | undefined) &
(string | null)` silently collapses to plain `string`, dropping the null case entirely with
no compiler warning at the type definition site, only at first use. Fixed by giving the two
different concepts (why something is blocked vs. why something was rejected) different
field names rather than sharing one across an intersected type.

**M12 (why-not-done reasoning) is also shipped.** `explain_work_item` (MCP) and
`/api/explain` (web UI, surfaced in the task drawer) answer "why hasn't this been done"
with exactly one cause from a total, pure precedence function: a terminal resolution
outranks everything (seven distinct resolution-shaped causes, not one shared
"cancelled"), then deliberate deferral, then a dependency chain walked to its root
(reusing Simplify's own `findBlockedChains` pass, never a second implementation), then an
asserted external block, then whether a live lease (F1) actually backs an "in progress"
claim — surfacing the started-while-unattended case as a first-class cause rather than
only as a board anomaly badge — then in-review, then unaccepted-proposal, then the honest
default of "accepted, unblocked, untouched." 24 tests, all green.

One real bug caught before shipping: the first version of the DB-backed chain walk passed
only the single item being explained into `findBlockedChains`, which builds its lookup
table from the same item list it walks — so every prerequisite lookup missed, and a
two-hop chain ("waiting on #4, which itself waits on #3") silently truncated to nothing.
Fixed by loading the full project's items and edges for the chain walk specifically,
matching exactly what Simplify's own pass already loads for the identical reason.

**M13 (agent handoff packages) is also shipped**, and it was genuinely free the way the
roadmap predicted: `get_handoff_package` (MCP) and a "Handoff" button in the UI (with a
one-click copy, per the roadmap's own suggestion) reuse M11's bucketing and M12's
data access almost entirely. The one new idea, "Do NOT redo," needed M9's confidence
derivation specifically — a completion claim only belongs in the must-not-redo section
once it clears the same verified/unverified line `lib/trust/confidence.ts` already draws,
so an unverified "done" gets its own separately labelled section instead of being trusted
alongside the real thing. Next actions are pulled directly from `getReadyWork` rather than
a second ranking. Plain-text output matches the roadmap's own worked example's section
names exactly, since that shape is what "paste into any agent" is optimizing for. 12
tests, all green on the first run.

That closes the Phase B trio the build order calls "what the moat is for" — M11, M12, M13
all shipped, all reusing one retrieval and one confidence model rather than three
divergent ones.

**M19 (decisions and conflicts) is also shipped**, built on primitives that already
existed rather than a parallel write path: a decision is an ordinary work item
(`type='decision'`, a field `create_item` gained for this), `decision_options` rows carry
the competing choices, and `conflicts_with` (a new symmetric annotation edge type,
deliberately excluded from the DAG since it asserts mutual exclusion, not ordering) links
the decision to each option's related work. `record_decision` (MCP) is open to either an
agent or a person — noticing a conflict is exactly the kind of thing an agent is well
placed to do — but `resolve_decision` is browser-principal-only, the same authority check
`set_maturity` already enforces for promotions, because a resolution permanently
supersedes the losing side: every losing option's related item transitions to
`cancelled`/`superseded` and gets a `supersedes` edge back to the decision, which is what
makes it surface in M11's `rejected` bucket, with its reason, the next time an agent's
`get_planning_context` objective resembles it. `get_project_brief` gained a
`decisionsOpen` field at the time; wiring the same into `get_planning_context` was
deferred then, and has since shipped — `decisionsOpen` is unconditional (not
relevance-ranked against the objective, matching `get_project_brief`'s own field exactly),
excludes `type='decision'` items from the ordinary relevance-ranked buckets so a decision
never doubles up in `planned`/`inProgress`, and adds its own guidance line. The web UI got
a "Decisions" tab mirroring the Proposals queue, listing each open decision's options with
a one-click "Choose."

One real bug caught before shipping: closing a decision item straight from its initial
`proposed` status to `done` isn't a legal transition (`ALLOWED_TRANSITIONS` only permits a
direct `done` from `in_progress` or `in_review`), so `resolveDecision` failed on every
attempt. Fixed by starting a decision at `in_progress` instead of `proposed` — which is
also the more honest status for something open the moment it is raised, not a task
awaiting acceptance into a plan. Two idempotency gaps were also closed deliberately rather
than left to the generic per-command idempotency records, which don't cover
`recordDecision`'s option rows or `resolveDecision`'s second call by themselves: a retried
`record_decision` is detected by checking whether the decision already has options before
inserting any, and a `resolve_decision` retried with the same winning option replays the
current state instead of throwing "already resolved," while a *different* winning option
on a second call still fails loudly as the genuine conflict it is. 19 tests, all green.

**M14 (leases and collision detection) is also shipped, closing the milestone F1 only
partially covered.** F1 wired the lease lifecycle itself; the two pieces the roadmap table
called out as remaining were the artifact-intersection collision check (feature 13 v0) and
the Agents view actually reading live leases. Both are done: `lib/planning/collision.ts`'s
`checkCollisions()` reuses `buildSignature`'s artifact extraction (already computed for
every item by M7's indexing) rather than a new comparison, and is deliberately a cheaper,
more mechanical signal than M11's `inProgress` bucket — it fires on a shared concrete file
or symbol regardless of whether the two titles read as related at all, which is exactly
the case wording-based relevance ranking misses. Wired into `get_planning_context` as a
new `collisions` field alongside its own guidance line, excluding the calling session's
own claim so an agent never gets warned about colliding with itself.

One real gap caught while wiring the Agents view: `DashboardState` had no `claims` field
at all, so "who holds what and for how long" was structurally impossible to show — the UI
had been reading `work_items.source_id` (who originally proposed an item) as a stand-in
for who currently holds it, which is a different fact once work changes hands. Added
`claims` to `loadDashboard` (scoped through `work_items.organization_id`, since
`work_claims` carries no organization column of its own) and rebuilt the Agents view
around live leases with a remaining-time label, replacing the old sourceId-authored-items
list entirely. 10 new tests (9 for `collision.ts` plus one for the dashboard's claims
field), all green; full regression suite (373 domain tests, 9 build tests) and lint clean.

**M15 (repository observations via the bridge) is also shipped.** `repo_observations`
(one row per commit actually reported, `UNIQUE(project_id, head_sha)` making a retried or
duplicate report a no-op rather than a duplicate row), `report_repo_state` (MCP), and
`lib/evidence/ingest.ts`'s `ingestRepoObservation()` — which attaches `commit`-type
evidence to every work item whose known artifact intersects the changed paths, matched by
path-boundary-aware suffix (`apps/web/lib/store.ts` matches the artifact `store.ts`;
`backingstore.ts` does not, a real false-positive caught and fixed before shipping). The
one piece of judgment in the module: evidence only ever reads `result: "verified"` when a
verification command was both configured and actually exited zero — a bare commit
touching a file is not proof the file is correct, and `lib/trust/confidence.ts` already
treats "verified" as its strongest tier, so writing it for an unverified touch would be
exactly the fabricated trust signal M9 exists to prevent. A failed command reports
`"failed"`; no configured command reports neither.

The bridge hook (`integrations/bridge/planbraid-hook.mjs`) now calls `report_repo_state`
at turn end: HEAD sha, branch, and `git diff --name-only` against the merge base (falling
back to the working tree's own diff when there is no merge base — a shallow clone, no
configured remote, a detached HEAD). Paths and commit metadata only, matching the bridge's
existing "never opens provider transcript files" promise — a configured
`PLANBRAID_VERIFY_COMMAND`'s exit code is reported, never its stdout or stderr.
`PLANBRAID_DISABLE_REPO_STATE=1` opts out entirely, per the roadmap's privacy requirement.
10 tests for the ingest module, plus 4 real subprocess integration tests that git-init a
temp repo and spawn the actual hook script against a stub MCP server rather than
reimplementing its logic — the only layer that can catch a real bug in how the script
shells out to `git`, and the one that caught the stdout-leak test itself needing a fix
(a verification command's own literal text can legitimately contain a string that looks
like a leak; only its *output* must never appear).

**A real gap in the already-shipped M14 was caught and closed while building M16.** The
MCP tool migration table (§ MCP tools) always specified that `start_work` itself should
take an exclusive lease and reject a conflicting live session with `409 WORK_LEASED`, but
the actual M14 build only wired collision detection (`lib/planning/collision.ts`) and the
Agents view; `start_work` still moved an item to `in_progress` with no lease check
whatsoever; a claim only existed once a *later* heartbeat happened to report it, leaving a
real window where two sessions could both "start" the same item. Fixed with a new
`startWork()` in `lib/store.ts`: checks for another live session's active claim before
transitioning, throws `WORK_LEASED` (409, naming the holder and lease expiry) unless
`force: true` is passed, and — this is the part that actually makes the lease exist —
writes the claim itself rather than waiting on `heartbeat_agent_session`. One real bug
caught before shipping: `work_claims`' conflict target is `(work_item_id, source_id)`, not
`work_item_id` alone, so a forced takeover's `INSERT ... ON CONFLICT` sat a second claim
row *alongside* the original holder's instead of replacing it — both rows stayed live,
and which one a plain `SELECT` returned was arbitrary. Fixed by clearing every other row
on the item before writing the new claim. 6 new tests, all green.

**M16 (evidence-backed completion) is also shipped**, after checking with the user first:
the roadmap itself flags this as §9 decision 1, a change to every connected agent's actual
workflow, not a routine additive milestone. Confirmed before building. The gap it closes
was real and live: `report_completion` trusted a `verified` boolean the *calling agent*
set on itself, with nothing checking the claim — an agent could always pass
`verified: true` and land directly on `done`. `lib/planning/completion.ts`'s
`reportCompletion()` replaces that with the same definition of "verified" M9's
`lib/trust/confidence.ts` already uses (`result === "verified"` on an evidence row), so
the two halves of the trust model can never quietly disagree about what counts. The
`verified` boolean was removed from the tool entirely rather than deprecated, since
keeping it would keep the door open.

The one design decision that mattered: the gate reads evidence that already existed
*before* the call, never evidence the same call is attaching. Deciding it the other way
around — reachable at first — would have let an agent write `result: "verified"` straight
into its own evidence array and reach `done` immediately, identical to the old boolean
just wearing a different field name; a test built around exactly that case (`tests/
evidence-backed-completion.test.mjs`) is what caught it. The one mechanical source of
pre-existing `result: "verified"` evidence today is M15's `report_repo_state`, computed
from a real exit code in an earlier call, never from anything asserted inside this one. A
human still reaches `done` directly through the web UI's status control, untouched by this
gate, per M8's authority model. A second real bug surfaced while making the gate
idempotent: re-fetching the item's current version on every call broke retries, because a
retry's second `transition_item` call saw a version the first call's evidence-attachment
had already advanced past, producing a spurious `IDEMPOTENCY_MISMATCH` rather than a
replay. Fixed with a dedicated top-level idempotency check in
`reportCompletion()` itself, short-circuiting a retry before any of that version
arithmetic runs. 8 tests, all green.

**M17 (divergence detection) is also shipped**: two new informational Simplify finding
kinds, both carrying a `proposedCommand` despite being informational — a deliberate
departure from every other informational kind in the pipeline, matching the roadmap's own
wording exactly ("propose a transition the user applies, never automatic").
`possibly_implemented` (a `planned` item whose known files a commit touched after it was
proposed) is pure, living in `lib/simplify/analyze.ts` alongside every other structural
finding, because everything it needs — items and M15's `commit`-type evidence — is already
sitting in `DashboardState`. `evidence_removed` (a `done` item whose evidenced file a
later commit deleted) is not pure and cannot be: telling "deleted" from "merely edited"
needs `repo_observations`' deleted-path list directly, which is deliberately not exposed
on `DashboardState` at all (it would be a growing per-commit log with no other use in the
product), so `lib/simplify/divergence.ts` reads it the same way `collision.ts` and
`ingest.ts` already do, and runs alongside `do_first` as the other DB-backed pass appended
in `createSimplificationRun`.

Getting `evidence_removed` right required extending M15 itself: `git diff --name-only`
cannot distinguish a deleted file from a modified one, so the bridge hook now shells out
to `git diff --name-status` instead, parsing rename lines (`R<score>\told\tnew`) into a
deleted old path and a changed new path. `repo_observations` gained a `deleted_paths`
column and `report_repo_state` a `deleted_paths` argument. One real bug caught before
shipping, and a second one caught only once the first was fixed enough to expose it: (1)
a deletion was still being treated as a "touch" for M15's own evidence-attachment, since a
deleted path is technically also a changed path — meaning a file's removal silently
re-confirmed its own evidence at the exact moment it stopped existing, permanently masking
the removal from ever being detected. (2) Fixing that then surfaced a genuine test-ordering
hazard: two `report_repo_state` calls issued back to back can land in the same millisecond
under Postgres's `now()`, making "which one happened later" indeterminate — the tests now
back-date deliberately rather than relying on real-time ordering between fast successive
calls. The Simplify UI's finding-kind groups and apply-button labels (`app/
planbraid-app.tsx`) needed the same update M14 and M19 both needed: a new finding kind
invisible to `findingGroups` renders nowhere at all, silently, which is exactly the kind
of half-shipped surface `§13` warns about. 20 new tests across four files (`analyze.ts`'s
pure pass, `divergence.ts`'s DB-backed pass, `ingest.ts`'s deletion exclusion, and the
bridge hook's real subprocess integration tests), all green; full regression suite (424
tests) and lint clean.

**M22 (planning debt and health) is also shipped**: `lib/planning/health.ts`'s
`computeHealth()` is a pure weighted rollup over open Simplify findings (`do_first` is
guidance, not debt, and is excluded entirely rather than weighted at zero, or it would
inflate every healthy project's "debt" by the size of its own ready queue) plus
`getPlanningHealth()`, which always runs a fresh Simplify pass rather than reading
whatever run happens to be newest — a health score computed from a stale run is exactly
the trust gap M9 and M16 both exist to close elsewhere in this product. The score is
never returned, shown, or usable without the ranked debt list and per-kind breakdown
beside it, per the roadmap's own rule ("if the score ships, it ships as the sum of a
visible breakdown, never as an opaque number"). New `get_planning_health` MCP tool,
`/api/health` route, and a Health button/dialog in the web UI. 11 new tests, all green.

M20 (objectives) and M18 (GitHub App expansion) remain deliberately unbuilt: both carry
an explicit "should not start until X" in their own roadmap text — M20 on real usage
evidence of whether agents actually group work under objectives, M18 on M15-M17 proving
their value first, and M18 additionally needs real external GitHub App credentials this
session cannot provision. Both are genuine dependencies, not self-imposed caution.

**M23 (query surfaces) is also shipped.** "Saved views over the structured state...
No prose parsing" is the whole design, and it is read literally: `lib/planning/views.ts`'s
`getSavedView()` is five fixed, named queries (`active`, `blocking_release`,
`keeps_getting_proposed`, `no_proof`, `needs_decision`), every one of them retrieval over
a signal M9, M12, M19, or M21 already computes — nothing here infers anything new, matching
`RECONCILIATION_ARCHITECTURE.md §9`/D3's reason for keeping a hosted model off this path
entirely. `blocking_release` needed one small, real gap closed first: `findBlockedChains`
computed a chain's root work item internally but only ever exposed it as prose inside
`detail` ("Start with #12..."), with no structured ID a caller could act on — extended to
carry it in the existing `relatedWorkItemId` field instead of parsing the sentence back
apart, and items sharing one root are grouped into a single ranked entry rather than
reported once per blocked item. New `get_saved_view` MCP tool, `/api/views` route, and a
Views button/dialog with a five-way segment in the web UI. 11 new tests, all green.

Phase C and D are now fully closed out except the two genuine holds: **M18** (GitHub App
expansion — needs M15-M17 to prove their value in real usage first, plus real external
GitHub App credentials this session cannot provision) and **M20** (objectives — needs
real usage evidence of whether agents actually group work under objectives at all). Both
are explicit "should not start until X" calls in the roadmap's own text, not self-imposed
caution.

Next: E1 (blocking rebuild — the artifact-index retrieval M7 already forced covers the F2
half of it; the RRF fusion over five retrievers is what remains) is the next unbuilt
piece with no external dependency, though each of E1–E8 is a full algorithmic subsystem
in its own right (Fellegi-Sunter scoring with offline weight training, pgvector
embeddings, tree-sitter repo grounding) and E2 through E8 each depend on the stage before
them — building this responsibly means one stage at a time, not all at once. C0–C5
(capture architecture) start with C0, explicitly framed as a feasibility *probe* that
needs live hook testing in real Claude Code/Codex sessions to mean anything — not
something a single session can just implement and call shipped. See
`RECONCILIATION_ARCHITECTURE.md §13` for the full E-series build order.

**Scope: single user.** Everything below assumes one person and their own agents. Team
features are deliberately out of scope for this phase (§9). The schema is already
multi-tenant-shaped — `organization_id` is on every table — so this costs nothing later,
provided no new table drops it.

Sizes are relative and consistent with `IMPLEMENTATION_PLAN.md`: **S** = a sitting,
**M** = a day or so, **L** = multi-day.

---

## 1. The headline

**About a third of the roadmap is already shipped, a third is cheap because the
machinery exists under a different name, and a third is genuinely new work that
gates on two things nobody has built: a maturity ladder, and real contact with git.**

Three of the roadmap's P0s are done. Two of its "core moat" items are half-built and
invisible. One of its recommendations — feature 2's semantic tier — was built,
measured, and deliberately deleted here, and the reasoning still holds; the version of
feature 2 worth building is a different one, and it is better than the one in the
roadmap.

The single highest-return item in all 25 is **feature 3, pre-planning intelligence**.
It requires no new data, no model, and no schema change beyond what feature 10 already
needs. It is one MCP tool that serializes data the database already holds. Everything
that makes Planbraid special is already in the tables; almost none of it is reaching
the agent at the moment it plans.

---

## 2. Where the roadmap meets the code

Legend: **Shipped** — works today, end to end. **Partial** — the storage or the
machinery exists but is unreachable, unused, or half-wired. **New** — nothing exists.
**Revise** — the feature as written conflicts with a decision this codebase made on
evidence; build the amended version.

| # | Feature | P | State | Where it stands |
|---|---|---|---|---|
| 1 | Canonical planning graph | P0 | **Partial** | `work_items` + `dependencies` + `work_events` + derived columns all ship. Missing: hierarchy (`parent_id` is declared and never written), objectives, plans as entities, and 5 of the 12 requested states. See §4.1 — most of the missing states should **not** become statuses. |
| 2 | Semantic plan reconciliation | P0 | **Partial — now the core module** | The cascade, vetoes, aliases, delta capture and corroboration ship (`lib/dedup/`). The full nine-signal pipeline, calibrated scoring, blocking, relation typing, the reopened embedding question, and the intelligence tier are designed in full in **`RECONCILIATION_ARCHITECTURE.md`**, which supersedes the single milestone this document originally allotted. |
| 3 | Pre-planning intelligence | P1 | **New** | `get_project_brief` returns four status buckets and a canned "recommendedNextActions" string. Nothing retrieves *relevant* history, rejected approaches, or other agents' live work. **Highest ROI in the document.** |
| 4 | Plan revision lineage | P1 | **New** | `work_events` is append-only and complete per item, but there is no plan or objective to revise, and no reason field — the "why" is prose inside `summary`. |
| 5 | "Why?" history | P1 | **Partial** | Every transition records actor, from/to, and free-text reason. `blocker_reason` exists. Nothing is queryable as causation, and "why is this *not* done" has no answer beyond a status string. |
| 6 | Proof-of-work | P1 | **Partial** | `evidence` table, `completion_confidence`, `verification_status`, and a review gate all ship. But the agent asserts its own verification, nothing checks that the evidence exists, and `verification_status` is set to `passed` purely because the status became `done` (`lib/store.ts:574`). |
| 7 | Stale planning detection | P2 | **Partial** | Simplify finds stale *proposals* by age. Plan-vs-code divergence needs git, which Planbraid cannot currently see. |
| 8 | Planning conflict detection | P1 | **Partial** | Conflicting *approaches* are undetected. Worse, the one case the roadmap names is currently classified as unrelated — see finding F3. |
| 9 | Human decision required | P2 | **New** | No decision entity, no queue. Cheap once `type='decision'` items exist. |
| 10 | Proposal ≠ decision ≠ task | P0 | **New** | Every agent proposal becomes a real card at `status='proposed'`. This is the graph-pollution problem, live today. **Gates features 3, 9, 17, 21, 25.** |
| 11 | Confidence and provenance | P0 | **Partial** | `assurance`, `completion_confidence`, `match_method`, `source_id` and per-account attribution all ship. What is missing is a class on each *assertion* — how it was learned — and a derived confidence. |
| 12 | Multi-agent ownership and leases | P2 | **Partial** | `work_claims` **exists in the schema with lease columns and is never written or read** (finding F1). Collision avoidance currently rides on `sources.current_task_ids`, which has no expiry. |
| 13 | Work overlap detection | P2 | **Partial** | A v0 is nearly free: `buildSignature` already extracts file paths and symbols from every title and description. Nothing compares them across live claims. |
| 14 | Cross-model session identity | P1 | **Shipped** | Human → agent account → session → action is complete and tested (`agent_account_id`, `agentAccountKey`, `accountDisplayName`, `tests/agent-identity.test.mjs`). Only "→ Plan" is missing, and that is feature 4. |
| 15 | Agent handoff packages | P1 | **New** | A `handoff_work` prompt exists that tells the agent to go read things. The package itself is a serialization of feature 3's payload — nearly free once M11 lands. |
| 16 | Plan health score | P3 | **New** | Aggregation over findings that already exist. |
| 17 | Planning loop detection | P3 | **Partial** | The data is already collected: `work_item_aliases` records every restatement with its provider and timestamp. Loop detection is a query over data nobody is reading. **Cheapest differentiator in the document — pull it forward.** |
| 18 | Planning debt | P3 | **New** | Weighted rollup of §16's inputs. |
| 19 | Natural-language queries | P1 | **Revise** | Do not put a hosted model on the critical path. The consumer *is* a model, and there is a better place for owned intelligence. See D3 and `RECONCILIATION_ARCHITECTURE.md §9`. |
| 20 | GitHub / source-control integration | P1 | **Partial** | A GitHub App ships, but it holds `metadata: read-only` and is used only to pick a repository name. It cannot see a single commit. See D5, and `PLAN_VERSION_CONTROL.md §5` for what git should be authoritative *for*. |
| 21 | Agent permissions | P2 | **Partial** | Agent permissions fall out of D1 almost for free and ship in M8. **Human roles are out of scope** — single user. |
| 22 | API-first architecture | — | **Shipped in substance** | `executeCommand` is already the core; `/mcp` and `/api/commands` are already two interfaces over it. What is missing is a documented public surface, not a re-architecture. |
| 23 | Team projects | — | **Out of scope** | Deferred by decision. See §9. |
| 24 | Humans and AI as participants | — | **Shipped** | Every write path is actor-agnostic and attributed. |
| 25 | Planning authority | P2 | **New** | Same column as feature 10. See D1. |

---

## 3. Findings

Defects and gaps found in the shipped code while writing this. Several are load-bearing
for the features above, and two are silent.

**F1 — `work_claims` is dead.** The table ships with `mode`, `lease_expires_at`,
`heartbeat_at` and `UNIQUE(work_item_id, source_id)`, and the only statement in the
codebase that names it is a `DELETE` inside legacy demo cleanup (`lib/store.ts:119`).
Feature 12 is not new work; it is finishing a table someone already designed correctly.
Meanwhile collision avoidance rides on `sources.current_task_ids`, which never expires —
an agent that crashes holds its claim until something else overwrites the row.

**F2 — Duplicate matching silently stops seeing old work.**
`createWorkItemsDeduplicated` retrieves candidates with `ORDER BY updated_at DESC LIMIT
500` (`lib/store.ts:977`). `DEDUPLICATION_ARCHITECTURE.md §5` argues — correctly — that
matching against `done` items is *the more valuable case*, because it prevents redundant
work rather than a redundant card. Finished work is exactly what sorts last by
`updated_at`. Past 500 items, the first candidates dropped are the ones worth the most.
The failure is invisible: it produces a normal-looking new card.

**F3 — Opposite actions on the same artifact are classified as unrelated.**
`adjudicate` checks the antonym veto (step 2a) *before* the artifact comparison and
returns `distinct` (`lib/dedup/match.ts`). So "Add auth middleware" and "Remove auth
middleware", both naming `auth.service.ts`, are recorded as two unrelated tasks. That is
feature 8's exact scenario, and the veto that makes matching safe is currently also
suppressing conflict detection. The fix is one branch: antonym actions **plus**
overlapping artifacts is `CONFLICTS`, not `DISTINCT`.

**F4 — `verification_status` is a synonym for `status`.** `lib/store.ts:574`:
`const verification = command.status === "done" ? "passed" : ...`. Moving a card to done
sets verification to passed. It records no fact about verification, which makes feature
6's core distinction — "Claude says it finished" versus "the implementation exists" —
currently unrepresentable even though both columns exist.

**F5 — `getReadyWork` is N+1.** `downstreamOf` runs inside the candidate loop
(`lib/store.ts:1140`), one query per ready item, to compute unlock counts. Fine at
today's sizes; it is on the hot path for every "what next" call and for Simplify.

**F6 — `loadDashboard` still loads the whole organization on every MCP read.** Known
since `GRAPH_ARCHITECTURE.md §14.8` and still true. `list_work_items`, `search_work`,
`get_work_item` and `get_project_brief` all load every project's items, events,
dependencies, evidence and aliases and then filter in JavaScript. Every feature in this
roadmap adds a reader. This has to be fixed first or it gets fixed under duress later.

**F7 — `work_items.parent_id` is still declared and never written.** Hierarchy is
unimplemented, and features 1, 4, 8 and 20 all assume objectives exist.

**F8 — `recomputeBlockingCounts` is not scheduled.** Correct, tested, callable, and
nothing calls it except merge and alias-split. Drift repair is manual.

**F9 — Interaction reconciliation attributes by clock, not by interaction.**
`recordInteraction` decides `todos_changed` by counting events from the source since the
interaction started (`lib/store.ts:835`), with a one-hour fallback window. Two
overlapping interactions from one source cross-attribute.

**F10 — A collapsed proposal cannot carry a dependency onto its canonical item when it
lost the ref race.** `depends_on` refs resolve correctly through merges
(`lib/store.ts:1052-1083`) — this is handled well — but a ref naming an item that
matched into an item created *later in the same batch* resolves through `targetByIndex`,
which is only populated in outcome order. Worth a test; probably fine, currently
unproven.

---

## 4. Six decisions that govern everything

The roadmap describes *what* the system should know. These six decide *how*, and every
milestone below is downstream of them.

### D1 — Do not grow `status`. Add two orthogonal columns.

Feature 1 asks for twelve states. The system has eight plus a derivation, and
`GRAPH_ARCHITECTURE.md §2` explains at length why the eight are the number they are:
`status` already conflates an actor's assertion with a fact about topology, and the
whole `deriveColumn` mechanism exists to stop that conflation from producing stale
"blocked" cards.

Mapping the twelve honestly:

| Roadmap state | Where it belongs |
|---|---|
| `PROPOSED` `PLANNED` `READY` `IN_PROGRESS` `BLOCKED` | Already `status`. Ship. |
| `VERIFYING` | Already `in_review`. Rename in the UI only. |
| `COMPLETED` | Already `done`. |
| `DUPLICATE` | Already better modelled: an alias plus an archived item, reversible in one click. Do not make it a status. |
| `SUPERSEDED` | `status='cancelled'` + `resolution='superseded'` + an existing `supersedes` annotation edge naming the replacement. |
| `REJECTED` `DEFERRED` `ABANDONED` | `status='cancelled'` + `resolution`. |

So: **one new nullable column, `work_items.resolution`**, meaningful only in terminal
states, with values `completed | rejected | deferred | superseded | duplicate |
abandoned | obsolete`. That is feature 4-of-the-seven ("why-not-done reasoning") at the
cost of one column, and it leaves `ALLOWED_TRANSITIONS`, `RESOLVED_STATUSES`,
`deriveColumn`, `ASSERTION_WINS` and the board columns untouched. Adding five terminal
statuses instead would touch all of them, in three files, plus every test.

Second column: **`work_items.maturity`**, values `idea | proposal | accepted |
committed`. This is feature 10 and feature 25 — they are the same ladder seen twice, and
they should be one column, not two.

- `proposal` — an agent said it. Default for `create_work_items`.
- `accepted` — a human (or a human's explicit instruction, reported by an agent) decided
  it. Default for anything typed in the UI: a person entering a task is deciding.
- `committed` — accepted, owned, and scheduled.
- `idea` — captured deliberately, never by default.

Two rules make it worth the column:

1. **Only `accepted` and `committed` items appear in `get_ready_work`, the board's
   working columns, and the brief's "planned" section.** Proposals live in their own
   queue. This is the entire answer to "we could migrate from REST to GraphQL" becoming
   a TODO.
2. **Agents may write `maturity <= proposal`. Only a browser-authenticated principal may
   set `accepted` or `committed`.** One check in `executeCommand` keyed on
   `principal.authentication !== "browser"`, and most of feature 21's agent-permission
   table is enforced without a permission system existing.

`SUPPORTED` from feature 25's ladder is deliberately **not** stored: it is corroboration
count, which `getReadyWork` already computes from aliases by provider family. Derive it,
badge it, never persist it — same reason `deriveColumn` exists.

### D2 — Reconciliation is the platform, and it gets built to a measured standard.

This decision changed on research. It is now specified in full in
`RECONCILIATION_ARCHITECTURE.md`; the short version:

**The nine signals are the right nine.** They are, almost one-to-one, the feature set of
**REP** — the reference method in duplicate bug report detection — where a 2025 benchmark
found IR with weighted structured fields *outperforming* neural approaches. The part to
steal is not the feature list but the training procedure: REP's weights are learned by
gradient descent on the repository's own labels, not guessed.

**Scoring moves to Fellegi–Sunter.** Per-feature log-odds, learned offline from labels the
product already generates for free (every alias split is a negative, every human merge a
positive). This gives calibrated probabilities, principled handling of missing features —
most items have no acceptance criteria — and per-signal ablation, which is the only honest
way to decide whether a signal is worth its cost.

**The embedding decision is partially reversed, with evidence.**
`DEDUPLICATION_ARCHITECTURE.md §6.1` listed five costs for the semantic tier: an external
API on the write path, a timeout, four environment variables, a billing surface, and task
titles leaving the machine. **Every one of those is a property of a hosted API, not of a
vector.** A distilled *static* embedding (Model2Vec class, ~8–30 MB) is a token lookup
table with mean pooling — no runtime, no network, no key, no bill, nothing leaving the
deployment — and it can be served from a Postgres table so it adds zero bytes to a
serverless bundle. §6.1's reasoning was right about the implementation available then. It
is wrong about this one, and the ablation harness is what keeps that claim falsifiable.

**Still not built:** hosted embedding APIs, transformer inference in the request path
(`onnxruntime-node` alone is ~720 MB against Vercel's 250 MB limit), cross-encoders,
anything needing a GPU.

The agent-facing contract stays binary — created or matched — per
`DEDUPLICATION_ARCHITECTURE.md §6.2`. New relation types are reported as edges recorded,
never as a third adjudication the agent must make. That lesson was learned once already.

### D3 — Planbraid owns small models, borrows large ones, and depends on neither.

The question is not *whether* Planbraid gets intelligence of its own. It is *which kind*.

**Large models: borrowed, never depended on.** When the matcher lands in its ambiguous
band, the pair goes back to the caller as a precise question. The agent answering is an
LLM *with the repository open* — better positioned than any server-side model reasoning
over two strings, and free. This is the arrangement the current SOTA in duplicate
detection (Cupid) uses — IR ranks, a model adjudicates the hard cases — obtained without
owning a model. A second path asks the *person*, in the agent's own UI, via MCP's MRTR
`input_required` round trip. Neither is on a critical path: if both are unavailable, the
engine creates the item and flags the resemblance, which is today's behaviour.

**Small models: owned outright.** A static embedding table, a Fellegi–Sunter weight file,
optionally a gradient-boosted reranker over twelve features. All of them are kilobytes to
tens of megabytes, offline-trained, versioned in the repository, reviewed in a pull
request, and executed in-process. That is real proprietary intelligence with no vendor,
no key, and no data egress — and it is the part that compounds, because it improves every
time a user splits an alias.

**What stays rejected:** a hosted LLM on the write path. It reintroduces every cost
`§6.1` enumerated, makes the one decision in the product that must be reproducible
nondeterministic, and buys less than the free tier above.

**Feature 19 splits.** For an agent, natural-language project questions are already
answerable: it has the tools, and M11 gives it the context. For the *web UI*, ship
structured surfaces — saved filters, the decision queue, the debt list, "what changed and
why" — which answer 15 of the 16 example questions without prose parsing. If a
conversational surface is ever added, it must be optional and degrade cleanly, exactly the
way `githubConfigured()` gates GitHub today.

### D4 — Store assertions. Derive everything else.

The codebase has this discipline already (`deriveColumn`, corroboration, unlock count)
and it should absorb the new features rather than the reverse.

Stored: what an actor claimed, when, from where, and how it was learned.
Derived, never stored: confidence, planning debt, health score, loop detection,
"supported", staleness, blocked-because-topology.

Concretely, feature 11's confidence becomes a pure function:

```ts
// lib/trust/confidence.ts — no DB, no clock, no network
confidenceOf(item, events, aliases, evidence, now): {
  level: "high" | "medium" | "low";
  reasons: string[];        // "verified by a commit", "two models agree", "unconfirmed for 9 days"
  lastConfirmedAt: string | null;
}
```

testable line by line, and structurally incapable of going stale — which matters,
because a stored confidence score that no longer reflects the item is worse than none.

### D5 — Reach git through the developer's machine before reaching it through GitHub.

Features 6, 7, 13 and 20 all need to see code. There are two routes.

The GitHub App ships with `metadata: read-only` — enough to list repository names, and
nothing else. Proof-of-work through GitHub means requesting `contents: read`,
`pull_requests: read` and `checks: read`, plus webhooks. That is a real escalation the
user must approve per installation, it excludes local-only and non-GitHub repositories,
and it is a hard sell before the feature has proven itself.

The bridge already runs on the developer's machine, at the start and end of every turn,
with the working directory right there. `git rev-parse HEAD`, `git diff --name-only`
against the merge base, and a test command's exit code are three shell calls. That is
enough to answer "does the implementation exist", "which files did this touch", and "did
the tests pass" — for private repositories, local branches, and non-GitHub hosts alike,
with no new scope and no code leaving the machine (file *paths*, capped and
configurable; never contents).

**Build the bridge path first. Make GitHub the optional second source**, for PR state,
review, and CI on teams that want it. This also inverts the risk: if git ingestion turns
out not to earn its keep, nothing was escalated.

### D5b — Capture is a harness problem, not a prompting problem.

Instructing a model to keep Planbraid updated is probabilistic; subscribing to its
harness is not. Claude Code exposes 30 lifecycle hook events, Codex reached hooks GA in
May 2026, and the bridge Planbraid already ships uses a fraction of them. Two consequences
that change the roadmap, both detailed in `CAPTURE_ARCHITECTURE.md`:

- **Pre-planning intelligence needs no agent cooperation.** A `UserPromptSubmit` hook can
  inject planning context directly into the turn. The MCP tool becomes the fallback for
  clients without hooks, which removes that feature's single largest risk.
- **The agent's own todo list is capturable.** `TaskCreated`/`TaskCompleted` carry the
  plan the model actually made, rather than the one it remembered to report.

### D6 — The read path has to move off `loadDashboard` before anything else is built on it.

Finding F6. Six of the milestones below add a reader over project state. Every one of
them, built on `loadDashboard`, loads every project the user owns and filters in memory.
This is M7, it comes first, and it is not optional.

---

## 5. Data model, in one place

Every schema change the roadmap implies, collected so the migration order is visible.
All additive; all `ADD COLUMN IF NOT EXISTS` in `MIGRATION_STATEMENTS` or new
`CREATE TABLE IF NOT EXISTS` in `SCHEMA_STATEMENTS`, consistent with `db/setup.ts`.

**`work_items`**

| Column | Type | Purpose | Milestone |
|---|---|---|---|
| `maturity` | `TEXT NOT NULL DEFAULT 'accepted'` | D1. Existing rows become `accepted` so nothing disappears from a board on deploy. | M8 |
| `resolution` | `TEXT` | D1. Why a terminal item ended the way it did. | M8 |
| `resolution_reason` | `TEXT` | Free text behind the resolution — feature 5. | M8 |
| `deferred_until` | `TIMESTAMPTZ` | Deferral with a date, so "not now" stops looking like "abandoned". Excluded from ready work until it passes. | M8 |
| `status_provenance` | `TEXT NOT NULL DEFAULT 'ai_proposed'` | Feature 11: how the *current* status was learned. | M9 |
| `objective_id` | `TEXT` | The objective this serves. Deliberately not `parent_id` — see M20. | M20 |
| `scope_artifacts` | `TEXT NOT NULL DEFAULT '[]'` | Cached signature artifacts, for collision detection without re-parsing every item on every check. | M14 |

**`work_events`** — `provenance TEXT NOT NULL DEFAULT 'ai_proposed'`, `reason TEXT`,
`plan_revision_id TEXT`. The event log is where "why" belongs; `summary` is prose for
humans and `reason` is the queryable field feature 5 needs. (M9, M20)

**`dependencies.type`** — three new annotation types (`subtask_of`, `overlaps`,
`conflicts_with`) and one new DAG type is *not* added. `ALL_EDGE_TYPES` grows;
`DAG_EDGE_TYPES` stays `["blocks", "requires"]`. `conflicts_with` is mutual exclusion,
not ordering, and putting it in the DAG would deadlock work. (M10)

**`evidence`** — `verification TEXT NOT NULL DEFAULT 'unverified'`
(`unverified | verified | failed | unverifiable`), `verified_at TIMESTAMPTZ`,
`commit_sha TEXT`, `files TEXT NOT NULL DEFAULT '[]'`, `attested_by TEXT`. (M15/M16)

**`work_claims`** — exists. No change needed; start writing it. (M14)

**New tables**

```
repo_observations(id, organization_id, project_id, coding_space_id, commit_sha,
                  branch, files /*JSON*/, message, observed_at, source_id,
                  UNIQUE(project_id, commit_sha))                          -- M15

decision_options(id, decision_work_item_id, label, proposed_by_source_id,
                 rationale, status, created_at)                            -- M19
```

Plus the reconciliation engine's tables (`work_item_artifacts`, `token_vectors`,
`repo_symbols`, `reconciliation_labels`, `reconciliation_judgments`) in
`RECONCILIATION_ARCHITECTURE.md §12`, and the operation log's (`plan_ops`, `plan_refs`,
`plan_conflicts`) in `PLAN_VERSION_CONTROL.md §3`.

A `plan_revisions` table was in an earlier draft of this document and has been **dropped**:
a revision is a named range of operations on a branch, so the op log gives lineage without
a second hierarchy to keep consistent with the first.

Deliberately **not** added: a `plans` table (a plan is a range of operations), a
`proposals` table (that is `maturity`), a second conflicts table (that is
`plan_conflicts`, paired with a `type='decision'` work item and its edges), and any table
holding vectors fetched from a hosted API (D2 — the admitted embedding is a local static
table, not an API cache).

---

## 6. MCP surface

New tools and changed contracts, all in `app/mcp/route.ts` over `lib/`.

| Tool | Status | Notes |
|---|---|---|
| `get_planning_context` | **new, M11** | *The* feature-3 tool. Takes `project_id` and the objective in the agent's own words; returns relevant done / active / planned / blocked / rejected work, live leases by other agents, prior decisions, and explicit planning guidance. |
| `explain_work_item` | **new, M12** | Feature 5. Why this is not done: the causal chain, who decided, evidence, and the events behind it. |
| `get_handoff_package` | **new, M13** | Feature 15. Same retrieval as M11, serialized for a cold agent. |
| `propose_work_items` | **rename path, M8** | `create_work_items` keeps its name and contract but now defaults `maturity='proposal'`. The tool description must say so, or agents will report tasks as planned that a human has not accepted. |
| `accept_work_items` | **new, M8** | Records that the *user* accepted something in-conversation. Requires the agent to state who said so; provenance is `human_stated`, not `human_approved` — an agent's report of consent is weaker evidence than a click, and the two must not be recorded identically. |
| `start_work` | **changed, M14** | Takes an exclusive lease. Returns `409 WORK_LEASED` with the holder's account and session when another live agent holds it; `force: true` overrides and is recorded as an event. |
| `report_completion` | **changed, M16** | No longer reaches `done` on the claimant's own say-so. See §9, decision 1. |
| `link_work_items` | **extended, M10** | Accepts the new annotation types. |
| `record_decision` / `resolve_decision` | **new, M19** | Feature 8/9. Resolve is human-only. |
| `open_plan_revision` / `close_plan_revision` | **new, M20** | Mirrors `begin_interaction`/`sync_interaction`, which agents already follow. |
| `get_project_brief` | **extended, M11** | Gains the decision queue and open leases. |
| `report_repo_state` | **new, M15** | Bridge-facing: commit sha, branch, changed files, test outcomes. |
| `cancel_work` | **new** | A real, previously-missing gap: `transition_item` could always move any item to `cancelled` (no authority restriction — cancelling isn't accepting), but no MCP tool ever exposed it; an agent had no way to reject its own proposal or mark something no-longer-needed at all. Open to either an agent or a person, the same reasoning `record_decision` already uses. Strongly urges a real `resolution` (`rejected`/`superseded`/`duplicate`/`abandoned`/`obsolete`) rather than the `unspecified` default, since only a recognized resolution reaches `get_planning_context`'s `rejected` bucket. |

One rule for all of them, learned from `get_ready_work`: **the tool description is the
product.** An agent picks between `list_work_items` and `get_ready_work` on prose alone.
`get_planning_context` is worthless if agents call it after planning instead of before,
so its description must say "call this before proposing work" and the server
`instructions` string must repeat it.

---

## 7. Milestones

Four phases. Each gates the next; within a phase, items are mostly parallelizable.

### Phase A — Foundations (nothing else is safe to build first)

#### M7 — Project-scoped reads (M)

Finding F6, and D6.

| File | Change |
|---|---|
| `lib/read/project-view.ts` *(new)* | `loadProjectView(db, principal, projectId, { include })` — scoped queries returning only what a caller asked for |
| `app/mcp/route.ts` | `get_project_brief`, `list_work_items`, `get_work_item`, `search_work` move off `loadDashboard` |
| `lib/store.ts` | `getReadyWork`: replace the per-candidate `downstreamOf` with one grouped query (F5) |
| `lib/dedup/resolve.ts` call site | Candidate retrieval by artifact/token blocking instead of `ORDER BY updated_at DESC LIMIT 500` (F2) |
| `tests/` | A project with >500 items still matches a proposal against an old `done` item |

**Done when:** an MCP read tool touching one project issues no query that scans another
project, and the F2 test passes.

**Failure mode to avoid:** do not "fix" F2 by raising the limit. The bug is that recency
is the wrong axis; artifact overlap is the right one, and it is also what M10 and M11
need, so build it once.

#### M8 — Maturity and resolution (M) — *features 10, 25, part of 1, 4, 5, 21*

| File | Change |
|---|---|
| `db/setup.ts` | `maturity`, `resolution`, `resolution_reason`, `deferred_until` |
| `lib/contracts.ts` | The fields, plus `MATURITIES`, `RESOLUTIONS`; `Command` gains `set_maturity` and `resolve_item` |
| `lib/store.ts` | Agents may not write `accepted`/`committed`; `transition_item` into a terminal state requires (or infers) a resolution |
| `lib/graph/column.ts` | Untouched, deliberately. Maturity is a filter, not a column derivation |
| `app/mcp/route.ts` | `create_work_items` defaults to `proposal`; new `accept_work_items` |
| `app/planbraid-app.tsx` | A Proposals queue; accept/reject in one click; terminal cards show why, not just "cancelled" |
| `tests/maturity.test.mjs` *(new)* | Migration defaults existing rows to `accepted`; an agent principal cannot accept; ready work excludes proposals; a deferred item returns on its date |

**Roll-out:** ship behind `projects.settings.gate_proposals` defaulting **off** for one
release, so nobody's board empties out on deploy. Turn it on once the queue exists.

**Two ways to get this wrong:**
- Defaulting existing rows to `proposal` — every board in existence goes blank.
- Letting `accept_work_items` record `human_approved`. An agent reporting that the user
  agreed is *not* the same evidence as the user clicking accept. Two provenance values,
  always.

#### M9 — Provenance and derived confidence (S/M) — *feature 11*

| File | Change |
|---|---|
| `db/setup.ts` | `work_events.provenance`, `work_events.reason`, `work_items.status_provenance` |
| `lib/trust/provenance.ts` *(new)* | The eight classes, and how each write path maps into them |
| `lib/trust/confidence.ts` *(new)* | The pure derivation in D4 |
| `lib/store.ts` | Every write stamps provenance from the principal and the command |
| `app/planbraid-app.tsx` | Drawer: confidence, its reasons, its sources, and "last confirmed" |
| `tests/confidence.test.mjs` *(new)* | The table |

**Also fixes F4:** `verification_status` stops being written from `status` and starts
meaning what its name says. Anything currently `passed` purely because it was `done`
should migrate to `pending` — surfacing, on purpose, how much completion is unverified.
That number is the argument for Phase C.

### Phase B — The moat

#### M10 — The reconciliation engine (L, multi-milestone) — *feature 2, the core module*

Specified end to end in **`RECONCILIATION_ARCHITECTURE.md`**, which breaks it into E0–E8:
evaluation harness first, then blocking, signature v2, Fellegi–Sunter scoring, relation
typing, the static embedding tier, the agent-judgment tier, repository grounding, and the
unification of Simplify and planning-context onto one `relate()` module.

Two rules from that document belong here, because they constrain everything around them:

**The rule that must not bend:** new relation types may create *edges*. They may never
collapse work that today would be created. `DEDUPLICATION_ARCHITECTURE.md §6.3`'s
asymmetry is unchanged — a false split is one visible card, a false merge is data loss.

**E0 before everything.** The evaluation harness and label capture ship before the
features they judge. Without them the embedding tier's readmission is an assertion, and
`§6.1` exists precisely to stop assertions of that shape.

**E0 through E8 — the full build order — are shipped.** See `RECONCILIATION_ARCHITECTURE.md`'s own "Build
status" section for the full detail. E1's blocking rebuild (artifact + rare-token indices
fused by RRF, old recency fallback fully removed, its own recall@50 gate and harness) is
in, with two real bugs caught and fixed along the way: a shared backfill flag that would
have silently starved the token index for every pre-existing item, and a
`create_work_items` response field that had been coincidentally relying on the old loose
retrieval for correctness. E2's signature v2 (subsystem, criteria, qualifiers, a synonym
lexicon) is computed and tested but deliberately not wired into the matching cascade as a
hard veto — that signal now feeds E3's calibrated scorer instead, the correct place for a
heuristic-derived field to carry a learned rather than guessed weight.

E3's Fellegi-Sunter scorer (`lib/dedup/features.ts`, `fellegi-sunter.ts`, `train.ts`) is
built as a path parallel to the live cascade, not a replacement for it: `checkVetoes()`
was extracted from `match.ts` first so both scorers share one veto implementation rather
than risking two that quietly disagree, twelve comparison features are computed as
discrete, individually-missing-when-unobserved agreement levels, log-odds are summed and
converted to `P(same)` with an overflow-safe sigmoid, and the collapse threshold is derived
algebraically from the asymmetric merge/split cost ratio — confirmed against this
document's own 200:1 → ≈0.995 example rather than picked by feel. A supervised
frequency/MLE training script (`scripts/reconcile-train.mjs`) re-estimates weights from
`reconciliation_labels` directly — the right closed-form estimator here, not an
approximation of unsupervised EM, because Planbraid's labels are actual ground truth, not
latent — and deliberately never overwrites the seed weights automatically; adopting a
trained table is a reviewed, human step. `npm run reconcile:eval` now scores the golden set
with both the cascade and the Fellegi-Sunter path and prints them side by side, which is
what "beats the cascade baseline" (this milestone's own gate) will be measured against
once real labels exist — there is no live production database in this sandbox to run that
comparison against for real today, an honest limitation stated rather than glossed over.

E4's relation typing (`lib/dedup/relations.ts`) fixes finding F3 at the source: an
antonym-action pair that also shares a concrete artifact ("add auth middleware" / "remove
auth middleware" on the same file) now returns a `conflict` verdict from `match.ts`'s
shared `checkVetoes()` instead of collapsing into the same plain `distinct` every other
veto produces — real information that used to be silently discarded, never a false merge
either way. Stage 3 classifies every surviving pair into DUPLICATE, SUBSET, SUPERSET,
OVERLAP, CONFLICT, RELATED, or NEW, and this milestone's own real finding is that two of
the diagram's eight relation types (SEQUENCE, and a subsystem-only flavor of RELATED) are
structurally unreachable without loosening one of the existing *absolute* vetoes — stated
as a verified, tested fact rather than quietly shipped as if working. Typed relations
become real graph edges automatically when a proposal is created alongside a non-duplicate
match (`subset_of`/`superset_of`/`overlaps_with`/`relates_to`, four new
`ANNOTATION_EDGE_TYPES`), and a CONFLICT additionally raises a decision through M19's
existing machinery — the rule that must not bend, above, holds: every one of these creates
an edge or a decision, never a silent collapse. Fixing F3 also surfaced a real bug the
change itself would have introduced: Simplify's own duplicate scan reused the same shared
cascade, and without a fix would have proposed *merging* two items in direct conflict —
caught and fixed with a new informational `conflicting_work` finding before this milestone
shipped, not left for someone to find in production.

E5's static embedding tier is built exactly to §6.1's spec (pgvector `token_vectors` +
`work_item_embeddings`, mean-pooling in place of a neural network, HNSW ANN, fused into
E1's blocking as a third RRF retriever) and fully tested — but its own gate ("ablation
proves the paraphrase case improves; otherwise delete it") is honestly reported as
**unmet**, not glossed over: the real ~8 MB `potion-base-8M` distilled weight table
cannot be downloaded or fabricated in this development sandbox, so `token_vectors` ships
empty and the tier is a genuine no-op in every environment that hasn't loaded real
weights — verified by a dedicated test that `retrieveCandidates`'s output is unchanged
from E1 alone whenever the table is empty. The user was asked directly, given how large
that caveat is, and confirmed building the full pipeline against synthetic vectors rather
than skipping the milestone. `npm run reconcile:eval` now prints the ablation result
labelled "PROVEN" or "NOT YET PROVEN" next to E0/E1/E3's own numbers, so the gate gets a
real answer the moment a real distilled table is loaded, instead of a claim.

E6 builds §9's recommended Tier A exactly as specified: free, because the judging model
is already on the connection. A `possible`-verdict match now returns a precise question
(`needsJudgment`, matching §9's own JSON shape) instead of only a passive note, a new
`submit_reconciliation_judgment` tool records the answer, and answering requires a real
justification — a bare "different" is rejected before the database is even touched,
§9's own honesty rule word for word. Every answer becomes a label in E0's own golden
set rather than a special-purpose store, which is what makes the audit rule ("track
judgment-vs-later-human-split agreement per provider; if a provider's judgments
disagree with humans, down-weight them") a query over existing data instead of new
infrastructure. Deliberately inert beyond capturing that label: no automatic merge, no
automatic edge — §9 itself names the incentive problem ("the proposing agent has a mild
incentive to answer different so its task gets created"), and this milestone declines to
extend that trust any further than recording the evidence. `npm run reconcile:eval` now
reports the escalation rate against its own 5% gate and the provider-agreement audit
next to every earlier stage's numbers.

E7 grounds artifacts in real code, scoped to TypeScript/JavaScript — a user-confirmed
narrowing of §7's general multi-language claim after weighing the real tradeoff directly:
building it meant giving the bridge (previously a genuinely zero-dependency script) an
*optional* tree-sitter dependency and having it read file contents locally to parse them,
where before it only ever read file paths. Both are handled the way this codebase handles
every such tradeoff — opt-in (`npm install` in `integrations/bridge`, a separate step;
the bridge still needs nothing at all without it) and scoped (names, kinds, and file:line
leave the machine, never source text, keeping faith with the bridge's existing "never file
contents or diffs" guarantee). Verified against this repository's own source before any
server-side code existed, not assumed to work: the exact `web-tree-sitter`/
`tree-sitter-wasms` version pairing that actually parses correctly was confirmed directly
first, after a newer default combination silently failed to load at all. f4 (symbol
overlap, E3's scorer) now distinguishes a name confirmed against real code from one that's
merely spelled the same, with the confirmed case carrying the strongest weight in the
whole seed table — §7's "highest-precision feature" claim, made real rather than
aspirational. The subsystem prefix-tree refinement §7 also describes is explicitly not
built in this pass: a real algorithm in its own right, not a small addition, and better
built once `repo_symbols` has accumulated real coverage than rushed alongside the parsing
infrastructure.

E8 closes the loop §10 opens: one `relate(A, B)` module (`lib/dedup/relate.ts`),
`create_work_items` (already, via `resolve.ts`'s `bestMatch`/`classifyRelation`) and
Simplify (now, replacing the `adjudicate(..., fingerprintValue: "")` workaround §10 calls
out by name) both routed through it. Planning context is the one deliberate exception,
and the reasoning is worth stating plainly because it looks at first like unfinished
work rather than what it is: forcing its relevance ranking through the same vetoed
cascade broke a real, already-passing test — an objective and an existing item sharing
one exact file but using incompatible verbs ("update" vs. "investigate"), which
`checkVetoes` correctly rejects for *duplicate detection* but which is exactly the kind
of background a person planning next work should still see. Planning context answers a
broader question than the other three callers, and keeping its scorer more permissive
is the correct outcome of applying §10's own discipline, not an exception to it. What
did unify: planned items now get checked for a `CONFLICT` relation specifically, on top
of the existing broad relevance gate, so a genuine planning-time conflict is no longer
invisible to this tool. `lib/planning/collision.ts` (a different question — live-lease
collision, not relatedness) and `lib/dedup/labels.ts` (already routed through
`adjudicate()` directly) needed no changes at all. "Plan merge," §10's fourth named
caller, remains unbuilt and out of scope.

With E8 shipped, every stage of `RECONCILIATION_ARCHITECTURE.md`'s build order — E0
through E8 — exists in the codebase, tested, with each stage's own gate addressed
honestly: several (E3's cascade-beating claim, E5's and E7's precision-lift claims)
remain measured as **not yet proven**, because proving them needs real production
labels and real distilled weights this development environment cannot produce — stated
plainly at each stage, with `npm run reconcile:eval` already wired to report a real
verdict the moment that data exists, rather than left as a claim.

#### M11 — Pre-planning intelligence (M) — *feature 3. The one to build if only one gets built.*

| File | Change |
|---|---|
| `lib/planning/context.ts` *(new)* | Retrieval: `buildSignature` over the agent's objective, ranked against project work by artifact overlap, then bucketed by status, maturity, and resolution |
| `app/mcp/route.ts` | `get_planning_context`; `instructions` and the `plan_project_work` prompt updated to require it before proposing |
| `tests/planning-context.test.mjs` *(new)* | Rejected work appears with its reason; in-progress work by another live session appears with the holder; irrelevant work does not appear |

Response shape, matching the roadmap's own example:

```jsonc
{
  "objective": "improve authentication",
  "alreadyDone":   [{ "itemKey": "#21", "title": "RS256 migration", "verifiedBy": "commit 839fa2" }],
  "inProgress":    [{ "itemKey": "#31", "heldBy": "Codex · work", "since": "2026-08-12T19:32:00Z" }],
  "planned":       [{ "itemKey": "#35", "maturity": "accepted" }],
  "blocked":       [{ "itemKey": "#36", "waitingOn": ["#35"], "why": "needs the token persistence schema" }],
  "rejected":      [{ "itemKey": "#12", "resolution": "rejected", "reason": "shared HS256 secrets break service isolation" }],
  "openProposals": [{ "itemKey": "#44", "proposedBy": ["Claude", "Gemini"], "timesProposed": 3 }],
  "decisionsOpen": [{ "itemKey": "#40", "question": "Redis or Postgres for session storage" }],
  "guidance": [
    "Do not re-propose #21 or #31.",
    "#36 depends on #35; plan them in that order.",
    "HS256 was rejected on 2026-07-30 — do not re-propose it without new argument.",
    "Codex · work is holding #31; coordinate before touching auth.service.ts."
  ]
}
```

`guidance` is the part that matters and the part that is easy to get wrong. It must be
generated from facts already in the payload, never from a template that fires when the
bucket is empty. An agent that reads three lines of guidance and skips the structured
data is the expected behaviour, not the failure case — so the guidance has to be true.

**Done when:** in the two-agent scenario, the second agent's plan references the first
agent's item keys instead of restating them, with no human in between.

#### M12 — Why-not-done (M) — *features 5, 4-of-the-seven*

`explain_work_item` walks: resolution → blocker chain (the traversal already exists in
`findBlockedChains`) → active lease → last event with a reason → evidence state, and
returns the first true cause with its provenance and author. Nine distinguishable
answers — not started, blocked by #N, deferred until D, rejected because R, superseded
by #M, abandoned, attempted and failed, being implemented by A, implemented but
unverified — every one of which the data already supports once M8 and M9 land.

Also surfaced in the drawer, because the person looking at a stalled card has exactly
this question.

#### M13 — Handoff packages (S) — *feature 15*

`get_handoff_package(project_id | work_item_id)` — M11's retrieval, re-serialized, plus
a **Do NOT redo** section built from verified-complete work. Free once M11 exists; it is
the demo that sells the product, so give it a UI button that copies the package to the
clipboard for pasting into any agent that is not connected yet.

#### M21 — Planning-loop detection (S) — *feature 17. Pulled forward from P3 on cost.*

The data is already in `work_item_aliases`. A loop is: an item with ≥3 aliases from ≥2
provider families spanning ≥N days, with zero `work_item.started` events and zero
evidence. That is one query and one finding kind in the existing Simplify pipeline, and
it is one of the seven differentiators. Building it after the P1s would be pricing it by
its label rather than its cost.

### Phase C — Grounding in reality

#### M14 — Leases and collision detection (M) — *features 12, 13*

| File | Change |
|---|---|
| `lib/store.ts` | `start_work` writes `work_claims` with an expiry; heartbeat extends; `end_agent_session` releases; **readers filter on `lease_expires_at > now()`** so no scheduler is needed |
| `lib/store.ts` | `getReadyWork` reads claims instead of `current_task_ids` |
| `lib/planning/collision.ts` *(new)* | Artifact-set intersection between a proposed scope and live claims — feature 13 v0, free from signatures already computed |
| `app/planbraid-app.tsx` | Agents view shows who holds what and for how long |
| `tests/leases.test.mjs` *(new)* | Expired leases do not block; force is recorded; a crashed session's claim frees itself |

Default lease: 45 minutes, extended on heartbeat. Long enough for a real task, short
enough that an abandoned session stops mattering before anyone notices.

#### M15 — Repository observations via the bridge (L) — *features 6, 7, 20; D5*

| File | Change |
|---|---|
| `integrations/bridge/planbraid-hook.mjs` | At turn end: HEAD sha, branch, `git diff --name-only` vs merge base, and the exit status of a configured verification command. Paths only, capped, opt-out via env |
| `app/mcp/route.ts` | `report_repo_state` |
| `lib/evidence/ingest.ts` *(new)* | Observations → `repo_observations`, and → `evidence` on items whose artifacts intersect the changed files |
| `tests/repo-observations.test.mjs` *(new)* | Idempotent per sha; unrelated commits attach to nothing |

**Privacy is a feature here, and it must be stated in `integrations/README.md`:** file
paths and commit metadata, never contents, never diffs. The bridge's existing promise —
"never opens provider transcript files" — is the standard to hold.

#### M16 — Evidence-backed completion (M) — *feature 6*

Evidence gains a kind taxonomy and a `verification` state. `completion_confidence`
becomes derived: `reported` (claim only) → `supported` (evidence attached) →
`corroborated` (evidence authored by a different actor than the claimant) → `verified`
(machine-checked: the commit exists and touches the claimed scope; the test command
exited 0).

And the gate: **`report_completion` lands in `in_review`; `done` is reached by a human,
or by the verifier when machine evidence passes.** See §9, decision 1 — this changes
agent workflows and is the user's call, but it is the whole point of feature 6.

#### M17 — Divergence detection (M) — *feature 7*

Two new Simplify finding kinds over `repo_observations`:
`possibly_implemented` (an item is `planned`, and commits touching its artifacts landed
after it was proposed) and `evidence_removed` (an item is `done` with file evidence, and
a later commit deleted or emptied those files). Both are informational and propose a
transition the user applies — never automatic. The existing findings pipeline,
persistence, agreement and apply path all carry them unchanged.

#### M18 — GitHub App expansion (L, optional) — *feature 20*

Only after M15–M17 have proven the value. Adds `contents/pull_requests/checks: read`
plus push, PR and check-suite webhooks, giving PR and CI state for teams. **Explicitly
not built:** one-task-one-issue synchronization. The roadmap is right that they are
different abstractions, and two-way sync between two systems of record is a permanent
tax.

### Phase D — Coordination, governance, and the analytics layer

#### M19 — Decisions and conflicts (M) — *features 8, 9*

A conflict is a work item of `type='decision'` with `conflicts_with` edges to the
competing items and rows in `decision_options`. It gets the board, the event log, the
provenance, and the notification path for free — no parallel entity. Raised
automatically by M10's `CONFLICTS` classification, and manually by either an agent or a
person. Resolution is browser-principal-only (D1 rule 2), and it writes a `supersedes`
edge to the losing approach so a future agent proposing it hits M11's `rejected` bucket
with a reason. That closes the loop the roadmap's core principle describes.

#### M20 — Objectives (M) — *feature 1*

Objectives are `work_items` with `type='objective'`, referenced by `objective_id` rather
than the ambiguous `parent_id` (finding F7, which §13 requires be settled either way).
They matter to the reconciliation engine before they matter to the UI: **objective is one
of the twelve comparison features and one of the four vetoes** — two proposals under
different known objectives are not the same work, cheaply and reliably.

Plan *lineage* is no longer part of this milestone. It moves to M25, where a revision is a
range of operations rather than a second hierarchy to maintain.

Should not start until M11 has shown whether agents actually group work under objectives
or just emit flat lists — but note that if they do not, the engine can infer objectives
by clustering on the subsystem and dependency features, which is a cheaper experiment than
asking agents to change how they plan.

#### M22 — Planning debt and health (M) — *features 16, 18*

Both are rollups of open Simplify findings, weighted by kind. **Build the debt list
before the score.** A single number invites gaming and hides the actionable part; the
list is what a person acts on. If the score ships, it ships as the sum of a visible
breakdown, never as an opaque 82.

#### M23 — Query surfaces (M) — *feature 19, per D3*

Saved views over the structured state: what's active, what's blocking release, what
keeps getting proposed, what has no proof, what needs a decision. No prose parsing.

#### M25 — Plan operation log (L) — *features 4, 5, 8, 9, 11, 14, 25*

`PLAN_VERSION_CONTROL.md`. Content-addressed operation log written alongside existing
mutations, conflicts as first-class objects, and plan lineage as a query over the log
rather than a separate table. Absorbs M20's `plan_revisions` design — build the log
instead. Session branches and plan merge come after, and only once the reconciliation
engine can serve as the merge function.

*(Multi-user and roles are out of scope this phase — see §9.)*

---

## 8. The seven differentiators, mapped

| # | Differentiator | Milestone(s) | Cost |
|---|---|---|---|
| 1 | Semantic plan reconciliation | **E0–E8** (`RECONCILIATION_ARCHITECTURE.md`) | L — the core module; everything else consumes it |
| 2 | Pre-planning intelligence | **M11** + **C1** (injected by hook) | M — best return in the document |
| 3 | Plan lineage | **M25** (needs M9) | L — the op log, not a revisions table |
| 4 | Why-not-done reasoning | M8 + M12 | M |
| 5 | Evidence-backed completion | M15 + M16 + **C3** | L |
| 6 | Cross-agent coordination (one user, many agents) | M14 + **C7** | M |
| 7 | Planning-loop detection | **M21** | S — cheapest of the seven |

If resources are severely limited: **M7 → M8 → E0 → M11 + C1 → M21**. That is a
project-scoped read path, a maturity ladder, the measurement harness that makes the core
module improvable, pre-planning context delivered automatically by hook, and loop
detection. Roughly three weeks, two of the seven differentiators, the end of graph
pollution, and — critically — the evaluation loop that lets the core module get better
every week after that. Everything else in this document is an amplifier on those.

---

## 9. Open decisions

Five questions where different answers produce materially different builds. Each has a
recommendation; the plan above assumes the recommendation. Decision 4 is settled.

1. **Can an agent ever move work to `done` on its own evidence?**
   *Recommended: no, once M16 lands.* `report_completion` always lands in review; `done`
   requires a human or a passing machine check. This is the entire content of feature 6
   — "Claude says it finished" must stop being sufficient — but it changes every
   connected agent's workflow and will feel like friction before the verifier is good.
   Mitigation: ship M15's verifier first so the automatic path exists before the manual
   gate closes.

2. **Do agent proposals stop appearing on the board by default?**
   *Recommended: yes, but one release later.* Ship M8 with the gate off, the Proposals
   queue visible, and a banner. Turn it on when the queue has been used. Turning it on
   at launch makes a working board look broken.

3. **Bridge-first or GitHub-first for code truth?**
   *Recommended: bridge-first (D5).* GitHub-first requires a scope escalation on an
   unproven feature and excludes local and non-GitHub work. The bridge already runs in
   the right place.

4. **Multi-user — decided: out of scope.** Teams, roles, shared projects and human
   permissions are deferred until the single-user product is sharp. Two consequences to
   hold to, so the deferral stays cheap:
   - **Every new table keeps `organization_id`.** The schema is already multi-tenant
     shaped; the only real blocker is that `organizations.owner_user_id` is `UNIQUE` and
     `organizationFor()` derives the organization from the user. Nothing else needs to
     change later if nothing else assumes one user.
   - **Do not write single-user assumptions into the new surfaces.** Notifications,
     leases, decisions and the op log all carry an actor already; keep them actor-keyed
     rather than "the owner".

   Agent permissions are *not* deferred — they ship in M8 as a principal check, and they
   are the half of feature 21 that matters with one human.

5. **How hard should capture enforcement be at launch?**
   *Recommended: L0 and L1 on by default, L2 opt-in for one release, L3 off.* Injection
   and observation are pure upside and invisible. Gating the `Stop` event changes how the
   agent behaves and should not ship before the recorded state is good enough to justify
   holding someone to it. See `CAPTURE_ARCHITECTURE.md §10`.

---

## 10. What we are deliberately not building

Extending `IMPLEMENTATION_PLAN.md §10`, which stands unchanged.

| | Why |
|---|---|
| **Twelve raw statuses** | D1. Two orthogonal columns express all of them and touch none of the shipped state machine |
| **Hosted embedding APIs** | Every cost `§6.1` listed is a cost of the *API*, not of the vector. A static, owned, in-deployment embedding is admitted (D2); a network call on the write path is not |
| **Transformer inference in the request path** | `onnxruntime-node` is ~720 MB uncompressed against a 250 MB function limit. It does not deploy, before it is slow |
| **A hosted LLM on the write path** | D3. Nondeterminism in the one decision that must be reproducible, to do work the connected agent does better and for free |
| **GraphQL** | Nothing has asked for a second query shape. REST over `executeCommand` when a second consumer exists |
| **Graph visualization** | Unchanged from `§10` — the board is the graph, projected. M11 and M12 answer the questions people think they want a canvas for |
| **1 task = 1 GitHub issue** | Different abstractions. Two-way sync is a permanent tax. Git is authoritative for *implementation state*, not for the plan's identity (`PLAN_VERSION_CONTROL.md §5`) |
| **A separate `plans` table** | A plan is a range of operations on a branch. M25 stores the log; lineage is a query |
| **Teams, roles, shared projects** | Decision 4. Single user until the single-user product is sharp |
| **A health score before a debt list** | M22. The number without the breakdown is worse than nothing |
| **Auto-resolved conflicts** | A conflict is a legitimate state, not a merge failure. It stays open until a decision closes it, and the resolution is recorded against the pair so it never reopens |

---

## 11. Risks

| Risk | Where it bites | Mitigation |
|---|---|---|
| **Agents ignore `get_planning_context`** | M11 delivers nothing | The tool description is the product. Put it in `initialize.instructions`, the `plan_project_work` prompt, and `AGENTS.md`. Measure: proposals arriving with no prior context call in the same session |
| **The maturity gate empties boards** | M8, on deploy | Default existing rows to `accepted`; ship the gate off; one release of overlap |
| **M10 loosens the vetoes** | Silent false merges — the one error class this codebase has consistently refused | New classifications may only create edges, never collapse. Every existing dedup test must pass untouched |
| **Bridge git calls slow the agent's turn** | M15, every turn, every user | The bridge already caps itself at a 2.5s timeout and degrades with a warning. Hold that budget; run git calls in parallel; never block the turn |
| **Confidence and health scores become theatre** | M9, M22 | Both derived, both with reasons attached, never a bare number |
| **Objectives are modelled before agents use them** | M20, the largest milestone | Gate M20 on evidence from M11 that agents actually group work |
| **`loadDashboard` becomes the wall** | Everywhere, quietly | M7, first, before six new readers exist |

---

## 12. Order, in one picture

```
A  M7  scoped reads       ─┐ nothing is safe to build on the current read path
   M8  maturity ladder     ├ feature 10 gates 3, 9, 17, 21, 25
   M9  provenance         ─┘ feature 11 gates 6 and every trust claim
   F   finish the half-built (§13) — runs alongside A, not after it

B  E0  eval harness       ─┐ the core module, RECONCILIATION_ARCHITECTURE.md
   E1  blocking            │  E0 first: without measurement, E3/E5 are unfalsifiable
   E2  signature v2        │
   E3  Fellegi–Sunter      ├ the moat
   E4  relation typing     │
   E5  static embeddings   │
   E6  agent judgment      │
   E7  repo grounding     ─┘

   C0  capture probe      ─┐ CAPTURE_ARCHITECTURE.md — runs in parallel with E
   C1  L0 injection        ├ C1 delivers M11 with no agent cooperation
   C2  todo mirroring      │
   C3  tool observation   ─┘

   M11 planning context   ─┐
   M12 why-not-done        ├ what the moat is *for*
   M13 handoff             │
   M21 loop detection     ─┘

C  M14 leases + collision ─┐
   C4  outbox              ├ grounding: planning meets code
   M15 repo observations   │
   M16 verified completion │
   M17 divergence          │
   C5  L2 gating           │
   M18 GitHub (optional)  ─┘

D  M19 decisions          ─┐
   M25 plan operation log  ├ substrate and analytics
   E8  unify relate()      │  PLAN_VERSION_CONTROL.md
   M22 debt + health       │
   M23 query surfaces     ─┘

   later: session branches, plan merge, in-repo projection, teams
```

The through-line, and the test for anything proposed later: *does this help the next
human or agent make a better plan from what the project already knows?* M11 is that
question answered literally, which is why it is the one milestone in this document that
should not slip — and C1 is why it will not depend on an agent remembering to ask.

---

## 13. Finish what is half-built, precisely

An unfinished mechanism costs more than a missing one — it is already running, already
affecting behaviour, and already unable to explain itself. `IMPLEMENTATION_PLAN.md §3`
made that argument for M0; it applies with more force now, because eight of the roadmap's
features are *extensions of things that are half-wired today*.

Each item below gets a definition of done, not a description. This work runs alongside
Phase A.

| | Half-built thing | Current state | Done when |
|---|---|---|---|
| **F1** | `work_claims` | Table with lease columns; never written or read | `start_work` takes a lease; heartbeat extends; readers filter on `lease_expires_at > now()`; a crashed session's claim frees itself with no scheduler; `current_task_ids` is no longer the collision source |
| **F2** | Dedup candidate retrieval | `ORDER BY updated_at DESC LIMIT 500` silently drops old `done` work | Blocking is index-driven (E1); a project with 5,000 items still matches a proposal against a two-year-old completed task; measured blocking recall ≥ 99% |
| **F3** | Antonym adjudication | Returns `distinct`, so "Add X" vs "Remove X" on one file are unrelated | Antonym + overlapping artifacts produces `CONFLICT`, opens a `plan_conflict`, and raises a decision item; antonym + disjoint artifacts still returns `distinct`; both cases tested |
| **F4** | `verification_status` | Set to `passed` because the status became `done` | Written only by a verifier or a human; existing rows migrated to `pending`; the count of unverified "done" items is visible in the UI and is the argument for Phase C |
| **F5** | `getReadyWork` unlock counts | `downstreamOf` per candidate, N+1 | One grouped query; ranking output byte-identical to today's on the existing tests |
| **F6** | `loadDashboard` on MCP reads | Loads every project in the org, filters in JS | No MCP read tool touches a project the caller did not ask for (M7) |
| **F7** | `work_items.parent_id` | Declared, mapped into `WorkItem`, never written | Either it carries hierarchy with a defined meaning, or it is removed and `objective_id` replaces it. **Not both.** Ambiguity here is why nobody has used it |
| **F8** | `recomputeBlockingCounts` | Correct and tested; only called by merge and split | Runs on a schedule or on a drift signal, emits a repair event when it changes anything, and has a test that injects drift and proves it heals |
| **F9** | Interaction reconciliation | `todos_changed` inferred by counting events in a time window | Events are attributed by `interaction_id`, not by clock; overlapping interactions from one source no longer cross-attribute |
| **F10** | Simplify's `agreed_by` / `origin` | Columns exist; the "a connected agent contributes to the same run" design in the schema comment is unimplemented — nothing ever writes them | An MCP tool lets an agent add or corroborate a finding on the open run; `agreed_by` accumulates distinct provider families; the UI shows "Claude and Codex both flagged this" |
| **F11** | `evidence.type` | Free text; any evidence flips `completion_confidence` to `supported` | A closed taxonomy with a verifiability class per kind (M16); confidence derived, not assigned |
| **F12** | `sources.assurance` | Four honest values, close to decorative | Wired to which capture layers are actually live for that agent (`CAPTURE_ARCHITECTURE.md §3.3`), and shown per agent |
| **F13** | `work_items.type` | Defaults to `task`; nothing writes another value | `objective`, `decision` and `bug` are real, with the board and the brief handling each |
| **F14** | Duplicated matcher rules | `analyze.ts` calls `adjudicate` with `fingerprintValue: ""` and re-implements the identical-signature case | One `relate()` module, one weight file, one harness (E8); Simplify and `create_work_items` can no longer disagree in front of a user |

Two rules for this list. **Nothing here ships without a test that fails before the fix** —
several of these are silent, and a silent bug fixed without a regression test is a silent
bug scheduled to return. And **F7 must be decided, not deferred again**: a column that has
been declared and unused across three architecture documents is a decision nobody has
made, and it is now blocking objectives.
