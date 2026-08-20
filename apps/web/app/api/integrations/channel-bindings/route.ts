import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { integrationProvider } from "@/lib/integrations/core";
import { createChannelBinding, disconnectChannelBinding, updateChannelBinding } from "@/lib/integrations/publish";
import type { ChannelBindingScope, PublicationProvider } from "@/lib/integrations/types";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const connectionId = clean(body.connectionId, 120);
    const channelId = clean(body.channelId, 120);
    const scopeType = clean(body.scopeType, 20) as ChannelBindingScope;
    if (!connectionId || !channelId || (scopeType !== "project" && scopeType !== "all_projects")) {
      return Response.json({ error: { code: "VALIDATION_FAILED", message: "connectionId, channelId, and a valid scopeType are required" } }, { status: 422 });
    }
    const data = await createChannelBinding(env.DB, await principalFromRequest(env, request), {
      provider: integrationProvider(String(body.provider ?? "")) as PublicationProvider, connectionId, scopeType,
      projectId: scopeType === "project" ? clean(body.projectId, 120) || null : null,
      channelId, channelName: clean(body.channelName, 200) || channelId,
      eventTypes: Array.isArray(body.eventTypes) ? body.eventTypes.filter((entry): entry is string => typeof entry === "string") : undefined,
      confirmedAllProjects: Boolean(body.confirmedAllProjects),
    });
    return Response.json({ data }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const bindingId = clean(body.bindingId, 120);
    if (!bindingId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "bindingId is required" } }, { status: 422 });
    await updateChannelBinding(env.DB, await principalFromRequest(env, request), bindingId, {
      eventTypes: Array.isArray(body.eventTypes) ? body.eventTypes.filter((entry): entry is string => typeof entry === "string") : undefined,
      excludedProjectIds: Array.isArray(body.excludedProjectIds) ? body.excludedProjectIds.filter((entry): entry is string => typeof entry === "string") : undefined,
    });
    return Response.json({ data: { bindingId, updated: true } });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const bindingId = new URL(request.url).searchParams.get("bindingId");
    if (!bindingId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "bindingId is required" } }, { status: 422 });
    await disconnectChannelBinding(env.DB, await principalFromRequest(env, request), bindingId);
    return Response.json({ data: { bindingId, disconnected: true } });
  } catch (error) { return errorResponse(error); }
}

function clean(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
