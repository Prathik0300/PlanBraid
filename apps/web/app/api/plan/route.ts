import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { errorResponse } from "@/lib/store";
import { getExecutionPlan } from "@/lib/planning/plan";

export const dynamic = "force-dynamic";

/** A fresh wave-by-wave execution order for the web UI, computed on demand the same way
 * get_planning_health is: nothing here is persisted, so it always reflects current state. */
export async function GET(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const projectId = new URL(request.url).searchParams.get("projectId");
    if (!projectId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "A project is required" } }, { status: 422 });
    const plan = await getExecutionPlan(env.DB, principal, projectId);
    return Response.json({ data: plan }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
