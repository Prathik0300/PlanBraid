import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { organizationFor, errorResponse } from "@/lib/store";
import { listOAuthConnections, renameOAuthConnection, revokeOAuthConnection } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const organizationId = await organizationFor(env.DB, principal);
    const connections = await listOAuthConnections(env.DB, principal, organizationId);
    return Response.json({ data: connections }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const organizationId = await organizationFor(env.DB, principal);
    const body = await request.json().catch(() => ({})) as { id?: string; name?: string };
    if (!body.id) return Response.json({ error: { code: "VALIDATION_FAILED", message: "Connection ID is required" } }, { status: 422 });
    if (!body.name?.trim()) return Response.json({ error: { code: "VALIDATION_FAILED", message: "A connection name is required" } }, { status: 422 });
    const result = await renameOAuthConnection(env.DB, principal, organizationId, body.id, body.name);
    return Response.json({ data: result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const organizationId = await organizationFor(env.DB, principal);
    const body = await request.json().catch(() => ({})) as { id?: string };
    if (!body.id) return Response.json({ error: { code: "VALIDATION_FAILED", message: "Connection ID is required" } }, { status: 422 });
    const result = await revokeOAuthConnection(env.DB, principal, organizationId, body.id);
    return Response.json({ data: result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
