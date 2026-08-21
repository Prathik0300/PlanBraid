import { env } from "@/lib/runtime-env";
import { handleSlashCommand } from "@/lib/integrations/slack-import";
import { parseSlackWebhookPayload, verifySlackSignature } from "@/lib/integrations/slack";

export const dynamic = "force-dynamic";

/** /planbraid's Request URL. Plain form-encoded (no `payload` wrapper, unlike
 * interactions) - parseSlackWebhookPayload's else-branch handles that shape. Opens the
 * same task modal as the message shortcut, via the trigger_id this delivery carries. */
export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > 200_000) return Response.json({ error: { code: "PAYLOAD_TOO_LARGE" } }, { status: 413 });
  const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim();
  if (!signingSecret) return Response.json({ error: { code: "NOT_CONFIGURED" } }, { status: 503 });
  const verified = await verifySlackSignature(signingSecret, request.headers.get("x-slack-request-timestamp"), request.headers.get("x-slack-signature"), rawBody);
  if (!verified) return Response.json({ error: { code: "SIGNATURE_INVALID" } }, { status: 401 });

  const payload = parseSlackWebhookPayload(rawBody, request.headers.get("content-type"));
  try { await handleSlashCommand(env.DB, payload); }
  catch { /* best effort - see interactions route's identical rationale */ }
  return new Response(null, { status: 200 });
}
