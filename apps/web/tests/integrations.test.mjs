import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { normalizeBasecampTodo, normalizeBasecampTodoList } from "@/lib/integrations/basecamp.ts";
import { saveConnection } from "@/lib/integrations/core.ts";
import { nextLink, providerFetch, ProviderHttpError } from "@/lib/integrations/http.ts";
import { createBinding, disconnectBinding } from "@/lib/integrations/service.ts";
import { normalizeJiraIssue, verifyJiraWebhookBearer } from "@/lib/integrations/jira.ts";
import { IMPORT_ONLY_PROVIDERS, PUBLICATION_PROVIDERS } from "@/lib/integrations/types.ts";
import { stableJson, textFromAdf, textFromHtml } from "@/lib/integrations/utils.ts";
import { loadDashboard, organizationFor } from "@/lib/store.ts";
import { createTestDb } from "./support/local-pg.mjs";
import { principal } from "./support/fixtures.mjs";

test("Basecamp and Jira are import-only while Slack is the only publication provider", () => {
  assert.deepEqual(IMPORT_ONLY_PROVIDERS, ["basecamp", "jira"]);
  assert.deepEqual(PUBLICATION_PROVIDERS, ["slack"]);
  assert.equal(IMPORT_ONLY_PROVIDERS.some((provider) => PUBLICATION_PROVIDERS.includes(provider)), false);
});

test("Basecamp normalization preserves hierarchy and planning fields", () => {
  const list = normalizeBasecampTodoList({ id: 20, title: "Checkout", description: "<p>Ship &amp; verify</p>", status: "active", app_url: "https://3.basecamp.com/1/buckets/2/todolists/20" });
  const todo = normalizeBasecampTodo({ id: 21, content: "Add tax", description: "<p>Use regional rates</p>", completed: false, status: "active", due_on: "2026-09-01", assignees: [{ name: "Rae" }], app_url: "https://3.basecamp.com/1/buckets/2/todos/21" }, "20");
  assert.equal(list.itemType, "feature"); assert.equal(list.description, "Ship & verify");
  assert.equal(todo.parentExternalId, "20"); assert.equal(todo.assignee, "Rae");
  assert.equal(todo.dueAt, "2026-09-01T00:00:00.000Z"); assert.equal(todo.normalizedStatus, "planned");
});

test("Basecamp completed and trashed todos map to distinct terminal states", () => {
  assert.equal(normalizeBasecampTodo({ id: 1, content: "Done", completed: true }, null).normalizedStatus, "done");
  assert.equal(normalizeBasecampTodo({ id: 2, content: "Gone", status: "trashed" }, null).normalizedStatus, "cancelled");
});

test("a Basecamp binding without a destination creates and groups a same-named Planbraid project", async () => {
  const previousSecret = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = "integration-test-secret-that-is-long-enough";
  try {
    const db = await createTestDb();
    const organizationId = await organizationFor(db, principal);
    const connectionId = await saveConnection(db, {
      organizationId, ownerUserId: principal.userId, provider: "basecamp", label: "Basecamp · RadioFX",
      accessToken: "basecamp-token", refreshToken: "basecamp-refresh", expiresAt: null, scopes: [],
    });
    const fetcher = async (input) => {
      const url = String(input);
      if (url === "https://launchpad.37signals.com/authorization.json") return Response.json({ accounts: [{ product: "bc3", id: 4933376, name: "RadioFX", href: "https://3.basecampapi.com/4933376" }] });
      if (url === "https://3.basecampapi.com/4933376/projects.json") return Response.json([{ id: 812, name: "US Dev Team", description: "<p>Build the product</p>", app_url: "https://3.basecamp.com/4933376/buckets/812" }]);
      throw new Error(`Unexpected Basecamp URL: ${url}`);
    };

    const result = await createBinding(db, principal, {
      projectId: null, provider: "basecamp", connectionId, externalAccountId: "4933376", externalProjectId: "812",
      origin: "http://localhost:3000", projectIdempotencyKey: "basecamp-auto-project",
    }, fetcher);

    const dashboard = await loadDashboard(db, principal);
    const project = dashboard.projects.find((entry) => entry.id === result.projectId);
    assert.equal(result.projectCreated, true);
    assert.equal(project.name, "US Dev Team");
    assert.equal(project.description, "Build the product");
    assert.deepEqual(project.integrationProviders, ["basecamp"]);
    assert.equal((await db.prepare("SELECT project_id FROM integration_bindings WHERE id = ?").bind(result.bindingId).first()).project_id, result.projectId);

    await db.prepare("UPDATE integration_bindings SET webhook_id = 'provider-webhook-1' WHERE id = ?").bind(result.bindingId).run();
    let providerCalls = 0;
    await disconnectBinding(db, principal, result.bindingId, async () => { providerCalls += 1; throw new Error("Disconnect must not call Basecamp"); });
    assert.equal(providerCalls, 0);
    assert.deepEqual(await db.prepare("SELECT status, webhook_id FROM integration_bindings WHERE id = ?").bind(result.bindingId).first(), { status: "disconnected", webhook_id: null });
  } finally {
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previousSecret;
  }
});

test("Jira ADF, status, priority, parent and issue links normalize", () => {
  const issue = normalizeJiraIssue({ id: "100", key: "APP-9", self: "https://example.atlassian.net/rest/api/3/issue/100", fields: {
    summary: "Implement checkout", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Fast " }, { type: "text", text: "and safe" }] }] },
    status: { name: "In Review", statusCategory: { name: "In Progress" } }, priority: { name: "Highest" }, assignee: { displayName: "Sam" },
    parent: { id: "90" }, issuetype: { name: "Story" }, project: { key: "APP" }, updated: "2026-08-20T12:00:00Z",
    issuelinks: [{ type: { outward: "blocks" }, outwardIssue: { id: "101" } }],
  }});
  assert.equal(issue.description, "Fast and safe"); assert.equal(issue.normalizedStatus, "in_review");
  assert.equal(issue.priority, "urgent"); assert.equal(issue.parentExternalId, "90");
  assert.deepEqual(issue.relations, [{ externalId: "101", type: "blocks", label: "blocks" }]);
  assert.equal(issue.canonicalUrl, "https://example.atlassian.net/browse/APP-9");
});

test("provider HTTP retries retryable failures", async () => {
  let calls = 0; const delays = [];
  const response = await providerFetch("https://provider.test/items", {
    provider: "test", maxRetries: 2, maxInlineDelayMs: 1_000, sleep: async (delay) => { delays.push(delay); },
    fetcher: async () => { calls += 1; return calls < 3 ? new Response("busy", { status: 503 }) : Response.json({ ok: true }); },
  });
  assert.equal(response.status, 200); assert.equal(calls, 3); assert.equal(delays.length, 2);
});

test("provider errors retain the upstream response status", async () => {
  await assert.rejects(providerFetch("https://provider.test/missing", { provider: "basecamp", fetcher: async () => new Response("not found", { status: 404 }) }),
    (error) => error instanceof ProviderHttpError && error.responseStatus === 404 && error.status === 502);
});

test("pagination, rich text cleanup and stable serialization are deterministic", () => {
  assert.equal(nextLink('<https://example.test/p1>; rel="prev", <https://example.test/p3>; rel="next"'), "https://example.test/p3");
  assert.equal(textFromHtml("<p>Hello&nbsp;world</p>"), "Hello world");
  assert.equal(textFromAdf({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }, { type: "paragraph", content: [{ type: "text", text: "Two" }] }] }), "One\nTwo");
  assert.equal(stableJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
});

test("Jira webhook verification accepts only a current HS256 bearer", () => {
  const previousId = process.env.JIRA_CLIENT_ID; const previousSecret = process.env.JIRA_CLIENT_SECRET;
  process.env.JIRA_CLIENT_ID = "test-client"; process.env.JIRA_CLIENT_SECRET = "test-secret";
  try {
    const token = jwt({ alg: "HS256", typ: "JWT" }, { exp: 2_000, nbf: 1_000 }, "test-secret");
    assert.equal(verifyJiraWebhookBearer(`Bearer ${token}`, 1_500), true);
    assert.equal(verifyJiraWebhookBearer(`Bearer ${token}.tampered`, 1_500), false);
    assert.equal(verifyJiraWebhookBearer(`Bearer ${token}`, 3_000), false);
  } finally {
    if (previousId === undefined) delete process.env.JIRA_CLIENT_ID; else process.env.JIRA_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.JIRA_CLIENT_SECRET; else process.env.JIRA_CLIENT_SECRET = previousSecret;
  }
});

function jwt(header, payload, secret) {
  const first = Buffer.from(JSON.stringify(header)).toString("base64url"); const second = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${first}.${second}.${createHmac("sha256", secret).update(`${first}.${second}`).digest("base64url")}`;
}
