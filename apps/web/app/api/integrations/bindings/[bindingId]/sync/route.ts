import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { syncBinding } from "@/lib/integrations/service";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ bindingId: string }> }) {
  try {
    const { bindingId } = await context.params;
    const data = await syncBinding(env.DB, await principalFromRequest(env, request), bindingId);
    return Response.json({ data });
  } catch (error) { return errorResponse(error); }
}

