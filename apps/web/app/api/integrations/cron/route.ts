import { env } from "@/lib/runtime-env";
import { processPendingWebhooks, reconcileDueBindings, refreshDueJiraWebhooks } from "@/lib/integrations/service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Vercel Cron automatically sends CRON_SECRET as a bearer token. Keep the earlier
  // integration-specific name as a self-hosting fallback.
  const configured = process.env.CRON_SECRET?.trim() || process.env.INTEGRATION_CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization");
  if (!configured || authorization !== `Bearer ${configured}`) return Response.json({ error: { code: "UNAUTHORIZED", message: "Cron authorization failed" } }, { status: 401 });
  const origin = new URL(request.url).origin;
  const [processedWebhooks, refreshedJiraWebhooks, reconciliation] = await Promise.all([processPendingWebhooks(env.DB), refreshDueJiraWebhooks(env.DB), reconcileDueBindings(env.DB, origin)]);
  return Response.json({ data: { processedWebhooks, refreshedJiraWebhooks, ...reconciliation } });
}
