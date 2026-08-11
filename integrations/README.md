# Connect coding agents to Planbraid

Planbraid uses two complementary connections:

1. The MCP connection gives an agent authoritative project and work-item tools.
2. A provider lifecycle hook calls the local bridge at the start and end of every turn, so even a turn with no task mutation is reconciled and surfaced in the unified stream.

## Shared environment

Set these in the environment that starts the coding agent. Keep the token out of checked-in configuration and command-line history.

```text
PLANBRAID_MCP_URL=https://YOUR_PLANBRAID_HOST/mcp
PLANBRAID_PROJECT_ID=prj_...
PLANBRAID_TOKEN=pbd_...
PLANBRAID_BRIDGE_PATH=/absolute/path/to/integrations/bridge/planbraid-hook.mjs
PLANBRAID_PROVIDER=codex
```

Generate the token from **Connect agent** in Planbraid. The local development server at `http://localhost:3000/mcp` intentionally permits the local demo identity, so `PLANBRAID_TOKEN` is optional there.

An owner-private Sites deployment can require a second platform gate header before the request reaches Planbraid. Set `PLANBRAID_SITE_BYPASS_TOKEN` for the bridge, or add `OAI-Sites-Authorization: Bearer $PLANBRAID_SITE_BYPASS_TOKEN` to the MCP client's secret-backed headers. This is separate from `PLANBRAID_TOKEN`: the site credential reaches the private worker, while the Planbraid token authorizes project data.

The bridge also reads the older `RELAYBOARD_*` names as a fallback if the `PLANBRAID_*` variant is unset, for anyone who configured this before the rename. Prefer `PLANBRAID_*` in new setups.

## MCP client configuration

Start from `.mcp.json.example`. MCP clients that support Streamable HTTP should point to `/mcp` and send `Authorization: Bearer $PLANBRAID_TOKEN`. If a host does not interpolate environment variables in headers, use its secret store rather than putting the token in the repository.

On first use, the agent should call `resolve_project`, `get_project_brief`, and `register_agent_session`. It should preserve returned project, source, and work-item IDs across later calls.

## Provider hook templates

- Claude Code: merge `claude/settings.json` into the project or user settings file and set `PLANBRAID_PROVIDER=claude`.
- Codex: merge `codex/hooks.json` into the host hook configuration and set `PLANBRAID_PROVIDER=codex`.
- GitHub Copilot coding agent: adapt `copilot/hooks.json` to the repository hook configuration and set `PLANBRAID_PROVIDER=copilot`.
- Gemini CLI: add the instructions from `gemini/GEMINI.md`; use the MCP lifecycle calls directly when the host does not expose stable lifecycle hooks.

Hook schemas change independently across providers. The bridge deliberately accepts the common snake-case, kebab-case, and camel-case event/session keys and treats hook delivery as at-least-once. Planbraid deduplicates sources, interactions, notifications, and mutations at the server boundary.

## Capture guarantees

The hook bridge stores only a small session-to-source mapping under `~/.planbraid/bridge` (or `PLANBRAID_STATE_DIR`). It never opens provider transcript files. Cache files use owner-only permissions and are written atomically. A temporary Planbraid outage does not block the coding agent; the hook prints a short degraded-capture warning and exits successfully.

Sessions with working start/stop hooks are shown as **enforced**. MCP-only integrations are shown as **instructed**, because the model must remember to call `sync_interaction` before responding.

## Web Push configuration

Production deployments need one VAPID key pair in the Sites environment:

```text
VAPID_PUBLIC_KEY=URL_SAFE_PUBLIC_KEY
VAPID_PRIVATE_KEY=URL_SAFE_PRIVATE_KEY
VAPID_SUBJECT=mailto:your-operations-address@example.com
```

The UI exposes only the public key. The private key stays in the runtime secret store. Expired browser endpoints are disabled automatically. Push payloads contain only the notification title, bounded summary, priority, and a Planbraid deep link.
