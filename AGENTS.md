# Planbraid repository guidance

Read [`docs/architecture/PRODUCT_ARCHITECTURE_PLAN.md`](docs/architecture/PRODUCT_ARCHITECTURE_PLAN.md) before changing architecture or beginning a work package. It is the canonical product and implementation specification. [`docs/plans/IMPLEMENTATION_PLAN.md`](docs/plans/IMPLEMENTATION_PLAN.md) tracks what has actually shipped against it, milestone by milestone, and is the more current reference for present state. See [`docs/README.md`](docs/README.md) for the full documentation index.

For project work, Planbraid is the source of truth:

- retrieve the project brief before planning;
- reuse task IDs and avoid duplicate plans; `create_work_items` already matches proposals against existing work, so trust its `matched`/`resembles` results instead of assuming a new item was created;
- prefer `get_ready_work` over `list_work_items` when deciding what to work on next; it excludes graph-blocked and already-claimed items and ranks by how much finishing something unlocks;
- record accepted work, start, blockers, material progress, evidence, completion, and reopening through Planbraid MCP tools;
- declare ordering dependencies with `link_work_items` (or `depends_on` inline in `create_work_items`) rather than only describing them in free text; blocked-by-dependency status is derived from these edges and resolves itself once the prerequisite completes;
- sync every interaction before the final response;
- never mark implementation verified without evidence;
- preserve provenance, idempotency keys, and expected versions.

The current working Web/MCP application is in `apps/web`.

Verification commands:

```text
cd apps/web
npm run build
npm test
./node_modules/.bin/tsc --noEmit --pretty false
```

`npm test` runs the domain-logic suites (deduplication, dependency graph, auto-unblock propagation, ready-work ranking, derived board columns — against a real embedded Postgres, see `tests/support/local-pg.mjs`), then builds and runs the rendered-HTML/build suite.

Do not put secrets into repository files, hook configs, logs, or command-line arguments. Use `PLANBRAID_TOKEN` and other credential environment variables (the bridge also reads `RELAYBOARD_TOKEN` etc. as a one-release fallback; prefer `PLANBRAID_*` in new setups).
