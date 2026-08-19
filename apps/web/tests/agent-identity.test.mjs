/**
 * Agent accounts: telling two logins for the SAME model apart.
 *
 * Two CLI aliases (claude-personal, claude-work) reach Planbraid over the same protocol
 * and register under whatever provider string the model types, so nothing about the
 * request itself distinguished them. Identity is now resolved server-side from the
 * credential plus an optional ?agent= marker, which is what these cover — along with the
 * deliberate split between how the ranking counts corroboration (per model) and how the
 * UI shows it (per account).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { actorNameFor, createMcpToken, executeCommand, getReadyWork, loadDashboard, organizationFor, principalFromBearer, registerSourceSession, updateSourceHeartbeat } from "@/lib/store.ts";
import { accountDisplayName, agentAccountKey, normalizeAccountLabel, providerFamily } from "@/lib/providers.ts";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject, createItem } from "./support/fixtures.mjs";

/** Authenticates the way a real MCP request does, so the test exercises the same
 * resolution path production uses rather than hand-building a Principal. */
async function connect(db, name, marker) {
  const created = await createMcpToken(db, principal, name);
  const authenticated = await principalFromBearer(db, `Bearer ${created.token}`, undefined, marker);
  assert.ok(authenticated, `token ${name} should authenticate`);
  return authenticated;
}

async function sourceRow(db, sourceId) {
  return db.prepare("SELECT provider, external_id, title, status, agent_account_id, agent_account_label FROM sources WHERE id = ?").bind(sourceId).first();
}

test("one credential, two ?agent= markers: two accounts, not one", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const created = await createMcpToken(db, principal, "Claude Code");

  const personal = await principalFromBearer(db, `Bearer ${created.token}`, undefined, "personal");
  const work = await principalFromBearer(db, `Bearer ${created.token}`, undefined, "work");

  assert.notEqual(personal.agentAccountId, work.agentAccountId, "the marker has to be part of the account key or shared-credential aliases collapse");
  assert.equal(personal.agentAccountLabel, "personal");
  assert.equal(work.agentAccountLabel, "work");

  const a = await registerSourceSession(db, personal, { projectId, provider: "claude", externalId: "conv-1" });
  const b = await registerSourceSession(db, work, { projectId, provider: "claude", externalId: "conv-2" });
  assert.notEqual(a.sourceId, b.sourceId);
  assert.equal((await sourceRow(db, a.sourceId)).agent_account_label, "personal");
  assert.equal((await sourceRow(db, b.sourceId)).agent_account_label, "work");
});

test("separate credentials are distinct accounts with no marker needed", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const personal = await connect(db, "Claude personal");
  const work = await connect(db, "Claude work");

  assert.notEqual(personal.agentAccountId, work.agentAccountId);
  // The credential's name is the one thing about a connection its owner chose, so it is
  // what every write falls back to instead of a fixed "Connected agent".
  assert.equal(personal.displayName, "Claude personal");
  assert.equal(work.displayName, "Claude work");

  const a = await registerSourceSession(db, personal, { projectId, provider: "claude", externalId: "conv-1" });
  const b = await registerSourceSession(db, work, { projectId, provider: "claude", externalId: "conv-2" });
  assert.equal((await sourceRow(db, a.sourceId)).agent_account_label, "Claude personal");
  assert.equal((await sourceRow(db, b.sourceId)).agent_account_label, "Claude work");
});

test("no bearer connection ever reports itself as the generic \"Connected agent\"", async () => {
  const db = await createTestDb();
  const named = await connect(db, "Claude work");
  assert.notEqual(named.displayName, "Connected agent");
  assert.equal(named.displayName, "Claude work");

  // A marker qualifies the credential name rather than replacing it, so a shared
  // credential still says which login acted.
  const marked = await connect(db, "Claude Code", "work");
  assert.equal(marked.displayName, "Claude Code (work)");
});

test("the same account across two conversations is one account and two sessions", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const work = await connect(db, "Claude Code", "work");

  const first = await registerSourceSession(db, work, { projectId, provider: "claude", externalId: "conv-1" });
  const second = await registerSourceSession(db, work, { projectId, provider: "claude", externalId: "conv-2" });

  assert.notEqual(first.sourceId, second.sourceId, "each conversation is its own session");
  const rows = [await sourceRow(db, first.sourceId), await sourceRow(db, second.sourceId)];
  assert.equal(new Set(rows.map((row) => row.agent_account_id)).size, 1, "but both belong to one account");
});

test("a new conversation reuses the same account's ended card for every provider", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);

  for (const provider of ["codex", "claude", "cursor"]) {
    const account = await connect(db, `${provider} account`);
    const first = await registerSourceSession(db, account, { projectId, provider, externalId: `${provider}-old`, title: `${provider} old conversation` });
    await updateSourceHeartbeat(db, account, { sourceId: first.sourceId, end: true });

    const resumed = await registerSourceSession(db, account, { projectId, provider, externalId: `${provider}-new`, title: `${provider} new conversation` });
    assert.equal(resumed.sourceId, first.sourceId, `${provider} should keep its durable project card`);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.idempotentReplay, false, "a different external conversation is a resume, not an idempotent replay");
    assert.deepEqual(
      await sourceRow(db, resumed.sourceId),
      {
        provider,
        external_id: `${provider}-new`,
        title: `${provider} new conversation`,
        status: "active",
        agent_account_id: account.agentAccountId,
        agent_account_label: `${provider} account`,
      },
    );
    assert.equal((await db.prepare("SELECT COUNT(*)::int AS count FROM sources WHERE project_id = ? AND provider = ?").bind(projectId, provider).first()).count, 1);
  }
});

test("an ended card is never reused by a different account", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const personal = await connect(db, "Codex personal");
  const work = await connect(db, "Codex work");

  const ended = await registerSourceSession(db, personal, { projectId, provider: "codex", externalId: "personal-old" });
  await updateSourceHeartbeat(db, personal, { sourceId: ended.sourceId, end: true });
  const registered = await registerSourceSession(db, work, { projectId, provider: "codex", externalId: "work-new" });

  assert.notEqual(registered.sourceId, ended.sourceId);
  assert.equal(registered.resumed, false);
  assert.equal((await sourceRow(db, ended.sourceId)).status, "ended");
});

test("a second account reusing a session id gets its own source instead of adopting the first", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const personal = await connect(db, "Claude personal");
  const work = await connect(db, "Claude work");

  // Clients that reuse a fixed session id would otherwise collide on sources'
  // UNIQUE(project_id, provider, external_id) and silently share one row.
  const first = await registerSourceSession(db, personal, { projectId, provider: "claude", externalId: "default" });
  const second = await registerSourceSession(db, work, { projectId, provider: "claude", externalId: "default" });

  assert.notEqual(first.sourceId, second.sourceId);
  assert.equal((await sourceRow(db, second.sourceId)).agent_account_label, "Claude work");
  // Re-registering is still idempotent for each account.
  const replay = await registerSourceSession(db, work, { projectId, provider: "claude", externalId: "default" });
  assert.equal(replay.sourceId, second.sourceId);
});

test("ranking counts two accounts of one model once, but Claude plus Codex twice", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const personal = await connect(db, "Claude personal");
  const work = await connect(db, "Claude work");
  const codexAccount = await connect(db, "Codex");

  const claudeA = await registerSourceSession(db, personal, { projectId, provider: "claude", externalId: "c1" });
  const claudeB = await registerSourceSession(db, work, { projectId, provider: "claude", externalId: "c2" });
  const codex = await registerSourceSession(db, codexAccount, { projectId, provider: "codex", externalId: "x1" });

  async function readyWithAlias(title, ownerSourceId, aliasSourceId, key) {
    const itemId = await createItem(db, projectId, title, key);
    await db.prepare("UPDATE work_items SET source_id = ?, maturity = 'accepted', version = version + 1 WHERE id = ?").bind(ownerSourceId, itemId).run();
    await db.prepare("INSERT INTO work_item_aliases (id, organization_id, project_id, work_item_id, title, source_id) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(`als_${key}`, organizationId, projectId, itemId, title, aliasSourceId).run();
    return itemId;
  }

  const sameModel = await readyWithAlias("Two Claude logins agree", claudeA.sourceId, claudeB.sourceId, "same");
  const twoModels = await readyWithAlias("Claude and Codex agree", claudeA.sourceId, codex.sourceId, "cross");

  const ranked = await getReadyWork(db, principal, { projectId });
  const scoreOf = (id) => ranked.workItems.find((item) => item.id === id).corroboration;
  assert.equal(scoreOf(sameModel), 1, "two accounts of one model reason alike; counting them twice would inflate the signal");
  assert.equal(scoreOf(twoModels), 2, "two different models agreeing is the evidence corroboration is meant to capture");
});

test("the dashboard exposes each session's account so the UI can separate them", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const personal = await connect(db, "Claude personal");
  const work = await connect(db, "Claude work");
  await registerSourceSession(db, personal, { projectId, provider: "claude-code", externalId: "c1" });
  await registerSourceSession(db, work, { projectId, provider: "claude-code", externalId: "c2" });

  const sources = (await loadDashboard(db, principal)).sources.filter((source) => source.projectId === projectId);
  assert.equal(sources.length, 2);
  // Same model family, different accounts: exactly the case the UI has to qualify.
  assert.equal(new Set(sources.map((source) => providerFamily(source.provider))).size, 1);
  assert.deepEqual(sources.map((source) => source.agentAccountLabel).sort(), ["Claude personal", "Claude work"]);
});

test("an agent-declared label is only a fallback, never an override", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const work = await connect(db, "Claude Code", "work");

  // A model claiming to be another account must not be able to relabel its own writes.
  const registered = await registerSourceSession(db, work, { projectId, provider: "claude", externalId: "c1", accountLabel: "personal" });
  assert.equal((await sourceRow(db, registered.sourceId)).agent_account_label, "work");

  // With nothing authoritative to go on, the declared label is better than nothing.
  const anonymous = { ...principal };
  const declared = await registerSourceSession(db, anonymous, { projectId, provider: "claude", externalId: "c2", accountLabel: "personal" });
  assert.equal((await sourceRow(db, declared.sourceId)).agent_account_label, "personal");
});

test("account keys and labels are built defensively", () => {
  assert.equal(agentAccountKey("tok_1", "work"), "tok_1#work");
  assert.equal(agentAccountKey("tok_1", null), "tok_1");
  assert.equal(agentAccountKey(null, "work"), "work");
  assert.equal(agentAccountKey(null, null), null);
  assert.equal(agentAccountKey("tok_1", "   "), "tok_1", "a whitespace-only marker is not an account");

  assert.equal(normalizeAccountLabel("  work  "), "work");
  assert.equal(normalizeAccountLabel(""), null);
  assert.equal(normalizeAccountLabel(null), null);
  assert.equal(normalizeAccountLabel("wo\u0000rk\u001f"), "work", "control characters would corrupt event text and the sidebar");
  assert.equal(normalizeAccountLabel("x".repeat(200)).length, 60);
});

test("events name the account, not just the model", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const personal = await connect(db, "Claude personal");
  const work = await connect(db, "Claude work");
  const personalSession = await registerSourceSession(db, personal, { projectId, provider: "claude-code", externalId: "c1" });
  const workSession = await registerSourceSession(db, work, { projectId, provider: "claude-code", externalId: "c2" });

  const itemId = await createItem(db, projectId, "Rotate signing keys", "rot");
  await executeCommand(db, personal, { action: "add_note", projectId, itemId, summary: "Read the runbook", sourceId: personalSession.sourceId, idempotencyKey: "n1" });
  await executeCommand(db, work, { action: "add_note", projectId, itemId, summary: "Filed the ticket", sourceId: workSession.sourceId, idempotencyKey: "n2" });

  const actors = (await db.prepare("SELECT actor_name FROM work_events WHERE work_item_id = ? AND event_type = ? ORDER BY created_at").bind(itemId, "work_item.progress_reported").all()).results.map((row) => row.actor_name);
  assert.deepEqual(actors, ["Claude personal", "Claude work"], "the activity feed has to separate two logins for one model");
});

test("actor names qualify a bare marker but do not repeat the model twice", () => {
  assert.equal(actorNameFor("claude-code", "work"), "Claude · work", "a bare marker needs the model to be legible");
  assert.equal(actorNameFor("claude-code", "Claude personal"), "Claude personal", "a credential name already says the model");
  assert.equal(actorNameFor("claude-code", null), "Claude");
  assert.equal(actorNameFor("some-local-llm", null), "Some local llm");
});

test("a call that omits source_id is attributed to the caller, not the item's creator", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const personal = await connect(db, "Claude personal");
  const work = await connect(db, "Claude work");
  const personalSession = await registerSourceSession(db, personal, { projectId, provider: "claude-code", externalId: "c1" });

  const itemId = await createItem(db, projectId, "Rotate signing keys", "rot2");
  await db.prepare("UPDATE work_items SET source_id = ? WHERE id = ?").bind(personalSession.sourceId, itemId).run();

  // "work" acts on an item "personal" created, and passes no source_id of its own.
  await executeCommand(db, work, { action: "add_note", projectId, itemId, summary: "Filed the ticket", idempotencyKey: "n1" });

  const actor = (await db.prepare("SELECT actor_name FROM work_events WHERE work_item_id = ? AND event_type = ? ORDER BY created_at DESC").bind(itemId, "work_item.progress_reported").first()).actor_name;
  assert.equal(actor, "Claude work", "the acting connection outranks whoever happened to create the item");
});

test("a signed-in person is never relabelled as one of their agents", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const agent = await connect(db, "Claude personal");
  const agentSession = await registerSourceSession(db, agent, { projectId, provider: "claude-code", externalId: "c1" });

  const itemId = await createItem(db, projectId, "Rotate signing keys", "rot3");
  await db.prepare("UPDATE work_items SET source_id = ? WHERE id = ?").bind(agentSession.sourceId, itemId).run();

  const browser = { ...principal, authentication: "browser" };
  await executeCommand(db, browser, { action: "add_note", projectId, itemId, summary: "Looks right to me", idempotencyKey: "n1" });

  const actor = (await db.prepare("SELECT actor_name FROM work_events WHERE work_item_id = ? AND event_type = ? ORDER BY created_at DESC").bind(itemId, "work_item.progress_reported").first()).actor_name;
  assert.equal(actor, principal.displayName);
});

test("the event log and the UI name an account identically", () => {
  // One rule, so a card and its history never disagree about what to call an account.
  for (const [provider, label, expected] of [
    ["claude-code", "work", "Claude · work"],
    ["claude-code", "Claude work", "Claude work"],
    ["claude-code", null, "Claude"],
    ["codex-cli", "work", "Codex · work"],
  ]) {
    assert.equal(accountDisplayName(provider, label), expected);
    assert.equal(actorNameFor(provider, label), expected, "the event log must not drift from the UI");
  }
});

test("two credentials the owner named the same read as one proposer", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  // Re-issuing a token under the same name is a rotation, not a second agent.
  const older = await connect(db, "Claude personal");
  const newer = await connect(db, "Claude personal");
  assert.notEqual(older.agentAccountId, newer.agentAccountId, "they are still separate credentials");

  await registerSourceSession(db, older, { projectId, provider: "claude-code", externalId: "c1" });
  await registerSourceSession(db, newer, { projectId, provider: "claude-code", externalId: "c2" });

  const sources = (await loadDashboard(db, projectId ? principal : principal)).sources.filter((source) => source.projectId === projectId);
  const displayKeys = new Set(sources.map((source) => `${providerFamily(source.provider)}:${source.agentAccountLabel ?? ""}`));
  assert.equal(displayKeys.size, 1, "rendering the same label twice in a row reads as a bug, so the UI collapses them");
});
