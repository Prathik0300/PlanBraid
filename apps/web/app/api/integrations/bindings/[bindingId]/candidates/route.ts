import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { applyCandidates, ignoreCandidate, listCandidates } from "@/lib/integrations/service";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ bindingId: string }> }) {
  try {
    const { bindingId } = await context.params;
    const data = await listCandidates(env.DB, await principalFromRequest(env, request), bindingId);
    return Response.json({ data }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ bindingId: string }> }) {
  try {
    const { bindingId } = await context.params;
    const body = await request.json() as { action?: string; externalItemIds?: string[]; externalItemId?: string };
    const principal = await principalFromRequest(env, request);
    if (body.action === "ignore" && body.externalItemId) {
      await ignoreCandidate(env.DB, principal, bindingId, body.externalItemId);
      return Response.json({ data: { ignored: body.externalItemId } });
    }
    if (body.action !== "apply") return Response.json({ error: { code: "VALIDATION_FAILED", message: "action must be apply or ignore" } }, { status: 422 });
    const data = await applyCandidates(env.DB, principal, bindingId, Array.isArray(body.externalItemIds) ? body.externalItemIds.map(String) : undefined);
    return Response.json({ data });
  } catch (error) { return errorResponse(error); }
}

