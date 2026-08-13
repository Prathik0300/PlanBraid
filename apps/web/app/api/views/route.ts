import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { errorResponse } from "@/lib/store";
import { getSavedView, assertSavedViewName } from "@/lib/planning/views";

export const dynamic = "force-dynamic";

/** M23's saved structured views for the web UI: the same fixed queries get_saved_view
 * gives a connected agent, for a person browsing them directly. */
export async function GET(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId");
    const view = url.searchParams.get("view");
    if (!projectId || !view) return Response.json({ error: { code: "VALIDATION_FAILED", message: "A project and view are required" } }, { status: 422 });
    assertSavedViewName(view);
    const result = await getSavedView(env.DB, principal, projectId, view);
    return Response.json({ data: result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
