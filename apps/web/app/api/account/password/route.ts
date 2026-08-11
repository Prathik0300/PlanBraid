import { env } from "cloudflare:workers";
import { principalFromRequest } from "@/lib/app-principal";
import { authFor } from "@/lib/auth";
import { firstValidationMessage, passwordSchema } from "@/lib/auth-validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await principalFromRequest(env, request);
    const body = await request.json().catch(() => null) as { password?: string } | null;
    const result = passwordSchema.safeParse(body?.password);
    if (!result.success) {
      return Response.json({ error: { code: "INVALID_PASSWORD", message: firstValidationMessage(result.error) } }, { status: 422 });
    }
    await authFor(env).api.setPassword({ body: { newPassword: result.data }, headers: request.headers });
    return Response.json({ data: { passwordAdded: true } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const typed = error as { message?: string; statusCode?: number; body?: { code?: string; message?: string } };
    return Response.json({ error: { code: typed.body?.code ?? "PASSWORD_SETUP_FAILED", message: typed.body?.message ?? typed.message ?? "Password setup failed" } }, { status: typed.statusCode && typed.statusCode >= 400 ? typed.statusCode : 400 });
  }
}
