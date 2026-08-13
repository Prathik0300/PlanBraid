import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { errorResponse } from "@/lib/store";
import { getHandoffPackage } from "@/lib/planning/handoff";

export const dynamic = "force-dynamic";

/** The web UI's route to M13's handoff package — the same content
 * `get_handoff_package` gives a connected agent, for a person who wants to copy it
 * somewhere (a disconnected agent, a chat, a status update). */
export async function GET(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const projectId = new URL(request.url).searchParams.get("projectId");
    if (!projectId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "A project is required" } }, { status: 422 });
    const handoff = await getHandoffPackage(env.DB, principal, projectId);
    return Response.json({ data: handoff }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
