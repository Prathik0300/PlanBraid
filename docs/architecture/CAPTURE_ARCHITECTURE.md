# Capture Architecture

*Once a user connects Planbraid to their AI model, they should never have to tell that
model to update Planbraid. Planbraid should make it happen.*

The current design asks the model to cooperate. `AGENTS.md` instructs it, the MCP server's
`instructions` string reminds it, and `sources.assurance` records — honestly, and a little
sadly — that most sessions are only `instructed`, because "the model must remember to call
`sync_interaction` before responding."

That is the wrong layer. Instruction-following is probabilistic; the harness is not.

> **The principle: stop asking the model to report. Observe the harness, and gate the
> exit.**

Every provider worth supporting now exposes lifecycle hooks that fire deterministically,
carry structured payloads, and — critically — can **block**. Claude Code exposes
[30 hook events](https://code.claude.com/docs/en/hooks); Codex CLI reached
[hooks GA in May 2026](https://blakecrosley.com/blog/codex-hooks-make-the-harness-real)
with a `PermissionRequest` event that can deny. The bridge that Planbraid already ships
(`integrations/bridge/planbraid-hook.mjs`) is the right vehicle and currently uses a
fraction of what is available.

---

## 1. Four layers, by how much cooperation they require

| Layer | Needs the model to… | Delivers |
|---|---|---|
| **L0 · Inject** | nothing | Planning context reaches the agent before it plans |
| **L1 · Observe** | nothing | The plan the model actually made, the files it actually changed |
| **L2 · Gate** | nothing, but it feels the consequence | The turn cannot end with the plan unrecorded |
| **L3 · Enforce** | nothing; it is prevented | Collisions and unleased work are blocked before the edit |

L0 and L1 need **zero** agent cooperation. That is the finding that reframes this whole
problem: the highest-value feature in the roadmap — pre-planning intelligence — does not
need the agent to call a tool at all.

---

## 2. L0 — Injection

### 2.1 Session start

`SessionStart` fires when a session begins or resumes, carrying `session_id`, `cwd`, and
`transcript_path`. The hook returns:

```json
{ "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "PLANBRAID · acme-api\n3 in progress · 2 blocked · 1 decision open\nCodex · work holds #31 (refresh-token rotation) since 19:32.\nRejected 2026-07-30: shared HS256 secrets — service isolation.\n…" } }
```

Claude reads `additionalContext` and incorporates it into the session. The agent now
starts every session knowing the project's planning state, whether or not it ever calls an
MCP tool.

### 2.2 Every prompt

`UserPromptSubmit` fires before the model sees the prompt, and carries `user_input`. The
bridge sends that text to `get_planning_context` and injects the response.

**This is roadmap feature 3, delivered without the agent's participation.** The MCP tool
`get_planning_context` becomes the fallback for clients without hooks, not the primary
path — which inverts the risk that was the feature's biggest weakness ("agents ignore the
tool"). A hook cannot be ignored.

Budget: the injection must not slow the turn. Cap at 250ms and ~1,200 tokens, degrade to
nothing on timeout. The bridge already holds a 2.5s ceiling and prints a degraded-capture
warning rather than blocking; hold that doctrine here.

### 2.3 After compaction

`PostCompact` fires when context has just been summarized away. Re-inject the brief. This
is where long sessions currently lose the plan — the model forgets what it recorded three
hours ago and re-proposes it. One hook closes a real failure mode.

---

## 3. L1 — Observation

### 3.1 The agent's own todo list, mirrored

`TaskCreated` and `TaskCompleted` fire when the agent uses its internal task tool, and
carry `task_id`, `task_title`, `task_description`, and `completion_notes`.

This is the single most valuable capture point in the entire design, and it is currently
unused:

> **It is the plan the model actually made, not the plan it remembered to report.**

Every such task becomes a Planbraid proposal with provenance `ai_inferred` and
`maturity='proposal'`, routed through the reconciliation engine like any other. The
agent's private plan and the shared plan stop being different artifacts. `TaskCompleted`
becomes a completion *claim* — never a verified completion — which lands in review
awaiting evidence, exactly as `report_completion` does.

Both events can be blocked with exit 2, which is the L3 hook for "you are about to create
work that duplicates #31."

### 3.2 What the agent actually changed

`PostToolUse` carries `tool_name`, `tool_input` and `tool_result`. Three matchers cover
almost everything:

| Matcher | Extract | Feeds |
|---|---|---|
| `Edit\|Write\|MultiEdit\|NotebookEdit` | file paths from `tool_input` | Scope, collision detection (13), evidence (6) |
| `Bash` | command + exit status from `tool_result` | Test evidence, verification (6) |
| `Task` / `SubagentStop` | `last_assistant_message` | Progress notes |

`PostToolBatch` gives the whole parallel batch at once and is the cheaper subscription for
high-volume sessions. `FileChanged` catches edits made outside the agent entirely — the
human's own commits, in the same session.

None of this asks the model for anything. It is a strictly better signal than a
self-report, because it is the record of what happened rather than a summary of what the
model believes happened.

### 3.3 The assurance ladder finally means something

`sources.assurance` already ships with values `enforced | observed | instructed | manual`
and is currently close to decorative. Wire it to which layers are actually live:

| Value | Condition |
|---|---|
| `enforced` | L2 gating active — the turn cannot end unrecorded |
| `observed` | L1 active — file changes and task events captured |
| `instructed` | MCP only — the model must remember |
| `manual` | Typed by a person |

Then the UI can say, truthfully and per agent, *"this agent's work is observed, not merely
instructed."* That is a real trust distinction, it is the honest presentation of a
probabilistic mechanism, and it costs one mapping function.

---

## 4. L2 — Gating the exit

`Stop` fires when the agent finishes responding. It carries `last_assistant_message` and
`stop_hook_active`, and it can return `decision: "deny"` with a `reason` that the model
reads as an instruction, forcing continuation.

The rule:

```
on Stop:
  if stop_hook_active: allow            # never loop; one block per turn, maximum
  if Planbraid unreachable: allow       # never hold a user's agent hostage to our uptime
  if this turn changed files under the project
     and no Planbraid write occurred this turn:
        deny with a reason naming exactly what to record
  else allow
```

The reason string is the whole craft here. Not "update Planbraid" — an instruction with no
referent produces a shrug and a retry. Instead:

> *You edited `lib/auth/tokens.ts` and `lib/oauth.ts` this turn but recorded nothing in
> Planbraid. #31 "Implement refresh-token rotation" covers those files and is in progress
> under this session. Call `report_progress` on #31, or `create_work_items` if this was
> different work.*

Three guardrails, all non-negotiable:

- **`stop_hook_active` is checked first.** Without it this is an infinite loop, and the
  hook documentation is explicit about it.
- **One block per turn.** A second failure logs and allows.
- **Failing open on our outage.** The bridge's existing promise — a Planbraid outage never
  blocks the coding agent — is the correct doctrine and this is the place it would be most
  tempting to break.

`StopFailure` (rate limit, overload, auth) must *not* gate: the turn died for reasons that
have nothing to do with recording, and blocking there would strand the user.

---

## 5. L3 — Prevention (opt-in)

`PreToolUse` can deny a tool call before it runs; Codex's `PermissionRequest` can `deny`,
and any deny wins among matching hooks. That makes true prevention possible:

- **Unleased work.** An `Edit` touching files owned by an item another live session holds
  is denied, with the holder named. This is roadmap feature 12 and 13 with actual teeth,
  rather than a warning nobody reads.
- **Rejected approaches.** An edit re-introducing something an active decision rejected is
  denied with the decision and its reason.

This is the strictest setting in the product and it will occasionally be wrong. It ships
**off**, behind an explicit project policy, and every denial is recorded as an event so
the false-positive rate is measurable. A gate that cannot be measured cannot be tuned.

---

## 6. Provider coverage

| Provider | L0 | L1 | L2 | L3 | Mechanism |
|---|---|---|---|---|---|
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | 30 hook events; `additionalContext`; `decision: "deny"`; exit-2 blocks |
| **Codex CLI** | ✅ | ✅ | partial | ✅ | Hooks GA May 2026; `PermissionRequest` deny; five lifecycle events |
| **Cursor / Copilot** | partial | partial | ✗ | ✗ | Rules files + MCP; injection via server `instructions` and tool descriptions |
| **Gemini CLI** | ✗ | ✗ | ✗ | ✗ | `GEMINI.md` instructions + MCP only — stays `instructed` |

Design consequence: **the bridge must degrade by layer, not by provider.** One capability
probe at session start, a recorded assurance level, and every feature written so its
absence is a downgrade rather than a break. A user on Gemini gets today's product; a user
on Claude Code gets a product that cannot forget.

---

## 7. Idempotency, ordering, and failure

Hook delivery is at-least-once and unordered in practice. The bridge already treats it
that way. Three requirements:

- **Content-addressed writes.** `PLAN_VERSION_CONTROL.md §3`'s op hashes make every
  hook-driven write exactly-once by construction. Until that lands, derive the idempotency
  key from `(session_id, prompt_id, tool_use_id)`, all of which the payloads carry.
- **Local queue.** The bridge already keeps state under `~/.planbraid/bridge` with
  owner-only permissions and atomic writes. Extend it to a durable outbox so a turn's
  observations survive an outage and replay on the next hook.
- **Bounded payloads.** Everything sent is capped and truncated; the existing `bounded()`
  helper is the pattern.

---

## 8. Privacy — the line that must not move

Hooks can see the user's prompts, tool outputs, and file contents. Planbraid must not.

| Sent | Never sent |
|---|---|
| File **paths**, capped and count-limited | File contents, diffs |
| Command names and exit statuses | Command output beyond a bounded summary |
| Task titles and descriptions the agent itself authored | Prompts, transcripts, assistant messages verbatim |
| Commit shas, branch names | Repository contents |

The bridge's existing promise — *"it never opens provider transcript files"* — is the
standard, and the capture layer must be able to make the same claim. Two concrete
requirements: a documented `PLANBRAID_CAPTURE` env setting with `off | observe | enforce`,
and per-project opt-out of path reporting for people working in sensitive repositories.

This is also a positioning argument. A competitor that reads conversations will always
know more; a product that reads only the harness can be adopted by people who would never
allow the first kind.

---

## 9. What this does to the roadmap

| Feature | Before | After |
|---|---|---|
| 3 · Pre-planning intelligence | An MCP tool agents must remember to call | Injected on every prompt, automatically (§2.2) |
| 6 · Proof-of-work | Evidence the agent chooses to attach | Observed file changes and test exits (§3.2) |
| 10 · Proposal ≠ task | Only what the agent reports | The agent's own todo list, mirrored (§3.1) |
| 12 / 13 · Leases and collisions | A warning in a tool response | A denied edit (§5) |
| 14 · Session identity | Registered when the agent remembers | Registered at `SessionStart`, always |
| 17 · Loop detection | Needs restatements to be reported | Every internal task creation is visible |

Two of those move from "depends on model cooperation" to "structurally guaranteed", which
is the difference between a feature and a claim.

---

## 10. Build order

| | Step | Size | Done when |
|---|---|---|---|
| **C0** | Bridge capability probe; assurance ladder wired to live layers | S | The UI states each agent's real capture level |
| **C1** | L0 injection: `SessionStart` + `UserPromptSubmit` + `PostCompact` | M | An agent that never calls an MCP tool still plans with project context |
| **C2** | L1 observation: `TaskCreated`/`TaskCompleted` → proposals | M | The agent's internal plan appears on the board, deduplicated, attributed |
| **C3** | L1 observation: `PostToolUse`/`PostToolBatch`/`FileChanged` → scope and evidence | M | Completion claims carry observed file changes without the agent attaching them |
| **C4** | Durable outbox + content-addressed idempotency | S | A Planbraid outage loses nothing; replays are exact |
| **C5** | L2 gating on `Stop`, with the three guardrails | M | A code-changing turn cannot end unrecorded; no loops; outages fail open |
| **C6** | Codex parity for C1–C5 | M | Same layers, same assurance reporting |
| **C7** | L3 prevention behind project policy, with denial telemetry | M | Collisions are prevented; false-positive rate is visible |

C1 and C2 are the two that change what the product *is*. C5 is the one that will generate
the most user feedback, positive and negative, and it should not ship before C1–C3 have
made the recorded state good enough to be worth being held to.

---

## Sources

- [Claude Code hooks reference — all events, payloads, and decision control](https://code.claude.com/docs/en/hooks)
- [Claude Code hooks: 30 lifecycle events](https://claudefa.st/blog/tools/hooks/hooks-guide)
- [Stop hook task enforcement and stop_hook_active](https://claudefa.st/blog/tools/hooks/stop-hook-task-enforcement)
- [Codex hooks make the harness real](https://blakecrosley.com/blog/codex-hooks-make-the-harness-real)
- [Codex CLI hooks and AGENTS.md](https://ai.sulat.com/codex-cli-has-hooks-now-stop-stuffing-agents-md-c181465fe271)
- [MCP 2026-07-28 specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
