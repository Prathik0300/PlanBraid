import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject } from "./support/fixtures.mjs";
import { loadDashboard, organizationFor, registerSourceSession, updateSourceHeartbeat } from "@/lib/store.ts";
import { loadProjectView } from "@/lib/read/project-view.ts";
import { normalizeSourcePresence, SOURCE_ACTIVE_WINDOW_MS, SOURCE_ENDED_AFTER_MS } from "@/lib/presence.ts";

test("presence normalization has explicit active, idle, and ended boundaries", () => {
  const now = Date.parse("2026-08-19T02:00:00.000Z");
  const seen = (age) => new Date(now - age).toISOString();

  assert.equal(normalizeSourcePresence("active", seen(SOURCE_ACTIVE_WINDOW_MS - 1), now), "active");
  assert.equal(normalizeSourcePresence("active", seen(SOURCE_ACTIVE_WINDOW_MS), now), "idle");
  assert.equal(normalizeSourcePresence("active", seen(SOURCE_ENDED_AFTER_MS - 1), now), "idle");
  assert.equal(normalizeSourcePresence("active", seen(SOURCE_ENDED_AFTER_MS), now), "ended");
  assert.equal(normalizeSourcePresence("idle", seen(0), now), "idle", "explicit idle must not be promoted to active");
  assert.equal(normalizeSourcePresence("ended", seen(0), now), "ended", "explicit end is authoritative");
  assert.equal(normalizeSourcePresence("removed", seen(0), now), "removed", "project removal is authoritative");
  assert.equal(normalizeSourcePresence("active", "not-a-date", now), "unknown");
});

test("dashboard and project-scoped reads derive the same freshness-based presence", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: "presence-read" });
  const organizationId = await organizationFor(db, principal);

  await db.prepare("UPDATE sources SET status = 'active', last_seen_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - SOURCE_ACTIVE_WINDOW_MS - 5_000).toISOString(), source.sourceId).run();
  assert.equal((await loadDashboard(db, principal)).sources.find((entry) => entry.id === source.sourceId).status, "idle");
  assert.equal((await loadProjectView(db, organizationId, projectId, { sources: true })).sources[0].status, "idle");

  await db.prepare("UPDATE sources SET last_seen_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - SOURCE_ENDED_AFTER_MS - 5_000).toISOString(), source.sourceId).run();
  const endedSource = (await loadDashboard(db, principal)).sources.find((entry) => entry.id === source.sourceId);
  assert.equal(endedSource.status, "ended");
  assert.deepEqual(endedSource.currentTaskIds, [], "an ended source must not advertise stale current work");
  assert.equal((await loadProjectView(db, organizationId, projectId, { sources: true })).sources[0].status, "ended");
});

test("explicit end survives stray heartbeats and a new registration resumes the durable source", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const source = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "presence-terminal" });

  assert.equal((await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, end: true })).status, "ended");
  assert.equal((await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, state: "active" })).status, "ended");
  assert.equal((await loadDashboard(db, principal)).sources.find((entry) => entry.id === source.sourceId).status, "ended");

  const reconnected = await registerSourceSession(db, principal, { projectId, provider: "codex", externalId: "presence-terminal-next" });
  assert.equal(reconnected.sourceId, source.sourceId);
  assert.equal(reconnected.resumed, true);
  assert.equal((await loadDashboard(db, principal)).sources.find((entry) => entry.id === source.sourceId).status, "active");
});

test("a freshness-expired source is reusable but a project-removed source is not", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const expired = await registerSourceSession(db, principal, { projectId, provider: "cursor", externalId: "expired-old" });
  await db.prepare("UPDATE sources SET last_seen_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - SOURCE_ENDED_AFTER_MS - 5_000).toISOString(), expired.sourceId).run();

  const resumed = await registerSourceSession(db, principal, { projectId, provider: "cursor", externalId: "expired-new" });
  assert.equal(resumed.sourceId, expired.sourceId);
  assert.equal(resumed.resumed, true);

  await db.prepare("UPDATE sources SET status = 'removed' WHERE id = ?").bind(resumed.sourceId).run();
  const replacement = await registerSourceSession(db, principal, { projectId, provider: "cursor", externalId: "after-removal" });
  assert.notEqual(replacement.sourceId, resumed.sourceId, "user removal must not be undone by an unrelated new conversation");
});
