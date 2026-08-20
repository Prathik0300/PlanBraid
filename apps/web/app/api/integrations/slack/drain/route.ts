import { env } from "@/lib/runtime-env";
import { ensureSchema } from "@/db/setup";
import { drainSlackOutbox } from "@/lib/integrations/publish";

export const dynamic = "force-dynamic";

/**
 * The backstop, not the primary path: executeCommand's own waitUntil kick (see
 * lib/store.ts's kickSlackDrain) drains a fresh commit's rows within seconds of being
 * queued. This route exists for whatever that kick misses - a crashed instance, dead-
 * lettered rows past their retry backoff - and runs once daily in vercel.json, the most
 * frequent cadence a Hobby-tier deployment's cron allows. A dedicated route keeps this
 * schedule independent of /api/integrations/cron's own once-daily Basecamp/Jira
 * reconciliation rather than coupling Slack's cadence to theirs.
 */
export async function GET(request: Request) {
  const configured = process.env.CRON_SECRET?.trim() || process.env.INTEGRATION_CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization");
  if (!configured || authorization !== `Bearer ${configured}`) return Response.json({ error: { code: "UNAUTHORIZED", message: "Cron authorization failed" } }, { status: 401 });
  await ensureSchema(env.DB);
  const result = await drainSlackOutbox(env.DB);
  return Response.json({ data: result });
}
