import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { errorResponse } from "@/lib/store";
import { applySimplificationFinding, createSimplificationRun, dismissSimplificationFinding, readSimplificationRun } from "@/lib/simplify/runs";

export const dynamic = "force-dynamic";

/** The latest run for a project, so reopening the panel shows what was already found. */
export async function GET(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const projectId = new URL(request.url).searchParams.get("projectId");
    if (!projectId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "A project is required" } }, { status: 422 });
    const run = await readSimplificationRun(env.DB, principal, { projectId });
    return Response.json({ data: run }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Starts a pass, or acts on one of its findings. Applying runs the command the finding
 * proposed; nothing is changed until that happens. */
export async function POST(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const body = await request.json().catch(() => ({})) as { projectId?: string; findingId?: string; action?: "apply" | "dismiss" };
    if (body.findingId) {
      const result = body.action === "dismiss"
        ? await dismissSimplificationFinding(env.DB, principal, { findingId: body.findingId })
        : await applySimplificationFinding(env.DB, principal, { findingId: body.findingId });
      return Response.json({ data: result }, { headers: { "cache-control": "no-store" } });
    }
    if (!body.projectId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "A project is required" } }, { status: 422 });
    const run = await createSimplificationRun(env.DB, principal, { projectId: body.projectId });
    return Response.json({ data: run }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
