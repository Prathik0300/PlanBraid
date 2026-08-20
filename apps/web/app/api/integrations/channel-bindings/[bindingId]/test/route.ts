import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { sendTestMessage } from "@/lib/integrations/publish";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ bindingId: string }> }) {
  try {
    const { bindingId } = await context.params;
    await sendTestMessage(env.DB, await principalFromRequest(env, request), bindingId);
    return Response.json({ data: { bindingId, sent: true } });
  } catch (error) { return errorResponse(error); }
}
