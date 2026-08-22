# Planbraid Client Query Cache Architecture

Status: implemented in `apps/web` (TanStack Query v5).

This decision implements the client-data direction already specified in
`PRODUCT_ARCHITECTURE_PLAN.md`: TanStack Query, revision-aware project reads, and
targeted realtime invalidation. The cache is a latency and request-deduplication layer;
Postgres and the server's authorization checks remain authoritative.

## Decision

Planbraid uses one in-memory `QueryClient` per authenticated application mount. The
provider is mounted below `AuthGate` and keyed by the signed-in user ID. Signing out or
changing user destroys the entire client cache. Query persistence to local storage is
deliberately disabled so private project or integration data cannot survive an account
boundary on a shared browser.

All cached HTTP requests still use `cache: "no-store"`. Browser/CDN caching is not an
authorization boundary and must not store authenticated JSON. TanStack Query provides
the scoped in-memory cache after the server has authorized and returned the response.

## Query-key contract

Keys live in `apps/web/lib/query-keys.ts`; request and provider policy lives in
`apps/web/lib/query-cache.tsx`.

| Data | Key shape | Fresh for | Invalidation source |
|---|---|---:|---|
| Dashboard state | `dashboard` | 15 seconds | successful commands, SSE events, stale focus/reconnect |
| Derived project reads | `project/{id}/{revision}/{view}` | 2 minutes | a new project revision naturally creates a new key |
| Work-item explanation | `work-item/{id}/{version}/explanation` | 2 minutes | a new item version naturally creates a new key |
| Integration connections/bindings | `project/{id}/integrations` | 30 seconds | connect, disconnect, sync, import, channel changes |
| Provider accounts/projects/channels | `integration/{provider}/{connection}/...` | 5 minutes | connection removal or explicit refresh |
| Candidate review queue | `integration/binding/{id}/candidates` | 30 seconds | sync, import, or ignore |
| GitHub/account configuration | `account/...` | 5 minutes | disconnect or account change |
| MCP/OAuth connections | `account/...` | 30 seconds | generate, rename, or revoke |

Every parameter that can change the response belongs in the key. Project-derived
responses include the server revision or entity version, avoiding broad invalidation and
preventing an old explanation or plan from being shown as current.

## Request lifecycle

1. Components ask TanStack Query for a stable key.
2. Concurrent consumers of that key share one in-flight promise.
3. Fresh data is returned from memory without an HTTP request.
4. Stale active data is refreshed on window focus or network reconnect.
5. Successful writes invalidate only the dashboard and affected feature key families.
6. SSE events debounce dashboard invalidation. EventSource handles reconnect; there is
   no unconditional polling loop while realtime is healthy.

Queries retry at most twice and only for server-side/transport failures. Authentication,
authorization, validation, and other client errors are not retried. Mutations never
retry automatically because writes need explicit idempotency semantics.

## Correctness and failure behavior

- Cache entries never bypass server authentication or tenant filtering.
- Mutations update or invalidate cache only after a successful server response.
- Realtime messages are invalidation hints, not authoritative state patches.
- If SSE is temporarily unavailable, stale-aware focus/network refresh still recovers;
  a future cursor/backoff fallback can be added without changing query keys.
- A failed background refresh can leave the last successful value visible, while a
  first-load failure uses the existing error UI.
- Ten minutes after becoming unused, cached entries are garbage-collected.

## Migration boundary

The dashboard, project-derived views, work-item explanations, GitHub discovery,
integration discovery/review, and MCP/OAuth connection lists use this architecture.
Write endpoints remain explicit commands and are not converted into an opaque generic
mutation abstraction; their domain-specific idempotency keys and error handling remain
visible at each call site.

New authenticated GET endpoints should use `fetchData` plus a key from `query-keys.ts`.
New writes must document which keys they invalidate. Do not introduce another component-
local polling or fetch-on-mount path for server state.

## Verification

`tests/query-cache.test.mjs` proves concurrent request sharing, fresh-cache reuse,
invalidation-driven refresh, and revision-key separation. Normal repository typecheck,
build, and rendered-HTML tests cover provider placement and UI integration.
