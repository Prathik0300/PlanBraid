import { env } from "@/lib/runtime-env";
import { ensureSchema } from "@/db/setup";
import { drainSlackOutbox } from "@/lib/integrations/publish";

export const dynamic = "force-dynamic";

/**
 * Separate from /api/integrations/cron's once-daily reconciliation: consolidation and
 * timely retry after a Slack failure need minute-level draining, while Basecamp/Jira's
 * webhook-driven reconciliation does not. A dedicated route keeps the two schedules
 * independent in vercel.json rather than coupling Slack's cadence to theirs.
 */
export async function GET(request: Request) {
  const configured = process.env.CRON_SECRET?.trim() || process.env.INTEGRATION_CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization");
  if (!configured || authorization !== `Bearer ${configured}`) return Response.json({ error: { code: "UNAUTHORIZED", message: "Cron authorization failed" } }, { status: 401 });
  await ensureSchema(env.DB);
  const result = await drainSlackOutbox(env.DB);
  return Response.json({ data: result });
}
