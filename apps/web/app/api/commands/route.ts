import { env } from "@/lib/runtime-env";
import type { Command } from "@/lib/contracts";
import { principalFromRequest } from "@/lib/app-principal";
import { errorResponse, executeCommand } from "@/lib/store";
import { dispatchNotification } from "@/lib/push";

export const dynamic = "force-dynamic";
// Default function duration (10s) isn't enough room for executeCommand's waitUntil-based
// Slack drain kick, which deliberately waits past a 20s debounce window before draining.
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const command = await request.json() as Command;
    if (!command || typeof command !== "object" || typeof command.action !== "string" || typeof command.idempotencyKey !== "string") {
      return Response.json({ error: { code: "VALIDATION_FAILED", message: "A valid command and idempotency key are required" } }, { status: 422 });
    }
    const result = await executeCommand(env.DB, await principalFromRequest(env, request), command);
    if ("notificationId" in result && typeof result.notificationId === "string") await dispatchNotification(env.DB, result.notificationId, env);
    return Response.json({ data: result, meta: { requestId: crypto.randomUUID() } });
  } catch (error) {
    return errorResponse(error);
  }
}
