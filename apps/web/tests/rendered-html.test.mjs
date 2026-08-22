import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Real HTTP requests against a `next start` production server, rather than importing a
// bundled worker entry point directly (the old vinext/Cloudflare approach) — Next.js
// doesn't expose an equivalent single-function fetch handler to import, and this is
// closer to how the app is actually served anyway.
const PORT = 4100 + (process.pid % 400);
const BASE_URL = `http://localhost:${PORT}`;
let serverProcess;

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(BASE_URL);
      return;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("next start did not become ready in time");
}

before(async () => {
  serverProcess = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    cwd: APP_ROOT,
    // A placeholder is enough: none of the routes exercised below (the app shell and
    // OAuth discovery metadata) ever touch the database, and lib/runtime-env.ts's DB
    // getter only opens a connection on first access.
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "postgres://placeholder/placeholder", NODE_ENV: "production" },
    stdio: "pipe",
  });
  serverProcess.on("error", (error) => { throw error; });
  await waitForServer();
});

after(() => {
  serverProcess?.kill();
});

async function render(path = "/") {
  return fetch(`${BASE_URL}${path}`, { headers: { accept: "text/html" } });
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
    const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function themeColor(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, "i"));
  assert.ok(match, `Missing --${name} theme color`);
  return match[1];
}

test("server-renders the Planbraid application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Planbraid - One plan across every agent<\/title>/i);
  assert.match(html, /Unified, source-aware project work/i);
  assert.match(html, /<link rel="icon" href="\/planbraid-favicon\.png" type="image\/png" sizes="512x512"\/?>/i);
  assert.match(html, /<link rel="shortcut icon" href="\/planbraid-favicon\.png"\/?>/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("publishes a public, integration-ready privacy policy", async () => {
  const response = await render("/privacy");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Privacy Policy \| Planbraid<\/title>/i);
  assert.match(html, /Effective and last updated:[^<]*(?:<!-- -->)?August 21, 2026/i);
  assert.match(html, /Information we collect/i);
  assert.match(html, /Connected services, workplace data, and AI agents/i);
  assert.match(html, /We do not sell personal information/i);
  assert.match(html, /does not create, edit, transition, archive, or delete Jira issues/i);
  assert.match(html, /Your choices and privacy rights/i);
  assert.match(html, /Questions, concerns, and requests concerning this policy/i);
});

test("publishes MCP OAuth discovery metadata", async () => {
  const protectedResponse = await render("/.well-known/oauth-protected-resource");
  assert.equal(protectedResponse.status, 200);
  const protectedMetadata = await protectedResponse.json();
  assert.equal(protectedMetadata.resource, `${BASE_URL}/mcp`);
  assert.deepEqual(protectedMetadata.authorization_servers, [BASE_URL]);
  assert.deepEqual(protectedMetadata.scopes_supported, ["work:read", "work:write"]);

  const authorizationResponse = await render("/.well-known/oauth-authorization-server");
  assert.equal(authorizationResponse.status, 200);
  const authorizationMetadata = await authorizationResponse.json();
  assert.equal(authorizationMetadata.registration_endpoint, `${BASE_URL}/register`);
  assert.deepEqual(authorizationMetadata.code_challenge_methods_supported, ["S256"]);
  assert.ok(authorizationMetadata.grant_types_supported.includes("refresh_token"));
});

test("publishes the Web Push subscription key without exposing account data or caching errors", async () => {
  const [route, app] = await Promise.all([
    readFile(new URL("../app/api/push/key/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/planbraid-app.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /env\.VAPID_PUBLIC_KEY\?\.trim\(\)/);
  assert.doesNotMatch(route, /principalFromRequest/);
  assert.match(route, /"cache-control": "no-store"/);
  assert.match(app, /fetch\("\/api\/push\/key", \{ cache: "no-store" \}\)/);
});

test("ships the product UI, service worker, and manifest", async () => {
  const [app, css, manifest, serviceWorker] = await Promise.all([
    readFile(new URL("../app/planbraid-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
  assert.match(app, /Chats & agents/);
  assert.match(app, /EventSource/);
  assert.match(app, /Connect agent/);
  assert.match(app, /action: "remove_source"/);
  assert.match(app, /className="agent-delete"/);
  assert.match(app, /source\.status === "ended" && <button className="agent-reconnect"/);
  assert.match(app, /className="agent-manage-identity"/);
  assert.match(app, /createPortal\(<div ref=\{menuRef\} className="project-menu"/);
  assert.match(app, /Manage project team/);
  assert.match(app, /className="owner-picker"/);
  assert.match(app, /assigneeMemberIds: memberIds/);
  assert.match(app, /Imported members are refreshed from Basecamp or Jira/);
  assert.match(css, /\.agent-delete\s*\{[^}]*color:\s*#ff9ba2/);
  assert.match(css, /\.project-menu\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*2147483647/);
  assert.match(css, /\.owner-picker-menu\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*60/);
  assert.match(css, /:root\[data-theme="light"\] \.owner-picker-menu/);
  assert.match(css, /\.agent-manage-identity \.provider-icon\s*\{[^}]*background:\s*transparent/);
  assert.match(css, /grid-template-columns:\s*var\(--rail\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.equal(JSON.parse(manifest).short_name, "Planbraid");
  assert.equal(JSON.parse(manifest).icons[0].src, "/planbraid-mark.png");
  assert.match(serviceWorker, /notificationclick/);
  await access(new URL("../public/planbraid-mark.png", import.meta.url));
  await access(new URL("../public/planbraid-favicon.png", import.meta.url));
  await access(new URL("../public/favicon.ico", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});

test("keeps primary navigation clear and every visible button actionable", async () => {
  const [app, integrations, css, store, setup, oauth, mcp, mcpTools, mcpServer, contracts] = await Promise.all([
    readFile(new URL("../app/planbraid-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/integrations-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/store.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/setup.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/oauth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/mcp/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/mcp/tools.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/mcp/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/contracts.ts", import.meta.url), "utf8"),
  ]);
  const sidebar = app.slice(app.indexOf("function ProjectRail"), app.indexOf("function Header"));
  assert.match(sidebar, /Projects/);
  assert.match(sidebar, /providerSections/);
  assert.match(sidebar, /project-provider-toggle/);
  assert.match(sidebar, /aria-expanded=\{expandedProviders\[provider\]\}/);
  assert.match(sidebar, /<ProviderMark provider=\{provider\}/);
  assert.match(sidebar, /Chats & agents/);
  assert.match(sidebar, /All activity/);
  assert.match(integrations, /Fetch latest/);
  assert.match(integrations, /Review before importing/);
  assert.match(integrations, /Import selected/);
  assert.match(integrations, /nothing here writes work back to/);
  assert.match(integrations, /reviewRef\.current\?\.scrollIntoView\(\{ behavior: "smooth", block: "start" \}\)/);
  assert.match(integrations, /<section ref=\{reviewRef\} className="integration-review">/);
  assert.match(css, /:root\[data-theme="light"\] \.integration-primary\s*\{[^}]*color:\s*#fff !important;[^}]*background:\s*#174f91 !important/);
  assert.doesNotMatch(sidebar, /codingSpaces|safePath|worktree|local main|branch/);
  assert.doesNotMatch(app, /function SourceRail|event-menu|Workspace settings|saved-views/);
  assert.match(app, /aria-pressed=\{view === entry\}/);
  assert.match(app, /aria-expanded=\{open\}/);
  assert.match(app, /setSidebarOpen\(\(open\) => !open\)/);
  assert.match(app, /window\.matchMedia\("\(max-width: 900px\)"\)\.matches/);
  assert.match(app, /settleSidebarAfterSelection\(\)/);
  assert.match(app, /open \? "open" : "collapsed"/);
  // The logo is always visible in the rail, collapsed or open; only the wordmark and the
  // rest of the rail's content hide behind `open`, per the collapsed-rail redesign.
  assert.match(sidebar, /<span className="planbraid-logo" aria-hidden="true" \/>/);
  assert.match(sidebar, /\{open && <strong>Planbraid<\/strong>\}/);
  assert.match(app, /open=\{sidebarOpen\}/);
  const header = app.slice(app.indexOf("function Header"), app.indexOf("function ProfileDialog"));
  // The header used to duplicate the rail's logo/wordmark when the sidebar was collapsed;
  // that duplication is gone, so the header carries no brand mark of its own at all.
  assert.doesNotMatch(header, /workspace-brand/);
  assert.doesNotMatch(header, /className="planbraid-logo"/);
  assert.doesNotMatch(header, /project-glyph large|\?\? "P"/);
  // Collapsed: an arrow below the logo (points right, to expand). Open: an arrow beside
  // the wordmark (points left, to collapse) — replacing the old hamburger glyph.
  assert.match(app, /className="icon-button sidebar-toggle collapsed-toggle"/);
  assert.match(app, /<ArrowIcon direction="right" \/>/);
  assert.match(app, /<ArrowIcon direction="left" \/>/);
  assert.doesNotMatch(app, /hamburger-icon/);
  assert.match(css, /\.app-shell\s*\{[^}]*grid-template-columns:\s*var\(--rail-closed\)\s+minmax\(0,\s*1fr\)/);
  assert.match(css, /\.app-shell\.sidebar-open/);
  assert.match(css, /\.project-rail\.collapsed \.rail-brand/);
  assert.match(app, /planbraid-theme/);
  assert.match(app, /Switch to \$\{theme === "dark" \? "light" : "dark"\} theme/);
  assert.match(app, /role="switch" aria-checked=\{theme === "light"\}/);
  assert.match(app, /theme-switch-thumb/);
  assert.doesNotMatch(app, />Light<|>Dark</);
  assert.match(css, /\.theme-switch\.light \.theme-switch-thumb\s*\{[^}]*translateX\(27px\)/);
  assert.match(css, /\.theme-switch-thumb\s*\{[^}]*background:#eef2f7[^}]*color:#151a22/);
  assert.match(css, /:root\[data-theme="light"\] \.theme-switch-thumb\s*\{[^}]*background:#242b35[^}]*color:#f7f9fc/);
  assert.match(css, /\.theme-switch-icon\s*\{[^}]*opacity:0/);
  assert.match(css, /\.theme-switch\.dark \.moon,\.theme-switch\.light \.sun\s*\{[^}]*opacity:1/);
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /:root\[data-theme="light"\] \.status-badge\.in_progress/);
  assert.match(css, /:root\[data-theme="light"\] \.status-badge\.blocked/);
  assert.match(css, /:root\[data-theme="light"\] \.status-badge\.done/);
  // Count-badge pill styling (filter-bar and board-column counts) uses the theme
  // variables directly rather than a separate light-theme-only override, so both
  // themes get the same centered pill instead of dark mode rendering bare digits.
  assert.match(css, /\.filter-scroll span \{[^}]*background: var\(--panel-3\)/);
  assert.match(css, /\.board-column > header b \{[^}]*background: var\(--panel-3\)/);
  assert.doesNotMatch(css, /:root\[data-theme="light"\] \.filter-scroll span/);
  assert.match(css, /:root\[data-theme="light"\] \.notification-priority/);
  assert.match(css, /:root\[data-theme="light"\] \.confidence span/);
  assert.match(css, /:root\[data-theme="light"\] \.setup-button/);
  assert.match(css, /:root\[data-theme="light"\] \.composer button/);
  assert.match(css, /:root\[data-theme="light"\] \.drawer-note input/);
  assert.match(css, /:root\[data-theme="light"\] \.task-card select/);
  assert.match(css, /:root\[data-theme="light"\] \.command-results button/);
  assert.match(css, /:root\[data-theme="light"\] \.oauth-setup-card/);
  assert.match(css, /\.method-icon\s*\{[^}]*background:var\(--panel-3\)/);
  assert.doesNotMatch(css, /font-size:\s*(?:8|9|10)px|font:\s*(?:8|9|10)px/);
  assert.match(css, /\.auth-privacy\s*\{[^}]*font-size:13px[^}]*line-height:1\.5/);
  assert.doesNotMatch(css, /:root\[data-theme="light"\] \.profile-form input,\s*\.auth-form input/);
  assert.doesNotMatch(css, /:root\[data-theme="light"\] \.login-method,\s*\.profile-identity/);
  assert.match(app, /<GoogleIcon \/>/);
  assert.match(css, /\.google-outline-icon\s*\{[^}]*background:var\(--text\)[^}]*mask:var\(--google-icon\)/);
  assert.doesNotMatch(css, /\.google-g/);
  assert.match(app, /Welcome back, \$\{data!\.viewer\.name\}/);
  assert.match(app, /Create a project for organized tracking/);
  assert.match(app, /secondaryAction="Connect agent"/);
  assert.match(app, /No project required/);
  assert.doesNotMatch(app, /\{project && <button className="setup-button"/);
  assert.doesNotMatch(css, /\.header-actions \.search, \.setup-button \{ display: none/);
  assert.match(app, /Automatic OAuth access/);
  assert.doesNotMatch(app, /OAuth 2\.1 · PKCE/);
  assert.doesNotMatch(app, /Manual · revocable/i);
  assert.match(app, /Standard MCP config/);
  assert.match(app, /Common MCP JSON configuration/);
  assert.match(app, /Active token connections/);
  assert.match(app, /Network access required/);
  assert.match(app, /local model runners, custom tools, or personal models/);
  assert.doesNotMatch(app, /supported-agents|Supported coding agents/);
  assert.match(app, /codex-color\.svg/);
  assert.match(app, /claude-color\.svg/);
  assert.match(app, /gemini-color\.svg/);
  assert.match(app, /copilot-color\.svg/);
  assert.match(app, /providerLogo\[key\]/);
  assert.match(app, /typeof bundledLogo === "string" \? bundledLogo : bundledLogo\?\.src/);
  assert.doesNotMatch(app, /provider === "claude" \? "A"|provider === "codex" \? "C"/);
  assert.match(css, /\.provider-icon img/);
  assert.match(css, /\.profile-dialog > header\s*\{[^}]*position:\s*sticky[^}]*top:\s*0[^}]*z-index:\s*4/);
  assert.match(css, /\.setup-dialog > header\s*\{[^}]*position:\s*sticky[^}]*top:\s*0[^}]*z-index:\s*4[^}]*background:\s*var\(--panel\)/);
  assert.match(css, /\.command-dialog > header\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/);
  assert.match(css, /\.connection-list h3 span\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*line-height:\s*1/);
  assert.match(store, /removeLegacyDemoData/);
  assert.match(store, /removeGeneratedProjectShorthands/);
  assert.match(store, /listMcpTokens/);
  assert.match(store, /revokeMcpToken/);
  assert.match(store, /const itemKey = `#\$\{sequence\}`/);
  assert.doesNotMatch(store, /const baseKey|Math\.random\(\).*project|`\$\{baseKey\}/);
  assert.doesNotMatch(mcpTools, /project\.key/);
  assert.match(mcpTools, /any MCP client, agent, or personal-model session/);
  // The empty-state UI tells people to "create the project from your MCP client", so the
  // MCP surface has to actually expose project creation — it silently didn't at first,
  // leaving a connected agent able to see the account but unable to make a project.
  assert.match(mcpTools, /name: "create_project"/);
  assert.match(mcpServer, /action: "create_project"/);
  assert.match(app, /create the project from your MCP client/);
  // Agents bind their own absolute path, since a browser can never report one.
  assert.match(mcpTools, /name: "update_project"/);
  // The create-project dialog silently did nothing when the name was empty, because the
  // name lived in the unlabeled header search box and submit was `name.trim() && ...`.
  // Keep it a real form with a labeled field and a visible error.
  const projectForm = app.slice(app.indexOf("function CommandDialog"), app.indexOf("function SetupDialog"));
  assert.match(projectForm, /<form className="project-form" onSubmit=/);
  assert.match(projectForm, /<label>Project name/);
  assert.match(projectForm, /className="field-error"/);
  assert.doesNotMatch(projectForm, /Directory or repository/);
  assert.match(mcpTools, /Free-form client, agent, or provider name/);
  assert.match(contracts, /export type Provider = string/);
  assert.match(setup, /CREATE TABLE IF NOT EXISTS data_migrations/);
  assert.match(setup, /CREATE TABLE IF NOT EXISTS oauth_clients/);
  assert.match(setup, /CREATE TABLE IF NOT EXISTS oauth_token_families/);
  assert.match(oauth, /code_challenge_methods_supported:\s*\["S256"\]/);
  assert.match(oauth, /refresh_token/);
  assert.match(oauth, /Refresh token reuse was detected/);
  assert.match(oauth, /validRedirectUri/);
  assert.match(mcp, /WWW-Authenticate/);
  assert.match(mcp, /principal\.scopes\?\.includes/);
  // Pinned since the initial commit, when 2026-07-28 was still an unreleased draft
  // revision — guarding against advertising it before the spec existed. Now the MCP
  // transport is @modelcontextprotocol/server v2, which legitimately serves that era
  // (createMcpHandler's default `legacy: 'stateless'` also serves 2025-era clients like
  // Codex from the same endpoint) — this assertion is satisfied because none of our own
  // source literally names that revision, not because Planbraid refuses to speak it.
  assert.doesNotMatch(mcp, /2026-07-28/);
  assert.doesNotMatch(mcpServer, /2026-07-28/);
  assert.doesNotMatch(mcpTools, /2026-07-28/);
  assert.doesNotMatch(store, /itemSeeds|MCP server implementation|Provider lifecycle plan|Web Push research|Concurrency review|Ember API/);
  for (const match of app.matchAll(/<button\b([^>]*)>/g)) {
    assert.match(match[1], /onClick=|type=|disabled=/, `Button without an action: ${match[0].slice(0, 120)}`);
  }
});

test("keeps sign-in hydration deterministic and the default URL clean", async () => {
  const [screen, gate, layout, auth, googleIcon] = await Promise.all([
    readFile(new URL("../app/auth-screen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/auth-gate.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/google-icon.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(screen, /useState<"dark" \| "light">\("dark"\)/);
  assert.doesNotMatch(screen, /typeof window/);
  assert.match(gate, /window\.location\.replace\("\/sign-in"\)/);
  assert.doesNotMatch(gate, /sign-in\?returnTo=\//);
  assert.match(screen, /window\.history\.replaceState\(null, "", "\/sign-in"\)/);
  assert.match(screen, /Choose any AI model and move between them without losing progress/);
  assert.doesNotMatch(screen, /Codex, Claude, Gemini, Copilot/);
  assert.match(screen, /theme-switch auth-theme-switch/);
  assert.match(screen, /role="switch" aria-checked=\{theme === "light"\}/);
  assert.doesNotMatch(screen, /☀ Light|☾ Dark/);
  assert.match(layout, /<body\s+suppressHydrationWarning/);
  assert.match(auth, /prompt:\s*"select_account"/);
  assert.match(screen, /<GoogleIcon \/> Continue with Google/);
  assert.match(googleIcon, /icons\/google\.svg/);
  assert.doesNotMatch(googleIcon, /google-color\.svg/);
});

test("validates email credentials in the form and on the server", async () => {
  const [validation, screen, authRoute, passwordRoute] = await Promise.all([
    readFile(new URL("../lib/auth-validation.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth-screen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/[...all]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/account/password/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(validation, /from "zod"/);
  assert.match(validation, /\.min\(10,/);
  assert.match(validation, /\[a-z\]/);
  assert.match(validation, /\[A-Z\]/);
  assert.match(validation, /\[0-9\]/);
  assert.match(validation, /\[\^A-Za-z0-9\\s\]/);
  assert.match(validation, /\.email\("Enter a valid email address\."\)/);
  assert.match(screen, /emailSignUpSchema\.safeParse/);
  assert.match(screen, /emailSignInSchema\.safeParse/);
  assert.match(screen, /className="field-error"/);
  assert.match(screen, /special character/);
  assert.match(authRoute, /emailSignUpSchema\.safeParse/);
  assert.match(passwordRoute, /passwordSchema\.safeParse/);
});

test("maintains readable theme contrast and clear emphasis", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const dark = css.match(/:root\s*\{([^}]+)\}/)?.[1];
  const light = css.match(/:root\[data-theme="light"\]\s*\{([^}]+)\}/)?.[1];
  assert.ok(dark && light, "Both theme token sets must exist");
  for (const [theme, block] of [["dark", dark], ["light", light]]) {
    for (const foreground of ["text", "muted", "faint"]) {
      for (const background of ["bg", "panel", "panel-2", "panel-3"]) {
        const ratio = contrastRatio(themeColor(block, foreground), themeColor(block, background));
        assert.ok(ratio >= 7, `${theme} ${foreground} on ${background} contrast is ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.match(css, /\.status-badge[^}]*font-weight:\s*550/);
  assert.match(css, /\.profile-form label[^}]*font-weight:\s*500/);
  assert.match(css, /strong, b\s*\{\s*font-weight:\s*500/);
  assert.match(css, /h1, h2, h3, h4\s*\{\s*font-weight:\s*650/);
  assert.doesNotMatch(css, /font-size:\s*11px|font:\s*11px/);
  assert.match(css, /input::placeholder\s*\{[^}]*color:\s*var\(--faint\)/);
});

test("uses standard hyphens in user-facing website copy", async () => {
  const sources = await Promise.all([
    "../app/auth-screen.tsx",
    "../app/layout.tsx",
    "../app/page.tsx",
    "../app/planbraid-app.tsx",
    "../public/manifest.webmanifest",
    "../app/mcp/route.ts",
    "../lib/mcp/tools.ts",
    "../lib/mcp/server.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of sources) assert.doesNotMatch(source, /[–—]/);
});
