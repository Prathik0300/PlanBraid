import { env } from "@/lib/runtime-env";
import { handleMessageShortcut, handleViewSubmission, MESSAGE_SHORTCUT_CALLBACK_ID } from "@/lib/integrations/slack-import";
import { parseSlackWebhookPayload, verifySlackSignature } from "@/lib/integrations/slack";

export const dynamic = "force-dynamic";

/**
 * Slack's Interactivity Request URL: message shortcuts (the "Create Planbraid task"
 * entry someone clicks on a message) and this app's one modal's view_submission both
 * land here, form-encoded with a single `payload` JSON field. Must ack within 3 seconds;
 * a shortcut's ack *is* the views.open call itself, done inline before returning - Slack
 * doesn't read the HTTP response body for that type, only for view_submission's
 * close/errors instruction.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > 200_000) return Response.json({ error: { code: "PAYLOAD_TOO_LARGE" } }, { status: 413 });
  const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim();
  if (!signingSecret) return Response.json({ error: { code: "NOT_CONFIGURED" } }, { status: 503 });
  const verified = await verifySlackSignature(signingSecret, request.headers.get("x-slack-request-timestamp"), request.headers.get("x-slack-signature"), rawBody);
  if (!verified) return Response.json({ error: { code: "SIGNATURE_INVALID" } }, { status: 401 });

  const payload = parseSlackWebhookPayload(rawBody, request.headers.get("content-type"));
  const type = String(payload.type ?? "");
  try {
    if (type === "message_action" && payload.callback_id === MESSAGE_SHORTCUT_CALLBACK_ID) {
      await handleMessageShortcut(env.DB, payload);
      return new Response(null, { status: 200 });
    }
    if (type === "view_submission") {
      const result = await handleViewSubmission(env.DB, payload);
      return Response.json(result);
    }
  } catch {
    // Slack retries non-2xx interaction deliveries, which would replay whatever partial
    // side effect already happened. Swallow and ack instead - there is nothing durable
    // to retry into here, unlike the Events API's webhook_inbox path.
  }
  return new Response(null, { status: 200 });
}
