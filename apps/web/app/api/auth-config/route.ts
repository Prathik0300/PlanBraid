import { env } from "cloudflare:workers";
import { googleAuthEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ data: { googleEnabled: googleAuthEnabled(env) } }, { headers: { "cache-control": "no-store" } });
}
