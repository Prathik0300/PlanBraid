/**
 * Regression coverage for two bugs found live in production, both in the OAuth
 * consent page (lib/oauth.ts's consentPage):
 *
 * 1. form-action 'self' alone silently blocked every real "Allow access" click,
 *    because approving always redirects the browser to the connecting client's
 *    redirect_uri — a different origin — and Chrome's form-action enforcement checks
 *    the full navigation chain a form submission produces, not just the initial
 *    same-origin POST. Every hosted client (Claude, ChatGPT) and every local CLI
 *    client (Codex) hit this identically. See lib/oauth.ts's consentPage comment.
 * 2. Loopback CLI clients (Codex, local bridges) register a redirect_uri like
 *    "http://127.0.0.1:49227/callback" — technically accurate but reads like a bare
 *    IP:port to someone just clicking Allow, so consentPage describes it in plain
 *    language instead.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { consentPage } from "../lib/oauth.ts";

const principal = { userId: "usr_test", email: "person@example.com", displayName: "Test Person" };

async function csp(response) {
  return response.headers.get("content-security-policy") ?? "";
}

test("consentPage's form-action allows the client's own redirect_uri origin, not just 'self'", async () => {
  const response = consentPage("Claude", "https://claude.ai/api/mcp/auth_callback", ["work:read"], "oar_1", principal);
  assert.equal(response.status, 200);
  const policy = await csp(response);
  assert.match(policy, /form-action 'self' https:\/\/claude\.ai(?:[\s;]|$)/, "form-action must include the redirect target's origin, or the browser silently blocks every real approval");
});

test("consentPage's form-action correctly scopes to a loopback CLI client's ephemeral port", async () => {
  const response = consentPage("Codex", "http://127.0.0.1:49227/callback", ["work:read", "work:write"], "oar_2", principal);
  const policy = await csp(response);
  assert.match(policy, /form-action 'self' http:\/\/127\.0\.0\.1:49227(?:[\s;]|$)/);
});

test("a loopback redirect_uri is described in plain language, not shown as a raw IP:port", async () => {
  const response = consentPage("Codex", "http://127.0.0.1:49227/callback", ["work:read"], "oar_3", principal);
  const html = await response.text();
  assert.doesNotMatch(html, /127\.0\.0\.1:49227/, "a bare loopback address is not meaningful to someone deciding whether to click Allow");
  assert.match(html, /an app running on this device/i);
});

test("a hosted client's redirect host is still shown as-is (not over-generalized)", async () => {
  const response = consentPage("Claude", "https://claude.ai/api/mcp/auth_callback", ["work:read"], "oar_4", principal);
  const html = await response.text();
  assert.match(html, /claude\.ai/);
});

test("the consent form always posts to /authorize regardless of client", async () => {
  const response = consentPage("Some Client", "https://example.com/cb", ["work:read"], "oar_5", principal);
  const html = await response.text();
  assert.match(html, /<form method="post" action="\/authorize">/);
  assert.match(html, /name="request_id" value="oar_5"/);
});
