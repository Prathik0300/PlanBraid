import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { disconnectConnection, listConnections } from "@/lib/integrations/core";
import { listChannelBindings } from "@/lib/integrations/publish";
import { listBindings } from "@/lib/integrations/service";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const projectId = new URL(request.url).searchParams.get("projectId");
    const [connections, bindings, channelBindings] = await Promise.all([
      listConnections(env.DB, principal),
      projectId ? listBindings(env.DB, principal, projectId) : Promise.resolve([]),
      projectId ? listChannelBindings(env.DB, principal, projectId) : Promise.resolve([]),
    ]);
    return Response.json({ data: { connections, bindings, channelBindings } }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const connectionId = new URL(request.url).searchParams.get("connectionId");
    if (!connectionId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "connectionId is required" } }, { status: 422 });
    await disconnectConnection(env.DB, await principalFromRequest(env, request), connectionId);
    return Response.json({ data: { connectionId, disconnected: true } });
  } catch (error) { return errorResponse(error); }
}

