# Planbraid Reconciliation Architecture

The core module. Everything else in the product is a consumer of this one.

This extends `DEDUPLICATION_ARCHITECTURE.md` rather than replacing it. That document's
structural matcher, its vetoes, its asymmetric error model, and its alias storage are all
load-bearing and stay. What changes is scope: that document answered *"is this proposal a
duplicate?"*. This one answers *"what is the relationship between this proposal and
everything this project already knows?"* — which is a strictly larger question with a
different shape.

It also revisits `§6.1` of that document ("Embeddings were built, measured, and
removed"). The conclusion there was correct and is partially reversed here, on new
evidence, for a reason spelled out in §6.

---

## 1. The reframe that makes all of this affordable

A Planbraid project holds **10² to 10³ work items**. Not 10⁶.

Almost every cost instinct imported from search and RAG is wrong at this size. A full
pairwise pass over 1,000 items with a twelve-feature scorer is 1,000 comparisons at a few
microseconds each — single-digit milliseconds, in-process, on a serverless function's
cold CPU.

The expensive things at this scale are not compute. They are:

1. **Network calls on the write path** — an embedding API adds 100–800ms and a failure mode.
2. **Cold-start weight** — `onnxruntime-node` is ~720 MB uncompressed against Vercel's
   250 MB function limit, so a transformer in the request path is not merely slow, it does
   not deploy.
3. **Unbounded candidate sets** — the current `ORDER BY updated_at DESC LIMIT 500` is
   already silently dropping the most valuable candidates (finding F2).

So the governing rule for this whole engine:

> **Everything runs in-process or inside Postgres. Nothing on the write path crosses a
> network boundary. Nothing that needs a GPU, an API key, or a model runtime ships.**

That constraint is not a compromise. It is what makes the engine deployable in a
serverless function, self-hostable, private by construction, and free per call — and
those four properties are more defensible than any accuracy point we could buy by
violating it.

---

## 2. What the adjacent literature already settled

Duplicate reconciliation of software work items has a direct academic analogue —
**duplicate bug report detection (DBRD)** — with twenty years of benchmarks. Three of its
findings are directly load-bearing here.

**The winning architecture is IR with weighted structured fields, not neural similarity.**
The reference method, **REP** ([Sun et al., ASE 2011](https://dl.acm.org/doi/abs/10.1109/ASE.2011.6100061)),
scores a pair using **BM25F-ext** over textual fields *plus* non-textual fields — product,
component, version, priority — with free parameters tuned by stochastic gradient descent
on the repository's own labels. A [2025 benchmark study](https://arxiv.org/html/2504.14797v1)
comparing DBRD techniques in realistic settings found IR-based REP **outperformed the
neural approaches**, and that data age and tracker choice change results enough that
published numbers do not transfer — you must measure on your own corpus.

**Your signal list is REP's feature set.** The nine signals in the roadmap map onto it
almost one-to-one — objective is REP's product, subsystem is its component, temporal state
is its version and age, affected files and symbols are a higher-precision field than
anything Bugzilla had. This is not a coincidence to be embarrassed about; it is
confirmation that the instinct is the one the field converged on. The part worth stealing
is not the feature list, it is **the training procedure**: REP's weights are learned, not
guessed.

**The current state of the art is IR plus an LLM assist, not an LLM alone.**
[Cupid](https://arxiv.org/html/2308.10022v3) improves on prior SOTA by ~8% Recall@10 by
using an LLM to *normalize and extract* from reports and then feeding a classical
retrieval function — the LLM is a preprocessor and an adjudicator, never the ranker. §6
below is the Planbraid version of that arrangement, and it costs nothing because the LLM
is already on the other end of the connection.

The second body of literature that matters is **probabilistic record linkage**. The
[Fellegi–Sunter model](https://moj-analytical-services.github.io/splink/topic_guides/theory/fellegi_sunter.html)
and its modern implementation [Splink](https://github.com/moj-analytical-services/splink)
give the scoring layer we should adopt outright: per-feature log-odds weights, learned by
expectation–maximisation, producing **calibrated posterior probabilities** rather than
uninterpretable scores — and doing it fast enough to link a million records on a laptop.
At our scale it is free. §4 is Fellegi–Sunter applied to work items.

---

## 3. The pipeline

Four stages. Recall first, precision second, structure third, judgment last.

```
                    proposal (title, description, source, session)
                                        │
        ┌───────────────────────────────▼────────────────────────────────┐
        │ STAGE 0 · CANONICALIZATION                                     │
        │ signature v2: action · object · artifacts · symbols ·          │
        │ subsystem · acceptance criteria · qualifiers · embedding       │
        └───────────────────────────────┬────────────────────────────────┘
                                        │
        ┌───────────────────────────────▼────────────────────────────────┐
        │ STAGE 1 · BLOCKING          target: ≥99% recall @ 50 candidates│
        │ artifact index ∪ rare-token index ∪ vector ANN ∪ same-objective│
        │ ∪ dependency neighbourhood        →  RRF fusion  →  top 50     │
        └───────────────────────────────┬────────────────────────────────┘
                                        │
        ┌───────────────────────────────▼────────────────────────────────┐
        │ STAGE 2 · SCORING                                              │
        │ (a) hard vetoes — no score overrides these                     │
        │ (b) Fellegi–Sunter log-odds over 12 features → P(same work)    │
        └───────────────────────────────┬────────────────────────────────┘
                                        │
        ┌───────────────────────────────▼────────────────────────────────┐
        │ STAGE 3 · RELATION TYPING   set algebra, not statistics        │
        │ DUPLICATE SUBSET SUPERSET OVERLAP CONFLICT SEQUENCE RELATED NEW│
        └───────────────────────────────┬────────────────────────────────┘
                                        │
        ┌───────────────────────────────▼────────────────────────────────┐
        │ STAGE 4 · ADJUDICATION                                         │
        │ collapse │ create+link │ raise conflict │ escalate to judgment │
        └────────────────────────────────────────────────────────────────┘
```

Stages 0–3 are pure functions. Stage 4 is the only one that writes. That split is
inherited from `lib/dedup/match.ts` and must survive every extension: the rules that
decide whether work gets collapsed have to be testable without a database.

---

## 4. The twelve features

`TaskSignature` v2 extends the shipped one. New fields marked ★.

```ts
type TaskSignature = {
  action:      ActionClass;      // shipped
  objectTokens: string[];        // shipped — stemmed, stopword-free
  artifacts:   string[];         // shipped — paths, endpoints, symbols, env vars
  symbols:     string[];      // ★ resolved against the repo's real symbol table (§7)
  subsystem:   string | null; // ★ derived from artifact paths via a prefix tree
  criteria:    string[];      // ★ acceptance criteria parsed from the description
  qualifiers:  string[];      // ★ scope narrowing: mobile, production, v2, staging
  objectiveId: string | null; // ★ the objective this serves, if known
  embedding:   Float32Array | null; // ★ static, 256-d, see §6
  normalized:  string;           // shipped — fingerprint input
  raw:         string;           // shipped
};
```

The comparison features fed to the scorer, with the roadmap's nine signals mapped on:

| # | Feature | Roadmap signal | Comparison | Notes |
|---|---|---|---|---|
| f1 | Fingerprint equality | — | boolean | Decisive on its own |
| f2 | Artifact Jaccard | affected files | `\|A∩B\| / \|A∪B\|` | The highest-precision signal we have |
| f3 | Artifact containment | affected files | `\|A∩B\| / min(\|A\|,\|B\|)` | Drives SUBSET/SUPERSET |
| f4 | Symbol overlap | affected symbols | Jaccard over resolved symbols | Survives file moves and renames |
| f5 | Subsystem agreement | subsystem | same / adjacent / different | Cheap, strong negative evidence |
| f6 | Action compatibility | — | same / compatible / antonym | Veto input |
| f7 | Lexical similarity | — | **BM25F** over title^3, criteria^2, description^1 | Field weighting is REP's core idea |
| f8 | Embedding cosine | semantic similarity | cosine of static vectors | §6; the paraphrase case only |
| f9 | Criteria overlap | acceptance criteria | Jaccard over normalized criteria | Absent for most items — FS handles missing features properly |
| f10 | Graph proximity | dependencies | Adamic–Adar over shared prerequisites/dependents | Two items with the same blockers are usually related |
| f11 | Implementation overlap | existing implementation | shared files in attached evidence / repo observations | Grounds the match in what actually changed |
| f12 | Temporal & lifecycle | temporal state | age gap, status pair, staleness | Encodes "already done 20 minutes ago" as a feature |

Signal 8 of the roadmap — **previous decisions** — is deliberately *not* a pair feature.
It is not a property of the relationship between two tasks; it is a property of the
proposal alone ("does this restate something already rejected"), and it is evaluated in
Stage 4 against decision items and `resolution='rejected'` work. Modelling it as a pair
feature would let a strong decision similarity pull two unrelated tasks together.

### 4.1 Vetoes stay absolute

Unchanged from `DEDUPLICATION_ARCHITECTURE.md §4.2`, and no learned weight may override
them:

```
VETO 1  both artifact sets non-empty and disjoint          → not the same work
VETO 2  actions are antonyms                               → not the same work
VETO 3  both objectives known and different                → not the same work   ★ new
VETO 4  both subsystems known and non-adjacent             → not the same work   ★ new
```

A veto is a gate, not a subtracted weight, for the reason that document already gives: a
0.95 similarity must never outvote a disjoint artifact set, because the artifact set is
the *more reliable* signal. Fellegi–Sunter would in principle learn this — but "in
principle, given enough labels" is not a guarantee, and a false merge is data loss. Keep
the gates.

**One veto changes meaning.** VETO 2 currently returns `distinct` (finding F3). "Add auth
middleware" and "Remove auth middleware" on the same file are not unrelated; they are a
**CONFLICT**. Antonym actions with *overlapping artifacts* route to Stage 3 as CONFLICT;
antonym actions with *disjoint* artifacts remain DISTINCT.

### 4.2 Scoring: Fellegi–Sunter, not a weighted sum

For each feature `i`, with agreement level `γᵢ`:

```
m_i(γ)  =  P(feature i agrees at level γ  |  the two items ARE the same work)
u_i(γ)  =  P(feature i agrees at level γ  |  they are DIFFERENT work)

                                    m_i(γ_i)
match weight  w_i  =  log₂  ───────────────────
                                    u_i(γ_i)

log-odds(same)  =  log₂(λ / (1-λ))  +  Σ w_i        λ = prior P(a random pair is the same)
P(same)         =  2^logodds / (1 + 2^logodds)
```

Four reasons this beats the hand-tuned cascade for the extended feature set:

1. **Calibration.** The output is a probability, so the threshold becomes a statement
   about cost — "collapse when P(same) > 0.995 because a false merge costs ~200× a false
   split" — instead of an unexplainable `0.87`.
2. **Missing features are principled.** Most items have no acceptance criteria and no
   objective. A weighted sum has to invent a default; FS assigns `w = 0` for an
   unobserved feature, which is exactly right — no evidence is not evidence of absence.
3. **Weights are learned from our own labels** (§8), by EM or by SGD as REP does. This
   removes the single largest source of arbitrariness in the current design, which
   `DEDUPLICATION_ARCHITECTURE.md §6.3` already flagged: *"thresholds cannot be guessed."*
4. **Per-feature diagnosis.** The weight vector says *which* signal carried a decision,
   which is what the UI needs to explain a match in plain language and what §8's ablation
   needs to delete a feature that isn't earning its cost.

Implementation note: the m/u tables are small — twelve features, three or four agreement
levels each. They are a JSON blob loaded at module init, versioned, and shipped in the
repo. **No training runs in production.** Training is an offline script over the exported
label set (§8), reviewed in a pull request like any other change, because a silent
re-weighting of the matcher is a silent change to whether work gets collapsed.

---

## 5. Blocking: never scan by recency again

Finding F2 is a correctness bug, not a performance one. Candidates today come from
`ORDER BY updated_at DESC LIMIT 500`, and `DEDUPLICATION_ARCHITECTURE.md §5` argues that
matching against **done** work is the most valuable case — which is precisely the work
that sorts last by `updated_at`.

Replace with a union of five cheap retrievers, fused by
[Reciprocal Rank Fusion](https://dev.to/gabrielanhaia/hybrid-search-in-100-lines-bm25-pgvector-with-rrf-merge-58cn)
(rank-based, so incompatible score scales never have to be reconciled):

| Retriever | Index | Catches |
|---|---|---|
| Artifact inverted index | `work_item_artifacts(project_id, artifact, work_item_id)` | Same file or endpoint — highest precision |
| Rare-token index | IDF-weighted tokens, project-local | Distinctive wording |
| BM25F full text | `pg_trgm` + `tsvector`, or `pg_search` (available on Neon) | Everything ordinary IR catches |
| Vector ANN | `pgvector` HNSW on the static embedding | Pure paraphrase with no shared vocabulary |
| Structural | same objective, dependency neighbourhood, same subsystem | Related work that shares no words at all |

`RRF(d) = Σ 1/(k + rank_r(d))`, `k = 60`. Take the top 50. **Never filter by status** —
done and cancelled items are candidates by design.

**Recall is the only metric that matters at this stage.** A duplicate that never reaches
Stage 2 is invisible forever. The evaluation harness measures blocking recall separately
from end-to-end accuracy, and blocking recall below 99% on the golden set is a build
failure.

Cost: five indexed queries, project-scoped, ~5ms total. All five indices are maintained
on write in the same batch that creates the item, so there is no rebuild job and no drift.

---

## 6. The embedding question, reopened honestly

`DEDUPLICATION_ARCHITECTURE.md §6.1` removed the semantic tier and gave five costs: an
external API dependency and key on the write path, a timeout and a failure mode, a table,
four environment variables, a billing surface, and a privacy leak from shipping task
titles off-machine.

**Every one of those costs is a property of calling a hosted embedding API. None of them
is a property of a vector.**

[Model2Vec](https://github.com/MinishLab/model2vec) distills a sentence transformer into
a **static** embedding: a token→vector lookup table plus mean pooling, with PCA and Zipf
weighting baked in at distillation time. There is no neural network at inference. The
smallest published model is ~8 MB; `potion-base-8M` retains roughly 90% of MiniLM's
accuracy while running [tens of thousands of sentences per second on CPU](https://huggingface.co/minishlab/potion-base-8M),
about 500× faster than the transformer it came from, with numpy as its only real
dependency.

Re-running §6.1's ledger against a static embedding:

| §6.1's objection | Static embedding |
|---|---|
| External API dependency and key on the write path | None. No network call exists |
| Timeout and failure mode | None. It is a table lookup |
| A table | One table of token vectors, ~30 MB, read-only, shared |
| Four environment variables | Zero |
| A billing surface | Zero |
| Privacy leak — titles shipped off-machine | **Nothing leaves the deployment** |
| Latency | Microseconds |

The objections do not survive the change of implementation. The decision to remove the
tier was right about the *implementation available at the time* and should be reversed
for this one — with the measurement discipline of §8 attached, so it can be removed again
if the ablation says it is not earning its place.

### 6.1 Running static embeddings in a serverless function

`onnxruntime-node` is ~720 MB uncompressed against Vercel's
[250 MB function limit](https://vercel.com/kb/guide/troubleshooting-function-250mb-limit).
Any design that requires it is not deployable on the current platform. Two routes avoid it
entirely; there is no published JavaScript port of Model2Vec (Python and Rust only), so
both involve implementing inference ourselves — which for a static model means *mean-pooling
a lookup*, roughly forty lines.

**Route A — vectors in Postgres (recommended).** Store the distilled table as
`token_vectors(token TEXT PRIMARY KEY, vec vector(256), weight REAL)`. Tokenize in
TypeScript — a WordPiece tokenizer is pure string work, no model — then embed with one
statement:

```sql
SELECT (SUM(vec * weight) / NULLIF(SUM(weight), 0))::vector(256) AS embedding
  FROM token_vectors WHERE token = ANY($1);
```

Zero bytes added to the function bundle, no cold start, no model loading, and the vector
is produced in the same round trip as the rest of the write. Distillation happens once,
offline, in Python; the output is a seed file.

**Route B — weights as a static asset.** Ship the 8 MB table as a binary asset, load once
per instance, mean-pool in TypeScript. Faster per call, ~8 MB of bundle, a cold-start
penalty on the first request of an instance. Correct choice for a self-hosted or
long-running deployment; unnecessary on Vercel.

Both keep `pgvector` HNSW as the ANN index for blocking, which
[Neon supports natively](https://neon.com/docs/extensions/pgvector) and which serves
1M vectors in 5–20ms — three orders of magnitude more headroom than a project needs.

**Still rejected, on the original reasoning:** hosted embedding APIs, transformer
inference in the request path, cross-encoder rerankers, anything needing a GPU.

---

## 7. Grounding in the repository

Features f4 (symbols) and f11 (implementation overlap) need the engine to know what the
code actually contains. Two levels, both fed by the bridge (see `CAPTURE_ARCHITECTURE.md`),
never by a hosted service.

**Level 1 — symbol table via tree-sitter.** Parse the repository once, incrementally
on change, extracting every function, class, method, type and constant with its file and
line. [Tree-sitter based indexing is the pragmatic choice over SCIP](https://github.com/orgs/sheeptechnologies/discussions/4)
for retrieval workloads: per-file ASTs, no build-system integration, no language servers,
incremental on save. This turns a proposal's loose mention of "the token refresh handler"
into `refreshAccessToken` at `lib/github.ts:141` — a resolved artifact, which is the
highest-precision feature the scorer has.

**Level 2 — change observations.** Commit shas, changed files, and test outcomes reported
by the bridge, already specified as M15 in the roadmap. This gives f11 and, separately,
answers "has this already been implemented" — the single most valuable thing the engine
can tell a second agent.

**Subsystem derivation** (f5) falls out of Level 1 for free: build a prefix tree over the
repository's directory structure, cut it at the level where the branching factor is
highest, and label each artifact with its subsystem. No configuration, no ownership file,
no ML. Two tasks in `lib/oauth.ts` and `app/planbraid-app.tsx` are in different subsystems
and that is strong negative evidence, cheaply.

---

## 8. Calibration, evaluation, and what "mastering the algorithm" actually means

This section is the difference between a good matcher and a defensible one, and it should
be built **first** — before the features it evaluates.

### 8.1 The golden set builds itself

Every label the engine needs is already generated as a side effect of normal use, and
`DEDUPLICATION_ARCHITECTURE.md §6.3` already noticed this without acting on it:

| User action | Label |
|---|---|
| Splits an alias ("not the same, make separate task") | **Negative**, high confidence |
| Merges two items by hand, or applies a Simplify merge finding | **Positive**, high confidence |
| Dismisses a `possible_duplicate` finding | **Negative**, medium |
| Leaves a collapsed match untouched for 7+ days | **Positive**, weak |
| Answers a judgment escalation (§9) | **Either**, with a stated reason |

Persist these to `reconciliation_labels(pair_hash, verdict, confidence, source, features,
created_at)` — storing the **feature vector as computed at the time**, so a label stays
usable after the feature set changes.

### 8.2 The harness ships with the engine

```
npm run reconcile:eval        # replay the golden set, print the report
```

Reports, per the DBRD literature's standard metrics plus one of our own:

- **Blocking recall@50** — must be ≥99%, else nothing downstream matters.
- **Recall Rate@k** and **MAP** — comparable to published DBRD numbers.
- **False merges — must be zero.** Not "low". This is the data-loss error, and it is the
  one number that can veto a release.
- **Precision at the operating threshold**, and the threshold that minimises expected cost
  given the measured asymmetry.
- **Per-feature ablation.** Drop each feature, re-run, report the delta. This is how the
  embedding tier proves it deserves to exist — and how it gets deleted a second time if
  it doesn't.

Two disciplines make this real: the golden set is **versioned in the repository**, and the
weight file is **regenerated by an offline script and reviewed in a pull request**. A
matcher whose behaviour changes without a diff is a matcher nobody can trust with
collapsing work.

### 8.3 Threshold selection

Not F1. Expected cost:

```
E[cost] = P(false merge) · C_merge + P(false split) · C_split ,  C_merge ≫ C_split
```

`DEDUPLICATION_ARCHITECTURE.md §6.3`'s table is the justification: a false split is one
visible card anybody can fix; a false merge silently loses work and points an agent at the
wrong task. Start with `C_merge/C_split = 200`, and let the measured rate of user-initiated
splits refine it.

---

## 9. The intelligence tier — using an LLM without depending on one

This is the direct answer to *"why can't we use a smart AI platform for Planbraid other
than the connected agents?"*

Three tiers, in preference order. The first is free and better than a hosted model.

### Tier A — the connected agent adjudicates (recommended, zero cost)

When the scorer lands in the ambiguous band, return the pair to the caller with a precise
question instead of guessing:

```jsonc
{ "results": [ /* … */ ],
  "needsJudgment": [{
    "pairId": "jdg_7f2…",
    "question": "Is “Add refresh-token renewal” the same work as #31 “Implement refresh-token rotation”?",
    "evidence": { "sharedArtifacts": ["lib/auth/tokens.ts"], "differing": ["rotation vs renewal"] },
    "answerWith": "submit_reconciliation_judgment"
  }]}
```

The agent on the other end is an LLM **with the repository open**. It can read
`lib/auth/tokens.ts` and answer better than any server-side model reasoning over two
strings. This is [Cupid's](https://arxiv.org/html/2308.10022v3) LLM-assisted arrangement —
IR does the ranking, a model adjudicates the hard cases — obtained for free because the
model is already on the connection.

Two rules keep it honest:

- **Require a justification naming an artifact or a behaviour.** "They're different"
  is rejected; "different — #31 rotates the signing key, this renews the client's token"
  is stored as a label.
- **Audit the agent against humans.** The proposing agent has a mild incentive to answer
  "different" so its task gets created. Track judgment-vs-later-human-split agreement per
  provider; if a provider's judgments disagree with humans, down-weight them. That number
  is also a genuinely interesting product artifact.

### Tier B — ask the person, inside the agent's own interface

MCP's [2026-07-28 revision](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
replaced held-open server-to-client streams with **MRTR (Multi Round-Trip Requests)**: a
tool call returns `resultType: "input_required"` with `inputRequests` and an opaque
`requestState`, and the client re-issues the call with `inputResponses`. Because all state
rides in the payload, **any stateless server instance can resume the work** — which fits
`/mcp`'s `force-dynamic` serverless handler exactly, with no session affinity.

That gives Planbraid a way to ask the human a yes/no question in the middle of a tool call,
in the agent's own UI. It is the right mechanism for the genuinely-ambiguous merge, and it
is also the mechanism for feature 9's human-decision queue.

**Caveat to plan around:** the spec deprecated Sampling *and* Elicitation in the same
revision — they keep working for at least twelve months, and new implementations are
advised not to adopt them. So: build Tier B behind a capability check, treat it as an
enhancement, and never let a code path require it. Tier A needs no protocol feature at all,
which is the deeper reason to prefer it.

### Tier C — models we own, and only the small kind

If A and B leave a residual, the answer is still not a generative LLM. It is:

- a **static embedding** (§6) — a lookup table, not a model that runs;
- a **learned scorer** (§4.2) — a weight file measured in kilobytes;
- optionally a **gradient-boosted reranker** over the twelve features for the top-20
  candidates, which is a few hundred kilobytes and microseconds per pair.

All three are owned, versioned, offline-trained, inspectable, and run in-process. None
requires a key, a bill, a network call, or sending a user's task titles anywhere.

**Explicitly rejected:** a hosted LLM on the write path. It reintroduces every cost §6.1
enumerated, adds nondeterminism to the one decision in the product that must be
reproducible, and buys less than Tier A, which is free.

---

## 10. Reconciliation is also the merge function

The engine described here is not only for `create_work_items`. Three other call sites want
exactly this computation, and unifying them is what turns a matcher into a platform module:

| Caller | What it asks |
|---|---|
| `create_work_items` | Is this proposal new work? |
| **Plan merge** (`PLAN_VERSION_CONTROL.md`) | How do two divergent plan branches combine? |
| **Simplify** | What in this project's existing plan is redundant, conflicting, or subsumed? |
| **Planning context** (roadmap M11) | Which existing work is relevant to what I am about to plan? |

All four are `relate(A, B) → relation + confidence + explanation` over different inputs.
Build one module with one scorer, one weight file, and one evaluation harness. The moment
Simplify has its own drifting copy of the rules — which it partially does today, via
`analyze.ts` calling `adjudicate` with `fingerprintValue: ""` — the product has two
matchers that will disagree in front of a user.

---

## 11. Latency and cost budget

Per proposal, on the write path:

| Stage | Budget | Notes |
|---|---|---|
| Canonicalization | 2 ms | String work; embedding via one SQL statement |
| Blocking | 5 ms | Five indexed project-scoped queries, executed in one `db.batch` |
| Scoring, 50 candidates | 1 ms | Twelve features, in-process |
| Relation typing | <1 ms | Set algebra |
| **Total p95** | **< 25 ms** | **< 150 ms for a 10-item batch** |

Anything that cannot hold this budget does not belong on the write path. It belongs in the
Simplify pass, which is asynchronous by construction and already has persistence, an
apply path, and a UI.

Scaling: every index is project-scoped, so cost is O(items in *this* project), not O(all
items). The only global structure is the read-only token-vector table. At 10k items in one
project, blocking stays sublinear via the inverted indices and HNSW, and the pairwise pass
never runs online. The binding constraint remains `loadDashboard` (finding F6), not the
matcher — as `DEDUPLICATION_ARCHITECTURE.md §5` predicted.

---

## 12. Schema

```sql
-- Precomputed once on write; the matcher reads features, never recomputes them.
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS signature JSONB;
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS embedding vector(256);
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS subsystem TEXT;
CREATE INDEX IF NOT EXISTS idx_items_embedding
  ON work_items USING hnsw (embedding vector_cosine_ops);

-- Blocking indices, maintained in the same batch as the item write.
CREATE TABLE IF NOT EXISTS work_item_artifacts (
  project_id TEXT NOT NULL, artifact TEXT NOT NULL, work_item_id TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- file | symbol | endpoint | env | key
  PRIMARY KEY (project_id, artifact, work_item_id));
CREATE INDEX IF NOT EXISTS idx_item_artifacts_lookup
  ON work_item_artifacts (project_id, artifact);

-- Distilled static embedding table. Read-only, seeded, shared across projects.
CREATE TABLE IF NOT EXISTS token_vectors (
  token TEXT PRIMARY KEY, vec vector(256) NOT NULL, weight REAL NOT NULL DEFAULT 1);

-- Repository symbol table, incrementally maintained by the bridge.
CREATE TABLE IF NOT EXISTS repo_symbols (
  project_id TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL,
  file TEXT NOT NULL, line INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, symbol, file));

-- Labels: the golden set, accumulated from normal use.
CREATE TABLE IF NOT EXISTS reconciliation_labels (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, pair_hash TEXT NOT NULL,
  left_item_id TEXT, right_item_id TEXT,
  verdict TEXT NOT NULL,                  -- same | different
  confidence TEXT NOT NULL,               -- high | medium | weak
  label_source TEXT NOT NULL,             -- split | merge | dismissal | judgment | timeout
  features JSONB NOT NULL,                -- as computed at labelling time
  justification TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, pair_hash, label_source));

-- Open adjudications awaiting an agent's or a person's answer.
CREATE TABLE IF NOT EXISTS reconciliation_judgments (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, pair_hash TEXT NOT NULL,
  left_item_id TEXT, right_proposal JSONB NOT NULL, question TEXT NOT NULL,
  asked_of_source_id TEXT, verdict TEXT, justification TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), answered_at TIMESTAMPTZ);
```

---

## Build status

**E0 shipped**, per the roadmap doc's own tracker: the evaluation harness
(`lib/dedup/labels.ts`, `scripts/reconcile-eval.mjs`), label capture wired into merge,
split, and finding-dismissal.

**E1 shipped.** Blocking rebuild — the artifact index (M7) plus a new rare-token index,
fused by Reciprocal Rank Fusion, with the old recency-window fallback removed entirely
rather than kept as a safety net. What's here:

- `db/setup.ts`: `work_item_tokens(project_id, token, work_item_id)`, indexed the same
  way as `work_item_artifacts`.
- `lib/dedup/tokens.ts`: `tokensOf()` — reuses `buildSignature`'s already-stemmed,
  stopword-free `objectTokens` rather than a second tokenizer, so an artifact and a token
  can never be the same string and the two indices stay disjoint signals.
- `lib/dedup/blocking.ts`: the whole retrieval layer. `blockingIndexStatements()` and
  `backfillBlockingIndex()` maintain both indices from one write path and one shared
  `artifacts_indexed_at` flag; `retrieveCandidates()` fuses `rankByArtifactOverlap()` and
  `rankByRareTokens()` (IDF-weighted, computed at query time from live document
  frequency) via `fuseRankings()`, all four pure and directly unit-tested, per §5's
  design. Never filters by status — done and cancelled items are candidates by design.
  Top 50 per proposal, unioned across a batch.
- `lib/dedup/blocking-eval.ts`: `measureBlockingRecall()`, E1's own gate from §13 —
  "blocking recall@50 ≥ 99%" — separate from E0's scoring-stage recall, since a duplicate
  that never reaches the scorer is invisible regardless of how good the scorer is.
  `scripts/reconcile-eval.mjs` now reports it alongside E0's numbers and fails the same
  way false merges do.
- `lib/dedup/artifacts.ts` trimmed back to the pure vocabulary it always should have
  been (`artifactsOf`, `classifyArtifact`) — indexing, backfill, and retrieval all moved
  to `blocking.ts`, which now owns both tables together. That consolidation is not
  incidental tidying: running the artifact and token backfills as two independent passes
  each filtering on the same `artifacts_indexed_at` flag is a real bug — whichever
  finishes first stamps the flag, and the second pass then finds nothing left to do,
  silently leaving the other index empty forever for every pre-existing item. Caught by a
  dedicated regression test before it could ship.

A second, unrelated real bug surfaced while wiring this in: `create_work_items`'
`linkedDependencies` response field (the human-readable item key shown for a resolved
`depends_on` reference) was reading item keys off `retrieveCandidates`' own return value
— coincidentally safe under the old "up to 500 recent items" retrieval, since a
prerequisite named by literal id was almost always in that window regardless of wording,
but never actually correct now that retrieval is precisely scoped to what plausibly
duplicates *this* proposal. A prerequisite task and the thing that depends on it
routinely share no vocabulary at all ("provision the database" / "run migrations"), so it
would now almost never appear there. Fixed by resolving those keys with a dedicated
`itemKeysFor()` lookup instead, decoupling "what might this proposal duplicate" from
"what does this literal id's key display as" — two questions that were never supposed to
share one code path.

26 new tests (`tests/blocking.test.mjs`) plus 3 rewritten in `tests/project-view.test.mjs`
to test the new, deliberately-stricter no-recency-fallback behavior instead of the old
one. Full regression suite (474 tests), lint, and build all green.

**E2 shipped.** Signature v2's three genuinely-buildable-now fields, all in
`lib/dedup/signature.ts`: `subsystem`, `criteria`, `qualifiers`, plus a synonym lexicon
feeding `objectTokens`. `symbols`, `embedding`, and `objectiveId` — the other three ★
fields in §4's `TaskSignature` — are deliberately not here: they need E7's tree-sitter
grounding, E5's static embeddings, and M20's objectives (itself deferred, waiting on real
usage evidence per its own roadmap entry) respectively, none of which exist yet.

- **Synonym lexicon**: a modest, hand-picked abbreviation/full-form map (`authentication`
  ↔ `auth`, `database` ↔ `db`, and similar), applied to object tokens before stemming
  since stemming's suffix rules can't turn one word into a different word. Deliberately
  not exhaustive — a wrong pair silently merges two tokens that were never the same word,
  which is the opposite of what this whole module is built to avoid.
- **Qualifiers**: scope-narrowing terms (`mobile`, `production`, `v2`, `staging`, ...)
  pulled out of the object-token bag the same way artifacts and the action verb already
  are — "add dark mode" and "add dark mode on mobile" now genuinely fingerprint
  differently, where before the qualifier just diluted ordinary lexical overlap.
- **Criteria**: acceptance criteria parsed from a description — markdown checklists,
  Given/When/Then lines, and bullet/numbered lists under a recognized heading. Absent for
  most items, which is expected (f9's own note: "FS handles missing features properly"),
  not a gap to force-fill with a more aggressive parser.
- **Subsystem**: the directory shared by an item's own mentioned file artifacts, capped
  at two path segments — deliberately the honest, buildable-now version of §7's fuller
  design (a real prefix tree over the actual repository structure, cut at peak branching
  factor), not a premature attempt at that sophistication using data (the corpus of
  artifacts *this project's own items happen to mention*) that isn't the real repo tree.
  E7's repo grounding is where this gets sharper, once tree-sitter's symbol table exists
  to build the real tree from.

**Deliberately not wired into `match.ts`'s adjudication cascade.** §4.1 lists "both
subsystems known and non-adjacent" as veto 4, but adding a hard veto now — based on this
milestone's own path-prefix heuristic rather than E7's real repository tree — would risk
exactly the false-split-from-imprecision the vetoes document itself warns a hand-tuned
cascade is prone to. These fields are real, computed, and tested; E3's Fellegi-Sunter
scorer is the correct place to consume them as a *learned*, calibrated weight instead of
one more guessed threshold, which is the entire reason §4.2 exists.

One safety property verified explicitly, given `normalized` (the fingerprint input) now
includes these new fields: `lib/dedup/resolve.ts`'s `toCandidate` always recomputes an
existing item's fingerprint live from its current title/description at match time — it
never reads the stored `content_fingerprint` column back out for comparison — so widening
`normalized` changes nothing about matching correctness for items that already exist; it
only changes what a *future* comparison can distinguish. Confirmed by reading the matching
path before making the change, not assumed.

21 new tests (`tests/dedup.test.mjs`, "signature v2:" prefix). Full regression suite (495
tests), lint, and build all green — zero regressions in the existing cascade, matching
the "no regression" half of E2's own gate; the "ablation shows each new field's
contribution" half needs real labels to measure against, which `npm run reconcile:eval`
picks up automatically once they exist (same caveat as E1's blocking-recall gate).

**E3 shipped as a parallel, evaluatable path — not yet the production adjudicator.**
§13's own gate for this milestone ("calibrated probabilities; false merges = 0; beats the
cascade baseline") requires both scorers to exist side by side to even measure "beats", so
`adjudicate()` in `match.ts` stays the live path exactly as before; `adjudicateFs()` in the
new `lib/dedup/fellegi-sunter.ts` is what `npm run reconcile:eval` now also scores the
golden set with, printed next to the cascade's own numbers for direct comparison. Cutover
is a future, separate decision gated on that comparison turning out favorably against real
labels — this milestone is "build it correctly and make it measurable," not "replace the
cascade."

- **`checkVetoes()` extracted from `match.ts`** before any scoring code was written: the
  four hard gates (fingerprint equality, antonym actions, disjoint artifacts, incompatible
  actions) now live in one function that both `adjudicate()` (the cascade) and
  `adjudicateFs()` (Fellegi-Sunter) call first, rather than risking a second,
  independently-drifting copy — exactly the "two matchers that disagree in front of a
  user" failure §10 warns about, one level below where that section applies it. Verified
  behavior-preserving (`tsc --noEmit` clean, full `dedup.test.mjs` suite unchanged) before
  any FS-specific code landed on top of it.
- **`lib/dedup/features.ts`**: the twelve-feature vector as discrete agreement *levels*,
  not raw scores — §4.2's model is over categorical agreement, and bucketing is what lets
  `m`/`u` be simple lookup tables instead of a density-estimation problem. A feature is
  `null` (missing) exactly when there is genuinely nothing to compare, never coerced into
  a "disagreement" level — the property that makes Fellegi-Sunter safe with partial
  evidence. f1/f2/f3/f5/f6/f7/f9 are fully computed now; f4 (symbol overlap) is an
  approximation over *unresolved* symbol-looking artifact names, honestly weaker than the
  real thing until E7's tree-sitter grounding can resolve them against an actual
  repository; f12 (temporal/lifecycle) reads the candidate's status and staleness, always
  observed since every real candidate has one. f8 (embedding), f10 (graph proximity), and
  f11 (implementation overlap) are accepted via an optional `context` argument for callers
  that have E5/M15/graph data to supply — no caller does yet, so they stay `null` in every
  live comparison today, which Fellegi-Sunter already handles correctly as absence.
- **`lib/dedup/fellegi-sunter.ts`**: `w = log2(m/u)` per observed feature, summed with the
  prior's own log-odds via `scoreFeatures()`; `probabilityOfMatch()` uses the
  `1/(1+2^-logOdds)` form specifically so a confidently-same pair's exponent stays
  negative and the sigmoid can't overflow to `Infinity` the way `2^x/(1+2^x)` would for a
  large positive `logOdds`. The collapse threshold is derived, not guessed:
  `C_merge/(C_merge+C_split)` from §4.2, confirmed algebraically equal to
  `costRatio/(costRatio+1)` and checked against the roadmap's own 200:1 worked example
  (≈0.995). The lower "possible" boundary is a fixed 0.5 (more-likely-than-not) rather
  than a second cost-derived threshold — classical Fellegi-Sunter's two-threshold method
  bounds false-match/false-non-match *rates* from a large labeled corpus, which this
  project doesn't have yet (§8.1's realistic scale is tens to low hundreds of labels for a
  single project); 0.5 is the honest placeholder until real error-rate curves justify
  something sharper, and it errs toward flagging more pairs for human review, matching
  §10's conservative bias for the current UI. `adjudicateFs()` assembles the whole path:
  `checkVetoes()` first, then feature computation and scoring for whatever survives.
- **`SEED_WEIGHTS`**: hand-reasoned from the asymmetric-error principle, not fit to real
  data — there is no live production database in this sandbox to train against. Every
  entry is deliberately close-to-neutral (`m` near `u`) rather than confidently one-sided,
  so an untrained feature can't dominate a score; f8/f10/f11 have no entries at all, and a
  feature with no weight is treated exactly like a missing observation, so adding their
  real weights later (E5, E7) is additive, never a migration.
- **`lib/dedup/train.ts` + `scripts/reconcile-train.mjs`**: supervised MLE weight
  re-estimation from `reconciliation_labels` — counting observed-level frequencies split
  by verdict, with additive smoothing. Supervised counting, not unsupervised EM: EM exists
  for record linkage because ground truth is usually unavailable, but Planbraid's labels
  *are* ground truth (a person merged, split, or dismissed something), so direct frequency
  counting is the correct closed-form estimator for this problem, not an approximation of
  a fancier one. Two edge cases specifically handled: pairs `checkVetoes` would catch are
  excluded from every tally (training on them would teach the model about observations the
  scorer structurally never sees at run time, since vetoes fire first), and a feature with
  fewer than `--min-labels` (default 20) supporting observations keeps its *entire* seed
  entry rather than training only its well-supported levels, since a feature half-trained
  and half-guessed produces log-odds that aren't comparable across its own levels. The
  prior (λ) and cost ratio are never re-estimated from the label sample — the golden set is
  selection-biased toward pairs someone already looked at, which skews far more "same"
  than the true population Stage 1 blocking retrieves, and cost ratio is a policy choice no
  label set can answer. The script prints a `WeightTable` as JSON and stops; adopting it is
  a deliberate, reviewed step (matching §8's "no training runs in production... reviewed in
  a pull request"), never an automatic overwrite of `SEED_WEIGHTS`.
- **`scripts/reconcile-eval.mjs`** now runs both scorers over the same golden set and
  prints them side by side (recall, precision, false merges, split-true-duplicates for
  each), plus an explicit "beats the cascade baseline" verdict — informational only; it
  does not affect the script's exit code, since the FS path failing this comparison today
  (expected, with hand-guessed seed weights and no real training data) says nothing about
  whether the *live* cascade is broken.

60 new tests: `tests/fellegi-sunter.test.mjs` (32 — feature-vector correctness and
missingness for all twelve features, the log-odds/probability math including overflow
safety, threshold derivation matching the roadmap's own example, and `adjudicateFs()`
end-to-end against hand-built pairs) and `tests/reconcile-train.test.mjs` (8 — veto
exclusion from training tallies, per-minLabels feature-level gating, and that trained
`m`/`u` values actually sum to ~1 across a feature's level universe). Full regression
suite (535 tests), typecheck, and lint all green — zero regressions in the cascade,
consistent with E3 never having touched `adjudicate()`'s own decision logic beyond the
shared `checkVetoes()` extraction verified safe before any FS code was added on top.

**E4 shipped — Stage 3 relation typing, and finding F3 fixed at its source.** §3's
pipeline diagram lists eight relation types (`DUPLICATE SUBSET SUPERSET OVERLAP CONFLICT
SEQUENCE RELATED NEW`); the real, load-bearing discovery this milestone made is that the
*existing, absolute* vetoes (§4.1 — "no learned weight may override them... keep the
gates") already determine which of those eight a pair can ever reach, and two of them
turn out to be structurally unreachable without loosening a veto this document says must
stay absolute. That is stated as a verified fact below, not an unstated gap — every claim
has a passing or failing test behind it in `tests/relations.test.mjs`.

- **F3 fixed in `lib/dedup/match.ts`'s `checkVetoes()`** (shared by the cascade and E3's
  FS scorer, so the fix reaches both by construction): antonym actions on artifacts that
  *do* overlap now return a new `conflict` verdict instead of collapsing into the same
  plain `distinct` every other veto produces. "Add auth middleware" and "Remove auth
  middleware" on the same file are not unrelated work; they always adjudicated to
  `distinct` before this milestone, which was safe (never a false merge) but silently
  discarded real information. Antonym actions on artifacts that share nothing still
  return plain `distinct`, unchanged — an antonym alone, with no concrete overlap to hang
  a conflict on, is exactly what `distinct` means. `bestMatch`'s ranking puts `conflict`
  above `possible`: a hard structural signal outranks a fuzzy lexical one when a proposal
  has both.
- **`lib/dedup/relations.ts`** (new): `classifyRelation(proposal, candidate)`, built
  directly on `checkVetoes` and E3's `computeFeatures`/f2/f3 signals rather than a third
  independent read of the same fields. A veto's own verdict passes straight through
  (`duplicate`→DUPLICATE, `conflict`→CONFLICT, plain `distinct`→NEW); pairs that survive
  the vetoes get set-algebra classification over artifact containment (SUBSET/SUPERSET
  at ≥0.8 containment, DUPLICATE at exactly-equal sets — agreeing with the cascade's own
  artifact-match rule rather than second-guessing it), Jaccard overlap (OVERLAP at
  ≥0.15), and title-wording Jaccard for RELATED (≥0.3, the same bar
  `THRESHOLDS.lexicalFloor` already uses) when no artifact is shared at all.
  **SEQUENCE is listed and mapped to a real edge type but never actually produced**:
  detecting it needs two *different, both-recognized* action classes on shared ground
  (add the retry logic, later test it) — and veto 2c already vetoes exactly that
  combination to `distinct` before Stage 3 ever runs, for any pair where neither action
  is `unknown`. The only way to make it reachable is loosening veto 2c, a separate design
  decision this milestone does not make. The same reasoning kills a subsystem-only
  RELATED case ("same directory, no shared file"): veto 2b (disjoint artifacts) fires
  regardless of subsystem, and `deriveSubsystem` can only produce a value from file-kind
  artifacts, so "same subsystem, disjoint artifacts" is unreachable too — RELATED is
  driven by lexical similarity alone. Documented in the module, not left as a silent
  limitation, and directly asserted by two tests in `relations.test.mjs`.
- **`lib/graph/edges.ts`**: `ANNOTATION_EDGE_TYPES` extended with `subset_of`,
  `superset_of`, `overlaps_with`, `follows` — the gate's "typed relations become edges,"
  literally. `follows` (SEQUENCE's edge, for whenever a future signal can produce it)
  stays an annotation, deliberately not a DAG edge: heuristically inferring a *hard*
  blocking dependency from an action-verb guess would risk the kind of silent
  mis-ordering this codebase has otherwise refused to accept. `dependencies.type` is
  free-form `TEXT` with no enum constraint, so this needed no migration, and
  `link_work_items`'s MCP schema picks up the four new types automatically since its
  `enum` is generated from `ANNOTATION_EDGE_TYPES` at read time.
- **Wired into proposal creation, not just available as a library function.**
  `lib/dedup/resolve.ts`'s `resolveProposals` computes `outcome.relation` for every
  proposal that creates a new item alongside a non-duplicate match (skipping a candidate
  still provisional in the same batch, since there is nothing in the database yet to
  link to). `lib/store.ts`'s `createWorkItemsDeduplicated` turns a non-CONFLICT relation
  into a real `add_dependency` edge from the new item to the match, and reports every
  relation (including CONFLICT's own direct edge) in the tool result. CONFLICT
  additionally needs a *decision* raised (the gate's other half), which can't happen
  inside `lib/store.ts` itself: `recordDecision` (`lib/planning/decisions.ts`) calls back
  into `lib/store.ts`'s own `executeCommand`/`organizationFor`, so `lib/store.ts`
  importing `decisions.ts` would be circular. The new `raiseConflictDecisions` in
  `decisions.ts` does that follow-up instead, called by `app/mcp/route.ts`'s
  `create_work_items` handler right after `createWorkItemsDeduplicated` returns — one
  decision per conflicting item, naming both the newly-created item and the existing one
  as options, reusing M19's decision machinery rather than a parallel write path.
- **A real correctness bug this milestone's own change would otherwise have introduced,
  caught before shipping:** `lib/simplify/analyze.ts`'s `findDuplicates` calls the same
  shared `adjudicate()` cascade to scan existing open work for duplicates to merge. Once
  `conflict` became a real verdict, its existing `if (verdict === "distinct") continue`
  filter would have let a conflict fall through into the possible-duplicate branch and
  propose `merge_items` for two items in direct structural conflict — actively wrong, not
  merely imprecise. Fixed with a new, informational-only `conflicting_work` finding kind
  (no `proposedCommand`; there is no `Command` variant for "raise a decision" for
  Simplify's structural pass to propose one-click, matching how `blocked_chain`/`stale`
  already stay informational) that names the conflict instead of silently discarding it
  or, worse, proposing to merge it away.

79 new tests: `tests/relations.test.mjs` (15 — every reachable relation type, the two
proven-unreachable ones asserted as unreachable with the reason why, `edgeTypeForRelation`'s
full mapping), `tests/relations-integration.test.mjs` (7, DB-backed — a typed relation
actually becomes a queryable edge through `createWorkItemsDeduplicated`, a CONFLICT
actually raises a decision with both items as options through `raiseConflictDecisions`,
and a no-relation proposal creates no edge), plus 2 new cases in `tests/dedup.test.mjs`
for the F3 fix and `bestMatch`'s conflict-beats-possible ranking. Full regression suite
(559 tests), typecheck, lint, and build all green — zero regressions in the cascade's
existing decisions, and the one behavior change the new `conflict` verdict could have
caused outside `match.ts` itself (Simplify's duplicate scan) was found and fixed as part
of this milestone, not left for a later one to discover.

## 13. Build order

Evaluation before features, always. Each step is releasable and measurable.

| | Step | Size | Gate to pass |
|---|---|---|---|
| **E0** | Evaluation harness, label capture, golden set from existing aliases and splits | M | Harness runs; today's engine has a measured baseline |
| **E1** | Blocking rebuild — artifact and rare-token indices, RRF, kill the recency window (F2) | M | Blocking recall@50 ≥ 99% |
| **E2** | Signature v2 — subsystem, criteria, qualifiers, synonym lexicon | M | No regression; ablation shows each new field's contribution |
| **E3** | Fellegi–Sunter scorer + offline weight training + calibration | L | Calibrated probabilities; false merges = 0; beats the cascade baseline |
| **E4** | Relation typing — SUBSET, SUPERSET, OVERLAP, CONFLICT (fixes F3) | M | Typed relations become edges; conflicts raise decisions |
| **E5** | Static embedding tier — token table, pgvector ANN, ablation | L | Ablation proves the paraphrase case improves; otherwise **delete it** |
| **E6** | Agent judgment tier (Tier A) + provider agreement auditing | M | Escalation rate < 5% of proposals; judgments agree with later human splits |
| **E7** | Repo grounding — tree-sitter symbols, subsystem tree, implementation overlap | L | Symbol-resolved artifacts measurably lift precision |
| **E8** | Unify Simplify and planning-context onto the one `relate()` module (§10) | M | One scorer, one weight file, one harness in the codebase |

E0 first is not ceremony. Without it, E3 and E5 are unfalsifiable, and this document's
central claim — that the removed embedding tier deserves a second look — would be exactly
the kind of assertion `§6.1` was written to prevent.

---

## Sources

- [Towards more accurate retrieval of duplicate bug reports (REP, Sun et al., ASE 2011)](https://dl.acm.org/doi/abs/10.1109/ASE.2011.6100061)
- [Automated Duplicate Bug Report Detection in Large Open Bug Repositories (2025 benchmark)](https://arxiv.org/html/2504.14797v1)
- [Cupid: Leveraging ChatGPT for More Accurate Duplicate Bug Report Detection](https://arxiv.org/html/2308.10022v3)
- [The Fellegi-Sunter Model — Splink](https://moj-analytical-services.github.io/splink/topic_guides/theory/fellegi_sunter.html)
- [Splink: probabilistic record linkage at scale](https://github.com/moj-analytical-services/splink)
- [Model2Vec: fast state-of-the-art static embeddings](https://github.com/MinishLab/model2vec)
- [potion-base-8M model card](https://huggingface.co/minishlab/potion-base-8M)
- [The pgvector extension — Neon](https://neon.com/docs/extensions/pgvector)
- [Hybrid search: BM25 + pgvector with RRF](https://dev.to/gabrielanhaia/hybrid-search-in-100-lines-bm25-pgvector-with-rrf-merge-58cn)
- [onnxruntime-node too large for Next.js API routes](https://github.com/huggingface/transformers.js/issues/1164)
- [Vercel 250 MB function size limit](https://vercel.com/kb/guide/troubleshooting-function-250mb-limit)
- [MCP 2026-07-28 specification — MRTR, deprecations](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [MCP 2026-07-28: every breaking change](https://stacktr.ee/blog/mcp-2026-spec-changes)
- [Tree-sitter vs SCIP for incremental code indexing](https://github.com/orgs/sheeptechnologies/discussions/4)
