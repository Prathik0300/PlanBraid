import { env } from "@/lib/runtime-env";
import { googleAuthEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ data: { googleEnabled: googleAuthEnabled(env) } }, { headers: { "cache-control": "no-store" } });
}
