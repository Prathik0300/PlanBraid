import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { disconnectGithub, githubStatus } from "@/lib/github";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const status = await githubStatus(env.DB, await principalFromRequest(env, request));
    return Response.json({ data: status }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const result = await disconnectGithub(env.DB, await principalFromRequest(env, request));
    return Response.json({ data: result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
