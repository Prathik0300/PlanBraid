import { handleOAuthRoute } from "@/lib/oauth";
import { env } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return (await handleOAuthRoute(request, env)) ?? new Response("Not found", { status: 404 });
}
