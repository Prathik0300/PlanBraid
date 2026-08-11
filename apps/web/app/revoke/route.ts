import { handleOAuthRoute } from "@/lib/oauth";
import { env } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";

async function handle(request: Request) {
  return (await handleOAuthRoute(request, env)) ?? new Response("Not found", { status: 404 });
}

export const POST = handle;
export const OPTIONS = handle;
