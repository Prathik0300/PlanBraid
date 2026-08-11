import { env } from "cloudflare:workers";
import { principalFromRequest } from "@/lib/app-principal";
import { errorResponse, recordInteraction } from "@/lib/store";
import { dispatchNotification } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { projectId?: string; sourceId?: string; externalId?: string; outcome?: string; summary?: string; event?: "started" | "completed"; sequence?: number };
    if (!body.projectId || !body.sourceId || !body.externalId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "projectId, sourceId, and externalId are required" } }, { status: 422 });
    const result = await recordInteraction(env.DB, await principalFromRequest(env, request), body as Parameters<typeof recordInteraction>[2]);
    if (body.event !== "started" && "notificationId" in result && typeof result.notificationId === "string") await dispatchNotification(env.DB, result.notificationId, env);
    return Response.json({ data: result });
  } catch (error) {
    return errorResponse(error);
  }
}
