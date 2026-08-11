import { env } from "@/lib/runtime-env";
import { googleAuthEnabled } from "@/lib/auth";
import { principalFromRequest } from "@/lib/app-principal";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await principalFromRequest(env, request);
    return Response.json({ data: { googleEnabled: googleAuthEnabled(env) } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
