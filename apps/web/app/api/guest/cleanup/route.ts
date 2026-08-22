import { env } from "@/lib/runtime-env";
import { deleteGuestOrganization, findExpiredGuestOrganizationIds } from "@/lib/guest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Reclaims guest sandboxes past their TTL (lib/guest.ts). Same bearer-secured cron
 * pattern as app/api/integrations/cron/route.ts, scheduled separately in vercel.json so
 * an unrelated integrations backlog can never delay guest cleanup or vice versa. */
export async function GET(request: Request) {
  const configured = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization");
  if (!configured || authorization !== `Bearer ${configured}`) return Response.json({ error: { code: "UNAUTHORIZED", message: "Cron authorization failed" } }, { status: 401 });

  const db = env.DB;
  let deleted = 0;
  // Paged rather than one unbounded pass, so a spike in expired guest orgs cannot blow
  // this function's own time budget — the next hourly run picks up whatever is left.
  for (let page = 0; page < 20; page += 1) {
    const ids = await findExpiredGuestOrganizationIds(db, 25);
    if (!ids.length) break;
    for (const id of ids) { if (await deleteGuestOrganization(db, id)) deleted += 1; }
    if (ids.length < 25) break;
  }
  return Response.json({ data: { deleted } });
}
