import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { githubInstallUrl } from "@/lib/github";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Requires a signed-in principal before sending anyone to GitHub, so the callback
 * always has an account to attach the resulting token to. */
export async function GET(request: Request) {
  try {
    await principalFromRequest(env, request);
    return Response.redirect(githubInstallUrl(), 302);
  } catch (error) {
    return errorResponse(error);
  }
}
