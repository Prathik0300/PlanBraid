import { waitUntil } from "@vercel/functions";
import { env } from "@/lib/runtime-env";
import { processWebhookInbox, receiveWebhook } from "@/lib/integrations/service";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ provider: string; bindingId: string; secret: string }> }) {
  try {
    const { provider, bindingId, secret } = await context.params;
    const payload = await request.text();
    if (payload.length > 1_000_000) return Response.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Webhook payload is too large" } }, { status: 413 });
    const received = await receiveWebhook(env.DB, provider, bindingId, secret, request.headers.get("authorization"), request.headers.get("x-request-id") ?? request.headers.get("x-atlassian-webhook-identifier"), payload);
    if (received.inboxId) waitUntil(processWebhookInbox(env.DB, received.inboxId).catch(() => undefined));
    return Response.json({ accepted: true, duplicate: received.duplicate }, { status: 202 });
  } catch (error) { return errorResponse(error); }
}

