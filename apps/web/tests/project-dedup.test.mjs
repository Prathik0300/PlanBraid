/**
 * Project deduplication. Work items were matched before creation from the start, but
 * projects were not, so one repository set up in the web UI and then reported to by an
 * agent produced two projects each holding half the work. The real duplicates differed
 * only by a ".git" suffix and name casing, which is what these cover.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand, findMatchingProject, loadDashboard, normalizeGitRemote, organizationFor } from "@/lib/store.ts";
import { createTestDb } from "./support/local-pg.mjs";
import { principal } from "./support/fixtures.mjs";

async function orgFor(db) {
  return organizationFor(db, principal);
}

async function projectCount(db) {
  return (await loadDashboard(db, principal)).projects.length;
}

test("every spelling of the same remote normalizes to one identity", () => {
  const canonical = "github.com/prathik0300/planbraid";
  for (const spelling of [
    "https://github.com/Prathik0300/PlanBraid",
    "https://github.com/Prathik0300/PlanBraid.git",
    "https://github.com/Prathik0300/PlanBraid/",
    "git@github.com:Prathik0300/PlanBraid.git",
    "ssh://git@github.com/Prathik0300/PlanBraid",
    "https://user@github.com/prathik0300/planbraid",
  ]) assert.equal(normalizeGitRemote(spelling), canonical, spelling);

  assert.equal(normalizeGitRemote("https://github.com/other/repo"), "github.com/other/repo");
  assert.equal(normalizeGitRemote(null), "");
});

test("the exact production duplicate collapses: web UI browse URL, then agent .git origin", async () => {
  const db = await createTestDb();
  // What the web UI stored when a GitHub repo was linked.
  const web = await executeCommand(db, principal, { action: "create_project", name: "PlanBraid", gitRemote: "https://github.com/Prathik0300/PlanBraid", idempotencyKey: "web" });
  // What the agent sent from the checkout: .git suffix, different casing, plus a path.
  const agent = await executeCommand(db, principal, { action: "create_project", name: "Planbraid", directory: "/Users/me/Projects/TODO MCP", gitRemote: "https://github.com/Prathik0300/PlanBraid.git", idempotencyKey: "agent" });

  assert.equal(agent.status, "matched");
  assert.equal(agent.matchedOn, "git remote");
  assert.equal(agent.projectId, web.projectId);
  assert.equal(await projectCount(db), 1);
});

test("matching adopts the working directory the existing project was missing", async () => {
  const db = await createTestDb();
  await executeCommand(db, principal, { action: "create_project", name: "PlanBraid", gitRemote: "https://github.com/owner/repo", idempotencyKey: "web" });
  const matched = await executeCommand(db, principal, { action: "create_project", name: "PlanBraid", directory: "/Users/me/Projects/repo", gitRemote: "git@github.com:owner/repo.git", idempotencyKey: "agent" });

  // The browser could never supply a path; the agent's first contact fills it in, so
  // later sessions resolve by directory without another round trip.
  assert.equal(matched.project.directory, "/Users/me/Projects/repo");
  const found = await findMatchingProject(db, await orgFor(db), { directory: "/Users/me/Projects/repo" });
  assert.equal(found.id, matched.projectId);
});

test("a shared working directory matches even with no remote on either side", async () => {
  const db = await createTestDb();
  const first = await executeCommand(db, principal, { action: "create_project", name: "Some Name", directory: "/srv/app", idempotencyKey: "a" });
  const second = await executeCommand(db, principal, { action: "create_project", name: "Totally Different Name", directory: "/srv/app/", idempotencyKey: "b" });

  assert.equal(second.status, "matched");
  assert.equal(second.matchedOn, "directory");
  assert.equal(second.projectId, first.projectId);
});

test("an identical name matches when nothing stronger is available", async () => {
  const db = await createTestDb();
  const first = await executeCommand(db, principal, { action: "create_project", name: "Planbraid", idempotencyKey: "a" });
  const second = await executeCommand(db, principal, { action: "create_project", name: "  planbraid  ", idempotencyKey: "b" });

  assert.equal(second.matchedOn, "name");
  assert.equal(second.projectId, first.projectId);
});

test("genuinely different repositories still create separate projects", async () => {
  const db = await createTestDb();
  await executeCommand(db, principal, { action: "create_project", name: "Alpha", directory: "/srv/alpha", gitRemote: "https://github.com/owner/alpha", idempotencyKey: "a" });
  const beta = await executeCommand(db, principal, { action: "create_project", name: "Beta", directory: "/srv/beta", gitRemote: "https://github.com/owner/beta", idempotencyKey: "b" });

  assert.equal(beta.status, "created");
  assert.equal(await projectCount(db), 2);
});

test("a name-only match is reported as uncertain, not silently reused or duplicated", async () => {
  const db = await createTestDb();
  const first = await executeCommand(db, principal, { action: "create_project", name: "Ambiguous", idempotencyKey: "a" });
  const second = await executeCommand(db, principal, { action: "create_project", name: "Ambiguous", idempotencyKey: "b" });

  assert.equal(second.status, "uncertain");
  assert.equal(second.projectId, first.projectId);
  // Neither reused (matched) nor duplicated (created) until a person or agent decides.
  assert.equal(await projectCount(db), 1);
});

test("8 concurrent create_project calls for the same repository produce exactly one project", async () => {
  const db = await createTestDb();
  const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    executeCommand(db, principal, {
      action: "create_project",
      name: `Concurrent ${index}`,
      gitRemote: index % 2 === 0 ? "https://github.com/owner/repo" : "git@github.com:owner/repo.git",
      idempotencyKey: `concurrent-${index}`,
    })));

  assert.equal(attempts.filter((result) => result.status === "created").length, 1);
  assert.equal(attempts.filter((result) => result.status === "matched").length, 7);
  assert.equal(await projectCount(db), 1);
});

test("a remote mismatch is decisive even when the name is identical", async () => {
  const db = await createTestDb();
  await executeCommand(db, principal, { action: "create_project", name: "api", gitRemote: "https://github.com/acme/api", idempotencyKey: "a" });
  const fork = await executeCommand(db, principal, { action: "create_project", name: "api", gitRemote: "https://github.com/contoso/api", idempotencyKey: "b" });

  // Same repo name under a different owner is a different repository.
  assert.equal(fork.status, "created");
  assert.equal(await projectCount(db), 2);
});
