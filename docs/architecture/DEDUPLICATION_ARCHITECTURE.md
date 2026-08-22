# Planbraid Deduplication Architecture

How overlapping plans from independent agents collapse into one canonical task set,
so that connecting a fifth agent adds signal instead of clutter.

Companion to [`GRAPH_ARCHITECTURE.md`](./GRAPH_ARCHITECTURE.md). Both concern the
`create_work_items` write path and must be sequenced together (§9).

---

## 1. The scenario

Claude plans 5 tasks. Ten minutes later Codex plans 4, of which 3 restate Claude's in
different words and 1 is genuinely new. Today the board shows 9 cards.

What should happen: the board shows 6 cards, Codex's 3 restatements attach to Claude's
originals as alternate phrasings, any detail Codex added that Claude missed is captured,
and the 3 matched tasks are now marked as *independently proposed by two agents* —
which is a stronger signal than either proposal alone.

What must **not** happen: Codex's work silently disappears, or an agent starts working
on a task ID that was merged out from under it.

---

## 2. This collides with a stated non-goal — and the resolution matters

`PRODUCT_ARCHITECTURE_PLAN.md:106` lists under **Non-goals**:

> automatically merging semantically similar work without confirmation

And `:1744`, on concurrent plan creation:

> no automatic semantic merge or deletion occurs

Taken literally, this request is forbidden. Taken as intent, it isn't — and the
distinction is the entire design.

The non-goal exists to prevent **destructive, unreviewable merges of canonical work**.
A false merge means an agent works on the wrong task, or a real task vanishes. That
failure is expensive and silent, and guarding against it is correct.

But there is a second thing the plan already asks for, in the `create_work_items`
contract itself (`PRODUCT_ARCHITECTURE_PLAN.md:449`):

> Output: created/**matched** IDs and any duplicate warnings.

Matching an *incoming proposal* against existing canonical work is not the same
operation as merging two canonical items. The proposal has no ID yet, no status, no
history, and nothing depends on it. Canonicalizing it destroys nothing.

**The resolution: never destroy, always canonicalize.**

| | Merging two canonical items | Canonicalizing an incoming proposal |
|---|---|---|
| Both sides have history, edges, claims | yes | no — one side is 3 seconds old |
| Reversible without data loss | hard | trivial |
| Plan's stance | requires confirmation (`:1744`) | explicitly in the tool contract (`:449`) |
| Where it runs | async job → Inbox | synchronously, inside the write |

Everything below concerns the second column. The first column keeps the plan's async
review flow unchanged.

Two consequences follow, and they do all the work:

1. **Every proposal from every agent is recorded, always.** Provenance is this
   product's thesis — "what did Codex propose?" must remain answerable. Nothing is ever
   dropped on the floor.
2. **Being recorded is not the same as being a board card.** A matched proposal is
   stored as an *alias* attached to the canonical item. The board shows 6 cards because
   there are 6 tasks, not because 3 rows were deleted.

That gets the uncluttered board the request is actually about, while a wrong match
stays fully reversible.

---

## 3. Why the timing has to be synchronous

The plan specifies asynchronous similarity detection (`:332`). For **suggesting merges
between existing items**, async is right — it never blocks a mutation.

For incoming proposals it is too late. The sequence that breaks:

1. Codex calls `create_work_items`, gets back 4 fresh IDs.
2. Codex calls `start_work` on one of them and begins editing files.
3. The async dedup job runs and decides that item was a duplicate of `#7`.
4. Now there are two agents working the same task under two IDs, and reconciling means
   merging *canonical* items with live claims — precisely the expensive case the
   non-goal is protecting.

Matching must happen **before IDs are handed out**, inside the same transaction, so the
agent receives `#7` and works on `#7`. The write path becomes:

```
create_work_items(items[])
  → normalize each item into a signature          (§4)
  → generate candidates from the project          (§5)
  → score and adjudicate                          (§6)
  → per item: create new | attach as alias to existing
  → resolve in-batch dependency refs against the final IDs   (GRAPH_ARCHITECTURE §7.2)
  → one db.batch(): items, aliases, edges, events, idempotency
  → return a merge report the agent can act on    (§7)
```

---

## 4. Task identity: why embedding similarity alone fails here

The instinct is to embed the title and threshold on cosine similarity. On task titles
this performs badly, and understanding why determines the whole design.

Task titles are short, templated, and share heavy vocabulary within a project. The
discriminating information sits in two or three tokens. Embeddings capture **topic**,
which is exactly the part that is already shared.

| Pair | Cosine | Truth | Verdict |
|---|---|---|---|
| "Add rate limiting to `/api/login`" vs "Add rate limiting to `/api/signup`" | ~0.95 | **different** | embedding says merge — wrong, and costly |
| "Add auth middleware" vs "Remove auth middleware" | ~0.93 | **opposite** | embedding says merge — wrong |
| "Write tests for the parser" vs "Fix the parser" | ~0.80 | **different** | embedding ambiguous |
| "Add rate limiting to login endpoint" vs "Implement throttling on the sign-in route" | ~0.75 | **same** | embedding says split — the case embeddings should win, and it's the weakest score in the table |

The ordering is inverted. The pairs embeddings are most confident about are the ones
it gets wrong, and the pair it should catch scores lowest.

The pattern: **task identity is (action, object, artifacts), and embeddings only see
the object.**

### 4.1 The task signature

Normalize each incoming item into a structured signature rather than a single vector:

```ts
type TaskSignature = {
  action:    ActionClass;   // add | remove | fix | test | document | refactor
                            // | investigate | configure | deploy | review
  object:    string;        // lemmatized head noun phrase — "rate limiting"
  artifacts: string[];      // concrete refs, sorted: ["/api/login"]
  qualifiers: string[];     // scope narrowing — ["mobile", "production"]
  raw:       string;        // original title, kept for display and alias storage
};
```

**Artifacts** are the highest-value extraction and need no ML — a handful of regexes
over text agents already write in a predictable style:

- file paths (`lib/store.ts`, `src/**/*.tsx`)
- endpoints (`/api/login`, `POST /users/:id`)
- code symbols (backticked, `camelCase`, `PascalCase`, `snake_case` identifiers)
- item keys (`#12`), error strings, env var names, table/column names

**Action classes** need a synonym lexicon, not a model. `add ≈ implement ≈ create ≈
build ≈ introduce`; `fix ≈ repair ≈ resolve ≈ patch`; `remove ≈ delete ≈ drop ≈ strip`.
A few dozen entries covers nearly all agent-authored task titles, which are strikingly
formulaic.

### 4.2 The veto rules do most of the work

Two rules, both cheap and both purely lexical, resolve the majority of hard cases:

```
VETO 1 — artifact mismatch
  both signatures have non-empty artifacts AND the sets are disjoint
  → NOT duplicate, regardless of any similarity score

VETO 2 — action opposition
  action classes are in an antonym pair (add/remove, enable/disable, open/close)
  → NOT duplicate, regardless of any similarity score
```

Veto 1 kills the `/api/login` vs `/api/signup` case. Veto 2 kills add-vs-remove. These
are the two failure modes that make naive similarity matching dangerous, and neither
requires a model, an API key, or a millisecond of latency.

A veto is a hard gate, not a subtracted weight. A weighted sum would let a 0.95 cosine
overwhelm an artifact mismatch — which is the exact wrong behavior, because the
artifact mismatch is the *more reliable* signal.

---

## 5. Candidate generation

Never score against everything. Restrict to:

- **the same project.** "Set up CI" in two projects are two different tasks. Note the
  existing `resolve_project` fuzzy matcher (`worker/index.ts:149-155`) is the only
  matching logic in the codebase today, and it is project-scoped for the same reason.
- **non-archived items**, any status.

That last point is worth dwelling on. The instinct is to match only against open work.
But **matching against `done` items is the more valuable case**: if Claude already
completed the task Codex is now proposing, catching it prevents redundant *work*, not
just a redundant card. The right response there isn't a silent merge — it's telling
Codex "this was completed 20 minutes ago, here is the evidence," which is the single
most useful thing this product can say to a second agent.

At realistic project sizes (hundreds of items) signature comparison against every
candidate is microseconds — no blocking index needed. Add trigram or rare-token
blocking only if a project passes a few thousand items, and note that
`loadDashboard` (`lib/store.ts:132`) will have become the binding constraint long
before the matcher does.

---

## 6. The adjudication cascade

Ordered, with early exits. Cheapest and most decisive first.

```
1. fingerprint(a) == fingerprint(b)                → DUPLICATE  (1.00, exact)
2. VETO 1 or VETO 2 fires                          → DISTINCT   (hard)
3. artifacts match exactly && actions compatible   → DUPLICATE  (0.95)
4. token overlap high, or shared artifacts         → POSSIBLE   (flagged, never collapsed)
5. otherwise                                       → DISTINCT
```

Every step is string work. No model, no API key, no network call, no latency.

### 6.1 Embeddings were built, measured, and removed

The semantic tier described in §4 was implemented — external embedding API, vectors as
D1 BLOBs, brute-force cosine — and then deleted. The reasoning is worth keeping, because
the instinct to add it back will recur.

**It did not earn its cost.** In end-to-end testing of the exact multi-agent scenario in
§1, every duplicate resolved structurally, with the embedding path disabled. Of the
matching test suite, exactly one case genuinely required a vector: pure paraphrase with
zero shared vocabulary ("rate limiting on the login endpoint" vs "throttling on the
sign-in route").

**There is a structural reason to expect that, not just an accident of the sample.**
Independent agents planning against the *same repository* read the same file names,
symbols, and README, so they converge on that codebase's vocabulary. Both say "rate
limiting" because that is what the code calls it. The condition that makes embeddings
valuable — different people describing one thing in unrelated words — is exactly the
condition a shared codebase suppresses. Meanwhile task identity turns on concrete tokens
(`/api/login`, `lib/store.ts`) that embeddings actively blur, which is why §4's table
shows the ordering inverted.

**What it cost:** an external API dependency and key on the write path, a timeout and a
failure mode, a table, four environment variables, a billing surface, and — because the
API call ships task titles off-machine — a privacy leak that would have to be solved
separately for any local or self-hosted deployment.

**What it bought:** one case, of unproven frequency.

The residual is also measurable for free. Near-misses are surfaced as `possible`
(§6.2), so real usage will show how often true duplicates are being split. If that
number turns out to be significant, revisit — and prefer a small domain synonym list
("throttle"→"rate limit", "sign-in"→"login") over embeddings, since the vocabulary of
software tasks is small, closed, and inspectable in a way a vector space is not.

### 6.2 Two outcomes, not three

The agent-facing contract is binary: an item was **created** or it **matched** existing
work. Confidence bands are an implementation detail and do not belong in the API.

An earlier design exposed a third `uncertain` state, which pushed an adjudication the
server could not make onto an agent that could not act on it either. Now a resemblance
below the matching bar simply creates the item and attaches a `resembles` note naming
what it looks like. The agent proceeds either way; the note is information, not a
decision point.

Humans see the same simplification: a card shows "also proposed by Codex," never a
similarity score. `0.87` means nothing to a person. "Same endpoint `/api/login`" does.

### 6.3 Thresholds cannot be guessed — and the costs are asymmetric

The two error types are not equally bad:

| Error | Consequence | Detectability |
|---|---|---|
| **False merge** (said same, actually different) | A task silently vanishes; an agent works the wrong item | Low — nobody sees a card that was never created |
| **False split** (said different, actually same) | One duplicate card | High — visible on the board, fixable in one click |

A false split is the status quo everywhere, and survivable. A false merge is data loss.
**Bias hard toward splitting**: collapse only on exact fingerprint or exact artifact
match with a compatible action. Everything else creates.

Then make thresholds empirical rather than guessed. Every merge that a user later
splits, and every `possible` they confirm, is a free label collected as a side effect of
normal use.

## 7. What `create_work_items` returns

The report is the contract. It must let the agent proceed without a second round trip.

```jsonc
{
  "results": [
    { "ref": "auth",  "status": "created", "workItemId": "wi_a1", "itemKey": "#12" },
    { "ref": "rate",  "status": "matched", "workItemId": "wi_07", "itemKey": "#7",
      "matchScore": 0.95, "matchMethod": "artifact",
      "explanation": "Same action (add) and artifact (/api/login) as #7, proposed by Claude 11 minutes ago.",
      "deltaCaptured": ["Added acceptance criterion: 429 with Retry-After header"] },
    { "ref": "cache", "status": "matched", "workItemId": "wi_03", "itemKey": "#3",
      "matchScore": 1.0, "matchMethod": "fingerprint",
      "warning": "#3 is already done. Verified 20 minutes ago with evidence: PR #88." },
    { "ref": "docs",  "status": "created", "workItemId": "wi_a2", "itemKey": "#13",
      "resembles": { "itemKey": "#9", "workItemId": "wi_09",
                     "note": "Overlapping wording as #9 \"Document the retry policy\" (ready)." } }
  ],
  "summary": { "created": 3, "matched": 2 }
}
```

Four things this shape gets right:

- **`matched` returns a usable ID.** The agent proceeds against `#7` with no second call.
- **`explanation` is human-readable and cites the evidence.** An agent handed a bare
  score cannot reason about it; one told *"same artifact `/api/login`, proposed by Claude
  11 minutes ago"* can, and so can the user reading the activity feed.
- **The already-done warning is the highest-value output in the whole system.** It
  stops duplicate *work*, not just a duplicate card.
- **Ambiguity never blocks.** A resemblance below the bar still creates the item and
  attaches a note. The default is always the cheap error, never the expensive one.

---

## 8. Storage, delta capture, and the consensus signal

### 8.1 Aliases

```sql
CREATE TABLE work_item_aliases (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL,
  work_item_id     TEXT NOT NULL,   -- the canonical item
  title            TEXT NOT NULL,   -- the alternate phrasing, verbatim
  description      TEXT NOT NULL DEFAULT '',
  source_id        TEXT,            -- which agent proposed it
  interaction_id   TEXT,            -- which turn
  match_score      REAL NOT NULL,
  match_method     TEXT NOT NULL,   -- fingerprint | artifact | semantic | agent | human
  confirmed_at     TEXT,            -- null = provisional, reversible
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_aliases_item ON work_item_aliases(work_item_id);
```

An alias, deliberately, is **not** a work item. Making the duplicate a real row plus a
`duplicates` edge means it carries a status and a version, appears in counts, board
queries, `list_work_items`, and the graph — and every one of those call sites then needs
a filter. The bug is not whether you remember the filter today; it is that you must
remember it forever, in code neither you nor the agents have written yet.

The `duplicates` edge type in `dependencies` still has its place: two items that each
became canonical independently and were *later* found to overlap. That path keeps the
plan's async, confirmation-required merge flow (`:1744`) untouched.

### 8.2 Capturing the delta

The "take the part that isn't the same" requirement. When a proposal matches but carries
content the canonical item lacks:

1. **Alias row** stores the alternate title verbatim — always, unconditionally. This is
   both the audit trail and free training data for the matcher.
2. **Novel description content** is appended as an attributed note through the existing
   `add_note` command (`lib/store.ts:265-277`), which already writes a `work_event` with
   source attribution. No new machinery: *"Codex proposed this with additional scope:
   must return 429 with a `Retry-After` header."*
3. **If the delta is independently actionable** — an imperative clause whose artifacts
   aren't in the canonical item — propose it as a **child item** via `parent_id`, which
   exists in the schema (`db/schema.ts:159`) and is currently written by nothing. A
   sub-task is the honest representation of "mostly the same, plus one more step."

Guard against append-bloat: three agents each appending their phrasing produces an
unreadable description. Deduplicate delta sentences against what is already present,
and cap enrichment per item.

### 8.3 Deduplication is also consensus detection

This is the part that makes the feature more than noise reduction.

If Claude, Codex, and Gemini *independently* propose the same task, that convergence is
evidence. Each was reasoning from the same codebase without seeing the others'
conclusions. Three independent derivations of the same task is a much stronger signal
that the task is real and correctly scoped than one agent's proposal — and a task only
one agent ever proposed is more likely speculative or hallucinated.

So the merge should **produce** a field, not just consume one:

```ts
corroboration: {
  proposedBy: ["claude", "codex", "gemini"],   // distinct providers
  proposalCount: 3,
  firstProposedAt: "...", latestProposedAt: "..."
}
```

Surface it on the card: *"Proposed independently by 3 agents."* Feed it into
`get_ready_work` ranking from `GRAPH_ARCHITECTURE.md:§7.3` — corroborated tasks
outrank single-source ones at equal priority.

This inverts the framing of the whole feature. Connecting a fourth agent stops being a
clutter problem and becomes a **voting mechanism**: more agents means better-validated
plans, not a longer list. That is a defensible reason to connect more agents rather
than fewer, and no single-agent todo tool can offer it.

---

## 9. Interaction with the dependency graph

The two designs meet inside `create_work_items` and the ordering is load-bearing.

**Dedup must run before ref resolution.** Codex submits `{ref: "api", depends_on:
["schema"]}`. If `schema` collapses into Claude's existing `#4`, the edge must be
written as `#4 → api`, not against a temp ref that no longer maps to a new row. The ref
table therefore resolves to *canonical* IDs, some pre-existing:

```
ref "schema" → wi_04  (matched, pre-existing)
ref "api"    → wi_a1  (created)
edge: wi_04 → wi_a1
```

Then three follow-on consequences:

- **Edge dedup.** `UNIQUE(from, to, type)` (`db/setup.ts:27`) already makes a
  re-proposed edge a constraint violation. It must be caught and treated as an
  idempotent no-op — note this currently surfaces as a misleading
  `CONCURRENT_MODIFICATION` 409 via `commitMutation` (`lib/store.ts:173`), which is
  listed as finding #9 in the graph document.
- **Cycle re-check after merging.** Two acyclic plans can compose into a cycle once
  their shared nodes are unified. The cycle check must run on the *post-merge* edge set,
  inside the same transaction.
- **The graph is itself a matching signal.** The plan calls for using "dependency
  neighborhood" in similarity (`:332`) — two items with the same upstream and downstream
  neighbors are more likely the same task. This is a strong signal but only available
  *after* edges exist, so treat it as a phase-2 refinement of the async reconciler
  rather than part of the synchronous cascade.

---

## 10. Concurrency

Two agents planning simultaneously each check for duplicates, each find none, and each
insert. The read-then-write is not atomic.

Defend with a content fingerprint under a unique constraint — content-derived, unlike
the existing request-derived `idempotency_records`:

```sql
ALTER TABLE work_items ADD COLUMN content_fingerprint TEXT;
CREATE UNIQUE INDEX uq_work_items_fingerprint
  ON work_items(project_id, content_fingerprint)
  WHERE archived_at IS NULL AND content_fingerprint IS NOT NULL;
```

where `content_fingerprint = sha256(action_class + '|' + normalized_object + '|' +
sorted_artifacts)`.

The second writer loses on the constraint, catches the violation, re-reads the winner,
and returns `matched` with the winner's ID. The two agents converge on one item with no
coordination and no lock.

This only catches *exact-normalized* collisions. Fuzzy near-duplicates created in the
same instant cannot be caught this way and fall through to the async reconciler — which
is acceptable, because that path lands in the plan's existing confirmation-required
merge flow rather than in an automatic one.

Two notes on the existing code: `commitMutation` translates every UNIQUE violation into
`CONCURRENT_MODIFICATION` (`lib/store.ts:173`), so this needs a specific branch ahead of
that catch-all. And the fingerprint is *not* a substitute for
`idempotency_records` — that guards request replay, this guards independent
concurrent authorship. Both are needed.

---

## 11. Failure modes to design against

**Over-merging distinct-but-similar work.** Mitigated by the artifact veto (§4.2) and
by the asymmetric threshold policy (§6.3). Every merge is reversible because the alias
retains the original text and provenance — add an `unmerge` that promotes an alias back
to a first-class item.

**The canonical item drifting from what an agent thinks it claimed.** Codex's proposal
matched `#7`, but `#7`'s description has since been rewritten by Claude. `expected_version`
(`lib/store.ts:292`) already covers this for updates; the merge report should also state
what `#7` currently says, not just its ID.

**Matching against a stale done item.** `#3` is done, Codex proposes it again — but the
regression is real and it needs redoing. The correct output is the warning in §7, not a
silent match. The agent then calls `reopen_work` (which already exists,
`worker/index.ts:77`) with the evidence in hand.

**Description bloat.** Capped and sentence-deduplicated per §8.2.

**Adversarial or confused input.** An agent proposing 50 near-identical items should hit
a per-interaction cap and a single aggregated warning, not 50 individual match
computations against a growing set.

---

## 12. Sequencing

| Phase | Work | Status |
|---|---|---|
| **0** | `content_fingerprint` column; exact-normalized match in `create_work_items`; `matched` in the response | **shipped** — `db/setup.ts`, `lib/store.ts` |
| **1** | Task signature extraction (action lexicon, artifact regexes); the two veto rules; artifact-match tier | **shipped** — `lib/dedup/signature.ts`, `lib/dedup/match.ts` |
| **2** | `work_item_aliases`; alias write on match; delta capture via `add_note` | **shipped** — `lib/dedup/resolve.ts`, `createWorkItemsDeduplicated` |
| **3** | Merge report with explanations; already-done warnings; intra-batch dedup | **shipped** — `worker/index.ts` |
| **5** | Semantic tier (embeddings) | **built, then removed** — see §6.1 |
| **4** | `corroboration` field; "proposed by N agents" on cards; feed into `get_ready_work` ranking | not started |
| **6** | `unmerge`; decision logging → threshold tuning from real splits and confirmations | not started |

Remaining, in priority order:

1. **Surface aliases in the UI.** `listAliases` exists in `lib/store.ts` but nothing renders
   it, so the provenance the merge preserves is currently invisible to the user. Until
   this ships, a match looks like a silent deletion even though it isn't.
2. **Phase 4 (corroboration)** — the field that turns this from noise reduction into signal.
3. **`unmerge`** — promoting an alias back to a first-class item. The data model already
   supports it; only the command is missing. This is what makes a wrong match cheap.
4. **Threshold tuning** — every Inbox confirmation is a free label; nothing collects them yet.

The concurrency guard from §10 (`UNIQUE(project_id, content_fingerprint)`) is
deliberately **not** shipped. The column is populated and ready for it, but a unique
index introduces a new failure mode on every create path including the human composer,
where a user deliberately typing a near-duplicate should be warned rather than rejected.
That deserves its own pass rather than riding along with the matcher.

---

## 13. Findings

1. **No deduplication exists.** `create_work_items` loops and inserts unconditionally
   (`worker/index.ts:168-177`). `idempotency_records` guards request *replay* only — it
   is keyed on the request hash (`lib/store.ts:190`), so two agents authoring the same
   task independently produce two items by design.
2. **The plan's own tool contract already specifies matching** — *"created/matched IDs
   and any duplicate warnings"* (`PRODUCT_ARCHITECTURE_PLAN.md:449`) — but the shipped
   tool returns only `{ created: [...] }` (`worker/index.ts:176`).
3. **No Vectorize or Workers AI binding is available** on this hosting platform
   (`.openai/hosting.json`, `vite.config.ts:19-38` support `d1` and `r2` only). Recorded
   because it constrains any future ML-backed approach, not because it drove the
   decision in §6.1 — the cost/benefit did.
4. **`work_items.parent_id` is unused** (`db/schema.ts:159`) — the natural home for
   captured deltas that are independently actionable, and the same gap flagged as
   finding #7 in the graph document.
5. **Duplicate-edge writes surface as `CONCURRENT_MODIFICATION`**
   (`lib/store.ts:173`) rather than as idempotent no-ops, which the merge path will hit
   constantly once plans start overlapping.
6. **`item.merged` is specified as an event type** (`PRODUCT_ARCHITECTURE_PLAN.md:237`)
   and is emitted by nothing.
