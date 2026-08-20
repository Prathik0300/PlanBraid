import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { integrationProvider } from "@/lib/integrations/core";
import { providerProjects, providerResources } from "@/lib/integrations/service";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const provider = integrationProvider(url.searchParams.get("provider") ?? "");
    const connectionId = url.searchParams.get("connectionId");
    const accountId = url.searchParams.get("accountId");
    if (!connectionId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "connectionId is required" } }, { status: 422 });
    const principal = await principalFromRequest(env, request);
    const data = accountId
      ? { projects: await providerProjects(env.DB, principal, provider, connectionId, accountId) }
      : { resources: await providerResources(env.DB, principal, provider, connectionId) };
    return Response.json({ data }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

