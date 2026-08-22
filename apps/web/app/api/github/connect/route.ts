import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { githubInstallUrl } from "@/lib/github";
import { errorResponse } from "@/lib/store";
import { guestIntegrationsDisabledError } from "@/lib/guest";

export const dynamic = "force-dynamic";

/** Requires a signed-in principal before sending anyone to GitHub, so the callback
 * always has an account to attach the resulting token to. A guest sandbox is refused
 * for the same reason lib/integrations/core.ts's beginProviderOAuth refuses it: a real
 * GitHub App install must not outlive an unclaimed anonymous session. */
export async function GET(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    if (principal.isGuest) throw guestIntegrationsDisabledError();
    return Response.redirect(githubInstallUrl(), 302);
  } catch (error) {
    return errorResponse(error);
  }
}
