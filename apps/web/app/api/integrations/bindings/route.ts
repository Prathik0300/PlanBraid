import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { integrationProvider } from "@/lib/integrations/core";
import { createBinding, disconnectBinding } from "@/lib/integrations/service";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const projectId = clean(body.projectId, 120);
    const connectionId = clean(body.connectionId, 120);
    const externalAccountId = clean(body.externalAccountId, 120);
    const externalProjectId = clean(body.externalProjectId, 120);
    const provider = integrationProvider(String(body.provider ?? ""));
    if (!connectionId || !externalAccountId || !externalProjectId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "connectionId, externalAccountId, and externalProjectId are required" } }, { status: 422 });
    if (!projectId && provider !== "basecamp") return Response.json({ error: { code: "VALIDATION_FAILED", message: "projectId is required for this provider" } }, { status: 422 });
    const data = await createBinding(env.DB, await principalFromRequest(env, request), {
      projectId: projectId || null, connectionId, provider, externalAccountId, externalProjectId,
      filterQuery: clean(body.filterQuery, 2000), origin: new URL(request.url).origin,
      projectIdempotencyKey: clean(body.idempotencyKey, 240) || undefined,
    });
    return Response.json({ data }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const bindingId = new URL(request.url).searchParams.get("bindingId");
    if (!bindingId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "bindingId is required" } }, { status: 422 });
    await disconnectBinding(env.DB, await principalFromRequest(env, request), bindingId);
    return Response.json({ data: { bindingId, disconnected: true } });
  } catch (error) { return errorResponse(error); }
}

function clean(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
