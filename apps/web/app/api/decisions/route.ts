import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { errorResponse, organizationFor } from "@/lib/store";
import { listOpenDecisions, resolveDecision } from "@/lib/planning/decisions";

export const dynamic = "force-dynamic";

/** M19's decision queue for the web UI: the open decisions record_decision raised, for a
 * person to resolve. Resolving is browser-only at the domain layer; this route runs with
 * exactly that principal, since it only ever serves the signed-in web session. */
export async function GET(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const projectId = new URL(request.url).searchParams.get("projectId");
    if (!projectId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "A project is required" } }, { status: 422 });
    const organizationId = await organizationFor(env.DB, principal);
    const decisions = await listOpenDecisions(env.DB, organizationId, projectId);
    return Response.json({ data: decisions }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const body = await request.json() as { projectId?: string; decisionWorkItemId?: string; winningOptionId?: string; resolutionReason?: string };
    if (!body.projectId || !body.decisionWorkItemId || !body.winningOptionId) {
      return Response.json({ error: { code: "VALIDATION_FAILED", message: "projectId, decisionWorkItemId, and winningOptionId are required" } }, { status: 422 });
    }
    const resolved = await resolveDecision(env.DB, principal, { projectId: body.projectId, decisionWorkItemId: body.decisionWorkItemId, winningOptionId: body.winningOptionId, resolutionReason: body.resolutionReason });
    return Response.json({ data: resolved });
  } catch (error) {
    return errorResponse(error);
  }
}
