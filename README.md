# Planbraid

Planbraid is a unified, source-aware todo workspace for projects being developed across Codex, Claude Code, Gemini CLI, GitHub Copilot, and other MCP-capable agents.

The working Web UI and MCP server live in `apps/web`. The UI provides project/coding-space navigation, source sessions, a unified activity stream, board/list/inbox/agent views, task lifecycle mutations, evidence, notifications, optimistic concurrency, and agent-token setup. The same durable command layer powers the Web API and MCP tools.

Work items form a dependency graph, not just a status field: a task that only becomes actionable once its prerequisites are done shows as blocked automatically, and moves to ready by itself the moment its last blocker resolves, with no separate write and no stale state. Proposals from independent agents are matched against existing work before creating anything, so restating a task collapses into the original instead of cluttering the board.

See `PRODUCT_ARCHITECTURE_PLAN.md` for the canonical architecture, `IMPLEMENTATION_PLAN.md` for what has shipped against it and in what order, and `AGENTS.md` for implementation rules. `GRAPH_ARCHITECTURE.md` and `DEDUPLICATION_ARCHITECTURE.md` cover the dependency graph and proposal-matching design in detail.

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

Core tools include project resolution/briefs, task create/update/start/block/progress/completion/reopen/search, `get_ready_work` for ranked, graph-aware "what's actionable now", `link_work_items` for declaring dependencies, session registration/heartbeat/end, and interaction start/synchronization.

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

The app is a standard Next.js application, deployed on Vercel with a Postgres database (Neon). Every push to `main` on the connected GitHub repo auto-deploys via Vercel's native Git integration; pull requests get preview deployments. Localhost is the only anonymous demo environment — hosted access always requires an account.
