import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { exchangeGithubCode } from "@/lib/github";

export const dynamic = "force-dynamic";

/** Always redirects back into the app rather than rendering an error page: the outcome
 * is reported in the UI, where the user can retry, instead of stranding them on a
 * dead-end URL the way a bare error response would. */
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const code = new URL(request.url).searchParams.get("code");
  try {
    if (!code) return Response.redirect(`${origin}/?github=cancelled`, 302);
    const principal = await principalFromRequest(env, request);
    await exchangeGithubCode(env.DB, principal, code);
    return Response.redirect(`${origin}/?github=connected`, 302);
  } catch {
    return Response.redirect(`${origin}/?github=failed`, 302);
  }
}
