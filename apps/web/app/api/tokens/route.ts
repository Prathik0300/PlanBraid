import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { createMcpToken, errorResponse, listMcpTokens, revokeMcpToken } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const tokens = await listMcpTokens(env.DB, await principalFromRequest(env, request));
    return Response.json({ data: tokens }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { name?: string };
    const token = await createMcpToken(env.DB, await principalFromRequest(env, request), body.name ?? "Coding agents");
    return Response.json({ data: token }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { id?: string };
    if (!body.id) return Response.json({ error: { code: "VALIDATION_FAILED", message: "Connection ID is required" } }, { status: 422 });
    const result = await revokeMcpToken(env.DB, await principalFromRequest(env, request), body.id);
    return Response.json({ data: result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
