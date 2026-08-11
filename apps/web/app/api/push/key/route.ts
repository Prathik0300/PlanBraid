import { env } from "cloudflare:workers";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const publicKey = env.VAPID_PUBLIC_KEY?.trim();
    if (!publicKey) {
      return Response.json({ error: { code: "PUSH_NOT_CONFIGURED", message: "Web Push keys have not been configured for this deployment" } }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    return Response.json({ data: { publicKey } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
