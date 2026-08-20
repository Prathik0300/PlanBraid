import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { integrationProvider } from "@/lib/integrations/core";
import { providerChannels } from "@/lib/integrations/publish";
import type { PublicationProvider } from "@/lib/integrations/types";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const provider = integrationProvider(url.searchParams.get("provider") ?? "") as PublicationProvider;
    const connectionId = url.searchParams.get("connectionId");
    if (!connectionId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "connectionId is required" } }, { status: 422 });
    const principal = await principalFromRequest(env, request);
    const channels = await providerChannels(env.DB, principal, provider, connectionId);
    return Response.json({ data: { channels } }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
