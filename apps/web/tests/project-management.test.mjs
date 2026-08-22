/**
 * Project creation and binding. These cover the gap that made a connected agent
 * useless: a project created from the web UI has no directory, so nothing can match
 * it to a repository until an agent binds its own absolute path with update_project.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand, loadDashboard, registerSourceSession, updateSourceHeartbeat } from "@/lib/store.ts";
import { loadProjectView } from "@/lib/read/project-view.ts";
import { createTestDb } from "./support/local-pg.mjs";
import { principal } from "./support/fixtures.mjs";

/** Mirrors resolve_project's matcher in app/mcp/route.ts, which is what agents hit. */
function resolve(projects, query) {
  const needle = query.toLowerCase();
  return projects.filter((project) => [project.name, project.directory, project.gitRemote ?? ""].some((value) => value.toLowerCase().includes(needle)));
}

async function projects(db) {
  return (await loadDashboard(db, principal)).projects;
}

test("create_project persists a git remote so a repo-aware agent can match on it", async () => {
  const db = await createTestDb();
  await executeCommand(db, principal, { action: "create_project", name: "Remote Bound", gitRemote: "https://github.com/owner/repo", idempotencyKey: "p1" });

  const [project] = await projects(db);
  assert.equal(project.gitRemote, "https://github.com/owner/repo");
  assert.equal(resolve(await projects(db), "github.com/owner/repo").length, 1);
});

test("a project created from the web UI has no directory and cannot be resolved by path", async () => {
  const db = await createTestDb();
  await executeCommand(db, principal, { action: "create_project", name: "Web Created", idempotencyKey: "p2" });

  const [project] = await projects(db);
  assert.equal(project.directory, "");
  assert.equal(project.gitRemote, null);
  assert.equal(resolve(await projects(db), "/Users/me/Projects/web-created").length, 0);
});

test("update_project binds an absolute working directory, making the project resolvable by path", async () => {
  const db = await createTestDb();
  const { projectId } = await executeCommand(db, principal, { action: "create_project", name: "Web Created", idempotencyKey: "p3" });

  await executeCommand(db, principal, { action: "update_project", projectId, directory: "/Users/me/Projects/web-created", idempotencyKey: "u1" });

  const matched = resolve(await projects(db), "/Users/me/Projects/web-created");
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, projectId);
});

test("update_project leaves fields it was not given alone", async () => {
  const db = await createTestDb();
  const { projectId } = await executeCommand(db, principal, { action: "create_project", name: "Keep My Name", description: "Set in the UI", idempotencyKey: "p4" });

  // An agent binding only its directory must not blank out what a person typed.
  await executeCommand(db, principal, { action: "update_project", projectId, directory: "/srv/keep", idempotencyKey: "u2" });

  const [project] = await projects(db);
  assert.equal(project.name, "Keep My Name");
  assert.equal(project.description, "Set in the UI");
  assert.equal(project.directory, "/srv/keep");
});

test("update_project rejects an explicitly empty name instead of silently clearing it", async () => {
  const db = await createTestDb();
  const { projectId } = await executeCommand(db, principal, { action: "create_project", name: "Named", idempotencyKey: "p5" });

  await assert.rejects(
    executeCommand(db, principal, { action: "update_project", projectId, name: "   ", idempotencyKey: "u3" }),
    (error) => error.code === "VALIDATION_FAILED",
  );
  assert.equal((await projects(db))[0].name, "Named");
});

test("replaying the same update_project key returns the first result rather than bumping the revision again", async () => {
  const db = await createTestDb();
  const { projectId } = await executeCommand(db, principal, { action: "create_project", name: "Idempotent", idempotencyKey: "p6" });

  const first = await executeCommand(db, principal, { action: "update_project", projectId, directory: "/srv/once", idempotencyKey: "u4" });
  const replay = await executeCommand(db, principal, { action: "update_project", projectId, directory: "/srv/once", idempotencyKey: "u4" });

  assert.equal(replay.projectRevision, first.projectRevision);
  assert.equal(replay.idempotentReplay, true);
});

test("project teams provide stable multi-owner choices and removing a member unassigns only that person", async () => {
  const db = await createTestDb();
  const { projectId } = await executeCommand(db, principal, { action: "create_project", name: "Team project", idempotencyKey: "team-project" });
  const created = await executeCommand(db, principal, { action: "create_item", projectId, title: "Shared task", idempotencyKey: "team-task" });
  const rae = await executeCommand(db, principal, { action: "add_project_member", projectId, name: "Rae", email: "rae@example.com", idempotencyKey: "member-rae" });
  const sam = await executeCommand(db, principal, { action: "add_project_member", projectId, name: "Sam", idempotencyKey: "member-sam" });

  await executeCommand(db, principal, { action: "update_item", projectId, itemId: created.itemId, expectedVersion: 1, assigneeMemberIds: [rae.memberId, sam.memberId], idempotencyKey: "assign-team" });
  let dashboard = await loadDashboard(db, principal);
  let item = dashboard.workItems.find((entry) => entry.id === created.itemId);
  assert.equal(item.assignee, "Rae, Sam");
  assert.deepEqual(item.assigneeMemberIds, [rae.memberId, sam.memberId]);
  assert.equal(dashboard.projectMembers.some((member) => member.projectId === projectId && member.externalId === principal.userId), true, "the project creator is always an assignment choice");

  await executeCommand(db, principal, { action: "remove_project_member", projectId, memberId: rae.memberId, idempotencyKey: "remove-rae" });
  dashboard = await loadDashboard(db, principal);
  item = dashboard.workItems.find((entry) => entry.id === created.itemId);
  assert.equal(item.assignee, "Sam");
  assert.deepEqual(item.assigneeMemberIds, [sam.memberId]);
  assert.equal(dashboard.projectMembers.some((member) => member.id === rae.memberId), false);
});

test("an owner from another project cannot be assigned", async () => {
  const db = await createTestDb();
  const first = await executeCommand(db, principal, { action: "create_project", name: "First team", idempotencyKey: "first-team" });
  const second = await executeCommand(db, principal, { action: "create_project", name: "Second team", idempotencyKey: "second-team" });
  const item = await executeCommand(db, principal, { action: "create_item", projectId: first.projectId, title: "Scoped task", idempotencyKey: "scoped-task" });
  const outsider = await executeCommand(db, principal, { action: "add_project_member", projectId: second.projectId, name: "Other team", idempotencyKey: "other-team-member" });
  await assert.rejects(
    executeCommand(db, principal, { action: "update_item", projectId: first.projectId, itemId: item.itemId, expectedVersion: 1, assigneeMemberIds: [outsider.memberId], idempotencyKey: "cross-project-owner" }),
    (error) => error.code === "INVALID_ASSIGNEE",
  );
});

test("remove_source hides one project session without deleting its historical provenance", async () => {
  const db = await createTestDb();
  const { projectId } = await executeCommand(db, principal, { action: "create_project", name: "Agent cleanup", idempotencyKey: "p7" });
  const registered = await registerSourceSession(db, principal, { projectId, provider: "cursor", externalId: "cursor-session-1", title: "Cursor plan" });
  const created = await executeCommand(db, principal, { action: "create_item", projectId, title: "Historical work", sourceId: registered.sourceId, idempotencyKey: "agent-item" });

  const removed = await executeCommand(db, principal, { action: "remove_source", projectId, sourceId: registered.sourceId, idempotencyKey: "remove-agent" });
  const dashboard = await loadDashboard(db, principal);
  const source = dashboard.sources.find((entry) => entry.id === registered.sourceId);
  const item = dashboard.workItems.find((entry) => entry.id === created.itemId);

  assert.equal(source.status, "removed");
  assert.equal(item.sourceId, registered.sourceId, "removing a card must not erase historical attribution");
  assert.equal(dashboard.events.some((event) => event.eventType === "source.removed" && event.sourceId === registered.sourceId), true);
  assert.equal(removed.projectRevision, 3);

  const heartbeat = await updateSourceHeartbeat(db, principal, { sourceId: registered.sourceId, state: "active", currentTaskIds: [created.itemId] });
  assert.equal(heartbeat.status, "removed", "a background heartbeat must not undo an explicit removal");
  assert.equal((await db.prepare("SELECT COUNT(*)::int AS count FROM work_claims WHERE source_id = ?").bind(registered.sourceId).first()).count, 0);

  const reconnected = await registerSourceSession(db, principal, { projectId, provider: "cursor", externalId: "cursor-session-1", title: "Cursor plan" });
  assert.equal(reconnected.sourceId, registered.sourceId);
  assert.equal((await loadDashboard(db, principal)).sources.find((entry) => entry.id === registered.sourceId).status, "active");
});

test("delete_project removes the project from active surfaces while preserving an archival tombstone", async () => {
  const db = await createTestDb();
  const created = await executeCommand(db, principal, { action: "create_project", name: "Delete me", idempotencyKey: "delete-project-create" });
  const organizationId = (await db.prepare("SELECT organization_id FROM projects WHERE id = ?").bind(created.projectId).first()).organization_id;

  const deleted = await executeCommand(db, principal, { action: "delete_project", projectId: created.projectId, idempotencyKey: "delete-project" });
  const replay = await executeCommand(db, principal, { action: "delete_project", projectId: created.projectId, idempotencyKey: "delete-project" });

  assert.equal((await db.prepare("SELECT status FROM projects WHERE id = ?").bind(created.projectId).first()).status, "archived", "history is retained as an internal tombstone");
  assert.equal((await loadDashboard(db, principal)).projects.some((project) => project.id === created.projectId), false, "deleted projects must disappear from the sidebar payload");
  await assert.rejects(() => loadProjectView(db, organizationId, created.projectId), (error) => error.code === "NOT_FOUND");
  await assert.rejects(
    () => executeCommand(db, principal, { action: "update_project", projectId: created.projectId, name: "Should stay deleted", idempotencyKey: "update-deleted-project" }),
    (error) => error.code === "NOT_FOUND",
  );
  assert.equal(replay.idempotentReplay, true, "retrying the original delete remains safe after the project disappears");
  assert.equal(replay.projectRevision, deleted.projectRevision);
});
