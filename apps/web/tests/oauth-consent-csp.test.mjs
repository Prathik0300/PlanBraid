/**
 * Regression coverage for bugs found live in production, all in the OAuth consent
 * page (lib/oauth.ts's consentPage) or the redirect_uri validation that gates it:
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
 * 3. VS Code-based clients (GitHub Copilot Chat, Cursor) and other native apps use a
 *    private-use URI scheme redirect per RFC 8252 (e.g. "vscode://publisher.ext/cb"),
 *    not https:// or loopack http://. Two separate things had to handle this or the
 *    same class of bug reappears for exactly this client category: validRedirectUri
 *    must not reject the scheme at registration time, and consentPage's CSP source
 *    must not silently drop it (a custom scheme's URL.origin is the literal string
 *    "null", not a usable CSP source — needs the CSP3 scheme-source form instead).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { consentPage, validRedirectUri } from "../lib/oauth.ts";

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

test("validRedirectUri accepts a VS Code-style private-use URI scheme redirect", () => {
  assert.equal(validRedirectUri("vscode://GitHub.copilot-chat/oauth/callback"), true);
});

test("validRedirectUri accepts a schemeless-authority private-use URI (RFC 8252 style)", () => {
  assert.equal(validRedirectUri("com.example.myapp:/callback"), true);
});

test("validRedirectUri still rejects scripting/data/file schemes", () => {
  assert.equal(validRedirectUri("javascript:alert(1)"), false);
  assert.equal(validRedirectUri("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(validRedirectUri("file:///etc/passwd"), false);
});

test("validRedirectUri still rejects non-loopback http:// (only https or loopback http is allowed)", () => {
  assert.equal(validRedirectUri("http://example.com/callback"), false);
});

test("consentPage's form-action uses a CSP3 scheme-source for a custom URI scheme redirect, not a broken 'null' origin", async () => {
  const response = consentPage("GitHub Copilot Chat", "vscode://GitHub.copilot-chat/oauth/callback", ["work:read"], "oar_6", principal);
  const policy = await csp(response);
  assert.doesNotMatch(policy, /\bnull\b/, "URL.origin is the literal string \"null\" for non-special schemes — using it verbatim would silently drop the source and reintroduce the original bug for this client category");
  assert.match(policy, /form-action 'self' vscode:(?:[\s;]|$)/);
});

test("consentPage's form-action handles a schemeless-authority custom URI the same way", async () => {
  const response = consentPage("Some Native App", "com.example.myapp:/callback", ["work:read"], "oar_7", principal);
  const policy = await csp(response);
  assert.match(policy, /form-action 'self' com\.example\.myapp:(?:[\s;]|$)/);
});
