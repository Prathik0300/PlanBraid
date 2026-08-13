import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { errorResponse } from "@/lib/store";
import { getPlanningHealth } from "@/lib/planning/health";

export const dynamic = "force-dynamic";

/** M22's planning debt/health for the web UI: the same weighted rollup
 * get_planning_health gives a connected agent, for a person who wants to see it. */
export async function GET(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const projectId = new URL(request.url).searchParams.get("projectId");
    if (!projectId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "A project is required" } }, { status: 422 });
    const health = await getPlanningHealth(env.DB, principal, projectId);
    return Response.json({ data: health }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
