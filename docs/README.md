# Planbraid documentation

Design and planning documents for Planbraid, split into two folders:

- **`architecture/`** — what the system is and why: canonical specs for how each part is designed.
- **`plans/`** — what ships and in what order: roadmaps and implementation status against the architecture.

Start with `AGENTS.md` (repo root) for contribution rules, and the root `README.md` for how to run the app.

## Architecture

| Document | Covers |
|---|---|
| [`PRODUCT_ARCHITECTURE_PLAN.md`](architecture/PRODUCT_ARCHITECTURE_PLAN.md) | The canonical product and implementation specification. Read this first. |
| [`GRAPH_ARCHITECTURE.md`](architecture/GRAPH_ARCHITECTURE.md) | The work-item dependency graph: blocked/ready derivation, auto-unblock. |
| [`DEDUPLICATION_ARCHITECTURE.md`](architecture/DEDUPLICATION_ARCHITECTURE.md) | Matching new proposals against existing work so restating a task collapses into the original. |
| [`RECONCILIATION_ARCHITECTURE.md`](architecture/RECONCILIATION_ARCHITECTURE.md) | The reconciliation engine — the core module the dedup layer and others consume. |
| [`PLAN_VERSION_CONTROL.md`](architecture/PLAN_VERSION_CONTROL.md) | The plan as a content-addressed operation log, with conflicts as first-class objects. |
| [`CAPTURE_ARCHITECTURE.md`](architecture/CAPTURE_ARCHITECTURE.md) | Keeping Planbraid current by subscribing to the agent's harness rather than asking the model to remember. |
| [`CLIENT_QUERY_CACHE_ARCHITECTURE.md`](architecture/CLIENT_QUERY_CACHE_ARCHITECTURE.md) | The web client's data-fetching layer (TanStack Query, revision-aware reads). Implemented. |
| [`LOCAL_MODE_ARCHITECTURE.md`](architecture/LOCAL_MODE_ARCHITECTURE.md) | Self-hosting and an on-device deployment mode, evaluated against privacy requirements. |

## Plans

| Document | Covers |
|---|---|
| [`IMPLEMENTATION_PLAN.md`](plans/IMPLEMENTATION_PLAN.md) | One ordered plan across the architecture documents: what has shipped, milestone by milestone. |
| [`PLANNING_INTELLIGENCE_ROADMAP.md`](plans/PLANNING_INTELLIGENCE_ROADMAP.md) | Sequences the whole planning-intelligence roadmap and lists what is half-built. |
| [`INTEGRATIONS_IMPLEMENTATION_PLAN.md`](plans/INTEGRATIONS_IMPLEMENTATION_PLAN.md) | Product requirements for third-party work-system integrations (Basecamp, Jira, Slack). |
| [`SLACK_INTEGRATION_PLAN.md`](plans/SLACK_INTEGRATION_PLAN.md) | Implementation plan for the Slack integration specifically, against this repository's actual state. |
