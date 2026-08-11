import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { errorResponse, organizationFor } from "@/lib/store";
import { validatePushEndpoint } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const organizationId = await organizationFor(env.DB, principal);
    const body = await request.json() as { subscription?: PushSubscriptionJSON; mode?: string };
    if (!body.subscription?.endpoint) return Response.json({ error: { code: "VALIDATION_FAILED", message: "A push subscription is required" } }, { status: 422 });
    validatePushEndpoint(body.subscription.endpoint);
    if (!body.subscription.keys?.p256dh || !body.subscription.keys?.auth) return Response.json({ error: { code: "VALIDATION_FAILED", message: "The push subscription keys are required" } }, { status: 422 });
    await env.DB.prepare("INSERT INTO push_subscriptions (id, organization_id, owner_user_id, endpoint, subscription, mode) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_user_id, endpoint) DO UPDATE SET subscription = excluded.subscription, mode = excluded.mode, active = 1, updated_at = CURRENT_TIMESTAMP").bind(`psh_${crypto.randomUUID().replaceAll("-", "")}`, organizationId, principal.userId, body.subscription.endpoint, JSON.stringify(body.subscription), body.mode ?? "all_interactions").run();
    return Response.json({ data: { subscribed: true, mode: body.mode ?? "all_interactions" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const body = await request.json() as { endpoint?: string };
    if (!body.endpoint) return Response.json({ error: { code: "VALIDATION_FAILED", message: "A subscription endpoint is required" } }, { status: 422 });
    await env.DB.prepare("UPDATE push_subscriptions SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND endpoint = ?").bind(principal.userId, body.endpoint).run();
    return Response.json({ data: { subscribed: false } });
  } catch (error) {
    return errorResponse(error);
  }
}
