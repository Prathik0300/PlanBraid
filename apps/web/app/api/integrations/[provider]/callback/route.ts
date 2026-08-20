import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { consumeOAuthState, integrationProvider, saveConnection } from "@/lib/integrations/core";
import { exchangeBasecampCode } from "@/lib/integrations/basecamp";
import { exchangeJiraCode } from "@/lib/integrations/jira";
import { exchangeSlackCode } from "@/lib/integrations/slack";
import { errorResponse } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    const { provider: rawProvider } = await context.params;
    const provider = integrationProvider(rawProvider);
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const providerError = url.searchParams.get("error") || url.searchParams.get("error_description");
    const principal = await principalFromRequest(env, request);
    if (providerError) {
      // Providers return state on denied consent too. Consume it so the one-time token
      // cannot be replayed and return the person to the project that opened OAuth.
      const consumed = state ? await consumeOAuthState(env.DB, principal, provider, state) : null;
      return redirectBack(url.origin, provider, consumed?.projectId ?? null, providerError);
    }
    if (!state || !code) return Response.json({ error: { code: "OAUTH_CALLBACK_INVALID", message: "OAuth callback is missing code or state" } }, { status: 400 });
    const consumed = await consumeOAuthState(env.DB, principal, provider, state);
    const token = provider === "basecamp" ? await exchangeBasecampCode(code, consumed.redirectUri)
      : provider === "slack" ? await exchangeSlackCode(code, consumed.redirectUri)
      : await exchangeJiraCode(code, consumed.redirectUri);
    await saveConnection(env.DB, {
      organizationId: consumed.organizationId, ownerUserId: principal.userId, provider, label: token.label,
      accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt, scopes: token.scopes,
      metadata: "metadata" in token ? token.metadata as Record<string, unknown> : undefined,
    });
    return redirectBack(url.origin, provider, consumed.projectId, null);
  } catch (error) { return errorResponse(error); }
}

function redirectBack(origin: string, provider: string, projectId: string | null, error: string | null) {
  const target = new URL("/", origin);
  target.searchParams.set("integration", provider);
  if (projectId) target.searchParams.set("integrationProject", projectId);
  if (error) target.searchParams.set("integrationError", error.slice(0, 200));
  return Response.redirect(target, 302);
}
