import { createMcpHandler } from "@modelcontextprotocol/server";
import type { PgD1 } from "@/db/pg-d1";
import { ensureSchema } from "@/db/setup";
import { principalFromBearer } from "@/lib/store";
import { agentAccountKey, normalizeAccountLabel } from "@/lib/providers.ts";
import { oauthChallenge } from "@/lib/oauth";
import { env as runtimeEnv } from "@/lib/runtime-env";
import type { PushEnvironment } from "@/lib/push";
import { buildMcpServer, rpcScope } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";
// Default function duration (10s) isn't enough room for executeCommand's waitUntil-based
// Slack drain kick (see lib/store.ts's kickSlackDrain), triggered by MCP tool calls like
// block_work/report_completion exactly as it is from the browser's /api/commands.
export const maxDuration = 30;

type Env = PushEnvironment & { DB: PgD1 };
type RpcId = string | number | null;

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"];

async function handleMcp(request: Request, env: Env) {
  await ensureSchema(env.DB);
  const url = new URL(request.url);
  // Built from the origin plus a literal path, so the ?agent= marker below never
  // participates in OAuth resource matching.
  const resource = `${url.origin}/mcp`;
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  // How two CLI aliases sharing one credential tell themselves apart: each alias points
  // at .../mcp?agent=<name> in its own MCP config. Purely a label within an
  // already-authenticated account, and grants no access of its own.
  const agentMarker = url.searchParams.get("agent");
  const authorization = request.headers.get("authorization");
  const principal = await principalFromBearer(env.DB, authorization, resource, agentMarker) ?? (local && !authorization ? { userId: "local-demo-user", email: "you@planbraid.local", displayName: normalizeAccountLabel(agentMarker) ?? "Local agent", agentAccountId: agentAccountKey("local-demo", agentMarker) ?? undefined, agentAccountLabel: normalizeAccountLabel(agentMarker) ?? undefined, scopes: ["work:read", "work:write"], authentication: "local" as const } : null);
  if (request.method === "GET") {
    if (!principal) return Response.json({ error: "authentication_required" }, { status: 401, headers: { "WWW-Authenticate": oauthChallenge(request), "cache-control": "no-store" } });
    return Response.json({ name: "Planbraid MCP", status: "ok", protocolVersions: PROTOCOL_VERSIONS }, { headers: { "cache-control": "no-store" } });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 256_000) return rpcError(null, -32600, "Request body is too large", 413);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return rpcError(null, -32003, "Cross-origin browser requests are not allowed", 403);

  // Read the body once as text so it can both be inspected here (for the pre-dispatch
  // notification/auth/scope checks below, which need to see the id, method, and, for
  // tools/call, the tool name before the SDK ever runs) and be handed unchanged to the
  // SDK's handler.fetch, which reads the Request's own body stream and would otherwise
  // find it already consumed.
  const bodyText = await request.text().catch(() => null);
  if (bodyText === null) return rpcError(null, -32700, "Parse error", 400);
  let rpc: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try { rpc = JSON.parse(bodyText); }
  catch { return rpcError(null, -32700, "Parse error", 400); }
  if (!rpc.method) return rpcError(null, -32600, "Invalid request", 400);

  // JSON-RPC notifications (no "id", e.g. notifications/initialized) never get a response
  // body under the Streamable HTTP transport spec, and get one here regardless of auth
  // status: fire-and-forget, reveals nothing, and answering with a 401 instead would just
  // confuse a client wondering why its notifications fail. Strict clients (rmcp, used by
  // Codex Desktop) drop the whole connection if they get anything else back.
  if (rpc.id === undefined) return new Response(null, { status: 202 });
  const rpcId = (typeof rpc.id === "string" || typeof rpc.id === "number" ? rpc.id : null) as RpcId;

  if (!principal) return rpcError(rpcId, -32001, "Authentication required", 401, { "WWW-Authenticate": oauthChallenge(request) });
  const toolName = rpc.method === "tools/call" ? String(rpc.params?.name ?? "") : undefined;
  const requiredScope = rpcScope(rpc.method, toolName);
  if (requiredScope && !principal.scopes?.includes(requiredScope)) return rpcError(rpcId, -32003, `The ${requiredScope} scope is required`, 403, { "WWW-Authenticate": `${oauthChallenge(request, [...new Set([...(principal.scopes ?? []), requiredScope])].join(" "))}, error="insufficient_scope"` });

  // Everything past this point, initialize, notifications/* (a bare 202, no body),
  // server/discover, ping, and dispatching tools/list, tools/call, resources/*, and
  // prompts/* to buildMcpServer's handlers, is the SDK's job. It owns exactly the
  // transport/protocol layer that produced three separate Codex-discovered incidents
  // (a redirect silently dropping the OAuth token exchange, replying to a notification
  // with a response envelope rmcp couldn't parse) when this was hand-rolled.
  const handler = createMcpHandler(() => buildMcpServer(env.DB, env, principal), { responseMode: "json" });
  const forwarded = new Request(request.url, { method: "POST", headers: request.headers, body: bodyText });
  return handler.fetch(forwarded);
}

function rpcError(id: RpcId, code: number, message: string, status: number, headers?: Record<string, string>) { return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status, headers: { "MCP-Protocol-Version": PROTOCOL_VERSIONS[0], "cache-control": "no-store", ...headers } }); }

export async function GET(request: Request) {
  return handleMcp(request, runtimeEnv);
}

export async function POST(request: Request) {
  return handleMcp(request, runtimeEnv);
}
