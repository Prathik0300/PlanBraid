import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { errorResponse, organizationFor } from "@/lib/store";
import { explainWorkItem } from "@/lib/planning/explain";

export const dynamic = "force-dynamic";

/** Why-not-done reasoning (M12) for the web UI — the same causal answer
 * `explain_work_item` gives a connected agent, for the person looking at a stalled card. */
export async function GET(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const workItemId = new URL(request.url).searchParams.get("workItemId");
    if (!workItemId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "A work item is required" } }, { status: 422 });
    const organizationId = await organizationFor(env.DB, principal);
    const explanation = await explainWorkItem(env.DB, organizationId, workItemId);
    return Response.json({ data: explanation }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
