import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { listGithubRepos } from "@/lib/github";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const repos = await listGithubRepos(env.DB, await principalFromRequest(env, request));
    return Response.json({ data: repos }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
