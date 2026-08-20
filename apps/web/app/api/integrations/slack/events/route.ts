import { env } from "@/lib/runtime-env";
import { revokeSlackConnectionsByTeam } from "@/lib/integrations/publish";
import { verifySlackSignature } from "@/lib/integrations/slack";

export const dynamic = "force-dynamic";

/**
 * Slack's Events API: one app-level Request URL, not one per binding (contrast with the
 * per-binding webhook path Basecamp/Jira use in app/api/integrations/webhooks). Must
 * respond within 3 seconds, so this only verifies, durably no-ops or acts on the two
 * events it actually subscribes to, and returns - there is nothing here worth queuing
 * through webhook_inbox, since app_uninstalled/tokens_revoked need no canonical refetch.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > 200_000) return Response.json({ error: { code: "PAYLOAD_TOO_LARGE" } }, { status: 413 });
  const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim();
  if (!signingSecret) return Response.json({ error: { code: "NOT_CONFIGURED" } }, { status: 503 });
  const verified = await verifySlackSignature(signingSecret, request.headers.get("x-slack-request-timestamp"), request.headers.get("x-slack-signature"), rawBody);
  if (!verified) return Response.json({ error: { code: "SIGNATURE_INVALID" } }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { return Response.json({ error: { code: "INVALID_PAYLOAD" } }, { status: 400 }); }

  if (body.type === "url_verification") return Response.json({ challenge: body.challenge });

  if (body.type === "event_callback") {
    const teamId = typeof body.team_id === "string" ? body.team_id : null;
    const inner = body.event && typeof body.event === "object" ? body.event as Record<string, unknown> : {};
    const eventType = typeof inner.type === "string" ? inner.type : "";
    if (teamId && (eventType === "app_uninstalled" || eventType === "tokens_revoked")) {
      await revokeSlackConnectionsByTeam(env.DB, teamId);
    }
  }
  return Response.json({ ok: true });
}
