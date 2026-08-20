import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

// sealSecret/openSecret (lib/crypto-box.ts) need this set before any connection row is
// written or read; .env.local deliberately does not set it (see lib/auth.ts's own
// LOCAL_SECRET fallback for the dev server), so tests must supply one themselves.
process.env.BETTER_AUTH_SECRET ||= "test-only-secret-not-used-in-production-32ch";

import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject } from "./support/fixtures.mjs";
import { executeCommand } from "@/lib/store.ts";
import { providerConfig, providerConfigured, saveConnection } from "@/lib/integrations/core.ts";
import { parseSlackWebhookPayload, verifySlackSignature } from "@/lib/integrations/slack.ts";
import { buildPublicationStatements, createChannelBinding, drainSlackOutbox, renderConsolidatedBlocks } from "@/lib/integrations/publish.ts";

const browser = { ...principal, authentication: "browser" };

// --- signature verification ---------------------------------------------------------

test("Slack signature verification accepts only a matching, fresh HMAC", async () => {
  const secret = "test-signing-secret";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = '{"type":"event_callback"}';
  const expected = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  assert.equal(await verifySlackSignature(secret, timestamp, expected, body), true);
  assert.equal(await verifySlackSignature(secret, timestamp, expected + "0", body), false, "tampered signature is rejected");
  assert.equal(await verifySlackSignature(secret, timestamp, expected, body + "x"), false, "signature is bound to the exact body");
  assert.equal(await verifySlackSignature("wrong-secret", timestamp, expected, body), false);
});

test("Slack signature verification enforces the 5-minute replay window", async () => {
  const secret = "test-signing-secret";
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
  const body = "{}";
  const signature = "v0=" + createHmac("sha256", secret).update(`v0:${staleTimestamp}:${body}`).digest("hex");
  assert.equal(await verifySlackSignature(secret, staleTimestamp, signature, body), false);
});

test("a missing timestamp or signature header is rejected outright", async () => {
  assert.equal(await verifySlackSignature("s", null, "v0=abc", "{}"), false);
  assert.equal(await verifySlackSignature("s", "123", null, "{}"), false);
});

test("Slack webhook payloads parse both JSON and the form-encoded interactivity envelope", () => {
  assert.deepEqual(parseSlackWebhookPayload('{"type":"url_verification","challenge":"abc"}', "application/json"), { type: "url_verification", challenge: "abc" });
  const encoded = `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions" }))}`;
  assert.deepEqual(parseSlackWebhookPayload(encoded, "application/x-www-form-urlencoded"), { type: "block_actions" });
});

// --- provider config: the 3-way switch added alongside basecamp/jira ----------------

test("providerConfigured requires a signing secret for Slack specifically, not just client credentials", () => {
  const saved = { id: process.env.SLACK_CLIENT_ID, secret: process.env.SLACK_CLIENT_SECRET, signing: process.env.SLACK_SIGNING_SECRET };
  try {
    process.env.SLACK_CLIENT_ID = "id"; process.env.SLACK_CLIENT_SECRET = "secret"; delete process.env.SLACK_SIGNING_SECRET;
    assert.equal(providerConfigured("slack"), false, "missing signing secret means not configured, even with client credentials present");
    process.env.SLACK_SIGNING_SECRET = "signing";
    assert.equal(providerConfigured("slack"), true);
  } finally {
    for (const [key, value] of Object.entries({ SLACK_CLIENT_ID: saved.id, SLACK_CLIENT_SECRET: saved.secret, SLACK_SIGNING_SECRET: saved.signing })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("providerConfig reports a Slack-specific error when unconfigured, and basecamp/jira are unaffected", () => {
  const saved = { id: process.env.SLACK_CLIENT_ID, secret: process.env.SLACK_CLIENT_SECRET };
  try {
    delete process.env.SLACK_CLIENT_ID; delete process.env.SLACK_CLIENT_SECRET;
    assert.throws(() => providerConfig("slack"), (error) => error.code === "NOT_CONFIGURED" && /Slack/.test(error.message));
  } finally {
    if (saved.id === undefined) delete process.env.SLACK_CLIENT_ID; else process.env.SLACK_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.SLACK_CLIENT_SECRET; else process.env.SLACK_CLIENT_SECRET = saved.secret;
  }
});

// --- Block Kit rendering --------------------------------------------------------------

test("a single-project consolidation omits the per-line project label; a portfolio one includes it", () => {
  const single = renderConsolidatedBlocks([{ projectId: "p1", projectName: "Alpha", eventType: "work_item.blocked", itemKey: "#3", title: "Ship checkout" }]);
  const singleText = JSON.stringify(single);
  assert.match(singleText, /Alpha/); // header still names the project
  assert.doesNotMatch(single[1].text.text, /_\(Alpha\)_/, "single-project sends don't repeat the project name per line");

  const portfolio = renderConsolidatedBlocks([
    { projectId: "p1", projectName: "Alpha", eventType: "work_item.blocked", itemKey: "#3", title: "Ship checkout" },
    { projectId: "p2", projectName: "Beta", eventType: "work_item.completion_verified", itemKey: "#9", title: "Fix login" },
  ]);
  assert.match(portfolio[1].text.text, /_\(Alpha\)_/);
  assert.match(portfolio[2].text.text, /_\(Beta\)_/);
});

test("mrkdwn special characters in a title are escaped", () => {
  const blocks = renderConsolidatedBlocks([{ projectId: "p1", projectName: "Alpha", eventType: "work_item.blocked", itemKey: "#1", title: "A < B & C > D" }]);
  assert.match(blocks[1].text.text, /A &lt; B &amp; C &gt; D/);
});

// --- outbox: effect-key dedup and binding-overlap dedup ------------------------------

async function slackConnection(db, organizationId) {
  return saveConnection(db, { organizationId, ownerUserId: principal.userId, provider: "slack", label: "Slack · Test", accessToken: "xoxb-fake-token", refreshToken: null, expiresAt: null, scopes: ["chat:write"], metadata: { teamId: "T1", teamName: "Test Team", botUserId: "B1" } });
}

test("buildPublicationStatements is idempotent per (binding, event, item, summary)", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const project = await db.prepare("SELECT organization_id, name FROM projects WHERE id = ?").bind(projectId).first();
  const connectionId = await slackConnection(db, project.organization_id);
  const { bindingId } = await createChannelBinding(db, browser, { provider: "slack", connectionId, scopeType: "project", projectId, channelId: "C1", channelName: "eng" });

  const event = { organizationId: project.organization_id, projectId, projectName: project.name, eventType: "work_item.blocked", workItemId: "wi_1", itemKey: "#1", title: "Ship it", summary: "moved to blocked" };
  const first = await buildPublicationStatements(db, event);
  await db.batch(first);
  const second = await buildPublicationStatements(db, event);
  await db.batch(second); // ON CONFLICT DO NOTHING - must not throw or duplicate

  const rows = await db.prepare("SELECT * FROM integration_outbox WHERE binding_id = ?").bind(bindingId).all();
  assert.equal(rows.results.length, 1, "the same logical event enqueues exactly one outbox row, however many times it's built");
});

test("a channel bound both directly and via an all-projects feed receives exactly one queued message, preferring the specific binding", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const project = await db.prepare("SELECT organization_id, name FROM projects WHERE id = ?").bind(projectId).first();
  const connectionId = await slackConnection(db, project.organization_id);
  const direct = await createChannelBinding(db, browser, { provider: "slack", connectionId, scopeType: "project", projectId, channelId: "C-shared", channelName: "eng" });
  await createChannelBinding(db, browser, { provider: "slack", connectionId, scopeType: "all_projects", projectId: null, channelId: "C-shared", channelName: "eng", confirmedAllProjects: true });

  const statements = await buildPublicationStatements(db, { organizationId: project.organization_id, projectId, projectName: project.name, eventType: "work_item.blocked", workItemId: "wi_1", itemKey: "#1", title: "Ship it", summary: "moved to blocked" });
  assert.equal(statements.length, 1, "one physical channel receives one message even with two overlapping bindings");
  await db.batch(statements);
  const row = await db.prepare("SELECT binding_id FROM integration_outbox WHERE organization_id = ?").bind(project.organization_id).first();
  assert.equal(row.binding_id, direct.bindingId, "the project-scoped binding wins over the portfolio one for the same channel");
});

test("creating an all-projects binding without confirmation is rejected", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const project = await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(projectId).first();
  const connectionId = await slackConnection(db, project.organization_id);
  await assert.rejects(
    createChannelBinding(db, browser, { provider: "slack", connectionId, scopeType: "all_projects", projectId: null, channelId: "C1", channelName: "eng" }),
    (error) => error.code === "ALL_PROJECTS_CONFIRMATION_REQUIRED",
  );
});

// --- worker drain: consolidation, rate limiting, dead-lettering ----------------------

test("draining consolidates every due row for one binding into a single Slack call", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const project = await db.prepare("SELECT organization_id, name FROM projects WHERE id = ?").bind(projectId).first();
  const connectionId = await slackConnection(db, project.organization_id);
  const { bindingId } = await createChannelBinding(db, browser, { provider: "slack", connectionId, scopeType: "project", projectId, channelId: "C1", channelName: "eng" });
  for (const [key, title] of [["wi_1", "Ship checkout"], ["wi_2", "Fix login"]]) {
    const statements = await buildPublicationStatements(db, { organizationId: project.organization_id, projectId, projectName: project.name, eventType: "work_item.blocked", workItemId: key, itemKey: `#${key}`, title, summary: title });
    await db.batch(statements);
  }
  await db.prepare("UPDATE integration_outbox SET next_attempt_at = now() - interval '1 second' WHERE binding_id = ?").bind(bindingId).run();

  let calls = 0;
  const fetcher = async (url, options) => {
    if (String(url).includes("chat.postMessage")) {
      calls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.blocks.filter((block) => block.type === "section").length >= 2, true, "both events are in the one message");
      return Response.json({ ok: true, ts: "1700000000.000100", channel: "C1" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await drainSlackOutbox(db, fetcher);
  assert.equal(calls, 1, "two due events for the same binding produce exactly one Slack API call");
  assert.equal(result.channelsSent, 1);
  const rows = await db.prepare("SELECT status FROM integration_outbox WHERE binding_id = ?").bind(bindingId).all();
  assert.deepEqual(rows.results.map((row) => row.status), ["completed", "completed"]);
});

test("a 429 defers the outbox by Retry-After without counting it as a real attempt", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const project = await db.prepare("SELECT organization_id, name FROM projects WHERE id = ?").bind(projectId).first();
  const connectionId = await slackConnection(db, project.organization_id);
  const { bindingId } = await createChannelBinding(db, browser, { provider: "slack", connectionId, scopeType: "project", projectId, channelId: "C1", channelName: "eng" });
  const statements = await buildPublicationStatements(db, { organizationId: project.organization_id, projectId, projectName: project.name, eventType: "work_item.blocked", workItemId: "wi_1", itemKey: "#1", title: "Ship it", summary: "moved to blocked" });
  await db.batch(statements);
  await db.prepare("UPDATE integration_outbox SET next_attempt_at = now() - interval '1 second' WHERE binding_id = ?").bind(bindingId).run();

  const fetcher = async () => new Response("rate limited", { status: 429, headers: { "retry-after": "5" } });
  await drainSlackOutbox(db, fetcher);
  const row = await db.prepare("SELECT attempts, status, next_attempt_at FROM integration_outbox WHERE binding_id = ?").bind(bindingId).first();
  assert.equal(row.status, "pending", "rate limiting is deferred, not failed");
  assert.equal(Number(row.attempts), 0, "a rate limit never counts against the dead-letter cap");
  assert.equal(new Date(row.next_attempt_at).getTime() > Date.now(), true, "next_attempt_at moved into the future");
});

test("repeated genuine failures dead-letter the row and degrade the binding, without ever touching the network again that tick", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const project = await db.prepare("SELECT organization_id, name FROM projects WHERE id = ?").bind(projectId).first();
  const connectionId = await slackConnection(db, project.organization_id);
  const { bindingId } = await createChannelBinding(db, browser, { provider: "slack", connectionId, scopeType: "project", projectId, channelId: "C1", channelName: "eng" });
  const statements = await buildPublicationStatements(db, { organizationId: project.organization_id, projectId, projectName: project.name, eventType: "work_item.blocked", workItemId: "wi_1", itemKey: "#1", title: "Ship it", summary: "moved to blocked" });
  await db.batch(statements);
  // Simulate seven prior genuine failures so this drain tips it over MAX_ATTEMPTS.
  await db.prepare("UPDATE integration_outbox SET next_attempt_at = now() - interval '1 second', attempts = 7 WHERE binding_id = ?").bind(bindingId).run();

  const fetcher = async () => new Response("invalid_auth", { status: 401 });
  await drainSlackOutbox(db, fetcher);
  const row = await db.prepare("SELECT status, attempts FROM integration_outbox WHERE binding_id = ?").bind(bindingId).first();
  assert.equal(row.status, "dead_letter");
  const binding = await db.prepare("SELECT status FROM integration_channel_bindings WHERE id = ?").bind(bindingId).first();
  assert.equal(binding.status, "degraded");
});

// --- end-to-end: a real domain transition enqueues a publication in the same commit --

test("transitioning a work item to blocked enqueues a Slack publication for a bound project", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const project = await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(projectId).first();
  const connectionId = await slackConnection(db, project.organization_id);
  await createChannelBinding(db, browser, { provider: "slack", connectionId, scopeType: "project", projectId, channelId: "C1", channelName: "eng" });

  const created = await executeCommand(db, browser, { action: "create_item", projectId, title: "Ship checkout", idempotencyKey: `item-${crypto.randomUUID()}` });
  const started = await executeCommand(db, browser, { action: "transition_item", projectId, itemId: created.itemId, expectedVersion: created.version, status: "in_progress", idempotencyKey: `t-${crypto.randomUUID()}` });
  await executeCommand(db, browser, { action: "transition_item", projectId, itemId: created.itemId, expectedVersion: started.version, status: "blocked", reason: "waiting on payments API", idempotencyKey: `t-${crypto.randomUUID()}` });

  const row = await db.prepare("SELECT payload FROM integration_outbox WHERE organization_id = ?").bind(project.organization_id).first();
  assert.ok(row, "the transition queued a publication without any explicit integration code at the call site");
  const payload = JSON.parse(row.payload);
  assert.equal(payload.eventType, "work_item.blocked");
  assert.equal(payload.workItemId, created.itemId);
});

test("a project with no Slack binding produces no outbox row at all", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const created = await executeCommand(db, browser, { action: "create_item", projectId, title: "Ship checkout", idempotencyKey: `item-${crypto.randomUUID()}` });
  const started = await executeCommand(db, browser, { action: "transition_item", projectId, itemId: created.itemId, expectedVersion: created.version, status: "in_progress", idempotencyKey: `t-${crypto.randomUUID()}` });
  await executeCommand(db, browser, { action: "transition_item", projectId, itemId: created.itemId, expectedVersion: started.version, status: "blocked", idempotencyKey: `t-${crypto.randomUUID()}` });
  const rows = await db.prepare("SELECT id FROM integration_outbox").all();
  assert.equal(rows.results.length, 0);
});
