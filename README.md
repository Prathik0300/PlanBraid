# Planbraid

Planbraid is a unified, source-aware todo workspace for projects being developed across Codex, Claude Code, Gemini CLI, GitHub Copilot, and other MCP-capable agents.

The working Web UI and MCP server live in `apps/web`. The UI provides project/coding-space navigation, source sessions, a unified activity stream, board/list/inbox/agent views, task lifecycle mutations, evidence, notifications, optimistic concurrency, and agent-token setup. The same durable command layer powers the Web API and MCP tools.

Work items form a dependency graph, not just a status field: a task that only becomes actionable once its prerequisites are done shows as blocked automatically, and moves to ready by itself the moment its last blocker resolves, with no separate write and no stale state. Proposals from independent agents are matched against existing work before creating anything, so restating a task collapses into the original instead of cluttering the board.

See [`docs/architecture/PRODUCT_ARCHITECTURE_PLAN.md`](docs/architecture/PRODUCT_ARCHITECTURE_PLAN.md) for the canonical architecture, [`docs/plans/IMPLEMENTATION_PLAN.md`](docs/plans/IMPLEMENTATION_PLAN.md) for what has shipped against it and in what order, and `AGENTS.md` for implementation rules. [`docs/architecture/GRAPH_ARCHITECTURE.md`](docs/architecture/GRAPH_ARCHITECTURE.md) and [`docs/architecture/DEDUPLICATION_ARCHITECTURE.md`](docs/architecture/DEDUPLICATION_ARCHITECTURE.md) cover the dependency graph and proposal-matching design in detail.

Planned work is covered by four further documents. [`docs/plans/PLANNING_INTELLIGENCE_ROADMAP.md`](docs/plans/PLANNING_INTELLIGENCE_ROADMAP.md) sequences the whole roadmap and lists what is half-built. [`docs/architecture/RECONCILIATION_ARCHITECTURE.md`](docs/architecture/RECONCILIATION_ARCHITECTURE.md) specifies the reconciliation engine — the core module every other feature consumes. [`docs/architecture/PLAN_VERSION_CONTROL.md`](docs/architecture/PLAN_VERSION_CONTROL.md) covers the plan as a content-addressed operation log with conflicts as first-class objects, and where source control is authoritative. [`docs/architecture/CAPTURE_ARCHITECTURE.md`](docs/architecture/CAPTURE_ARCHITECTURE.md) covers keeping Planbraid current by subscribing to the agent's harness rather than asking the model to remember.

See [`docs/README.md`](docs/README.md) for the full documentation index, including the integration and Slack rollout plans.

## Local development

```text
cd apps/web
npm ci
cp .env.example .env.local   # fill in DATABASE_URL (Neon or any Postgres) and the rest
npm run dev
```

Open `http://localhost:3000`. The local development environment seeds a multi-agent Planbraid project on first use.

## MCP

The Streamable HTTP/JSON-RPC endpoint is `/mcp`. Localhost permits the development principal. Hosted clients use a bearer token generated from **Connect agent** in the Web UI.

Core tools include project resolution/creation/briefs (`resolve_project`, `create_project` to bind a project to a repository directory, `get_project_brief`), task create/update/start/block/progress/completion/reopen/search, `get_ready_work` for ranked, graph-aware "what's actionable now", `link_work_items` for declaring dependencies, session registration/heartbeat/end, and interaction start/synchronization.

Provider hook templates and the local bridge are under `integrations/`.

Detailed provider, lifecycle-hook, token, capture-assurance, and Web Push setup is in `integrations/README.md`.

## Validation

```text
cd apps/web
npm run typecheck
npm run lint
npm test
```

`npm test` runs the domain-logic suites (deduplication, dependency graph, auto-unblock, ready-work ranking, derived board columns — against a real embedded Postgres, see `tests/support/local-pg.mjs`), then builds and runs the rendered-HTML/build suite.

The app is a standard Next.js application, deployed on Vercel with a Postgres database (Supabase). Every push to `main` on the connected GitHub repo auto-deploys via Vercel's native Git integration; pull requests get preview deployments. Localhost is the only anonymous demo environment — hosted access always requires an account.
