import { env } from "@/lib/runtime-env";
import { authFor, hostedAuthConfigured } from "@/lib/auth";
import { ensureSchema } from "@/db/setup";
import { emailSignUpSchema, firstValidationMessage } from "@/lib/auth-validation";

export const dynamic = "force-dynamic";

async function handle(request: Request) {
  if (!hostedAuthConfigured(env, request)) {
    return Response.json({ error: { code: "AUTH_NOT_CONFIGURED", message: "Planbraid authentication is not configured" } }, { status: 503 });
  }
  if (request.method === "POST" && new URL(request.url).pathname.replace(/\/+$/, "") === "/api/auth/sign-up/email") {
    const body = await request.clone().json().catch(() => null);
    const result = emailSignUpSchema.safeParse(body);
    if (!result.success) {
      return Response.json({
        code: "INVALID_SIGN_UP",
        message: firstValidationMessage(result.error),
        fieldErrors: result.error.flatten().fieldErrors,
      }, { status: 422, headers: { "cache-control": "no-store" } });
    }
  }
  await ensureSchema(env.DB);
  return authFor(env).handler(request);
}

export const GET = handle;
export const POST = handle;
