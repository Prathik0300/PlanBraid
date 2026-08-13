import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { errorResponse, requestImport } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { projectId?: string; sourceId?: string };
    if (!body.projectId || !body.sourceId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "projectId and sourceId are required" } }, { status: 422 });
    const result = await requestImport(env.DB, await principalFromRequest(env, request), { projectId: body.projectId, sourceId: body.sourceId });
    return Response.json({ data: result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
