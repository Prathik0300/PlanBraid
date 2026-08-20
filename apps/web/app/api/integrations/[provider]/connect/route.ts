import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { beginProviderOAuth, integrationProvider } from "@/lib/integrations/core";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    const { provider: rawProvider } = await context.params;
    const provider = integrationProvider(rawProvider);
    const projectId = new URL(request.url).searchParams.get("projectId");
    const authorizationUrl = await beginProviderOAuth(env.DB, await principalFromRequest(env, request), provider, projectId, request);
    return Response.redirect(authorizationUrl, 302);
  } catch (error) { return errorResponse(error); }
}

