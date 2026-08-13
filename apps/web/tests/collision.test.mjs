/**
 * M14 / feature 13 — work overlap detection, v0.
 *
 * The one idea these tests are built around: this is a *mechanical* artifact-intersection
 * check, deliberately independent of whether the two titles read as related at all. A
 * proposal that shares zero words with a live claim's title still has to surface if it
 * touches the same concrete file, because that is exactly the case wording-based
 * relevance (M11's inProgress bucket) would miss.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./support/local-pg.mjs";
import { principal, setupProject } from "./support/fixtures.mjs";
import { executeCommand, registerSourceSession, updateSourceHeartbeat, organizationFor } from "@/lib/store.ts";
import { checkCollisions } from "@/lib/planning/collision.ts";
import { getPlanningContext } from "@/lib/planning/context.ts";

async function readyClaimedItem(db, projectId, title, sourceExternalId) {
  const created = await executeCommand(db, principal, { action: "create_item", projectId, title, idempotencyKey: `item-${sourceExternalId}` });
  const row = await db.prepare("SELECT version FROM work_items WHERE id = ?").bind(created.itemId).first();
  await executeCommand(db, principal, { action: "transition_item", projectId, itemId: created.itemId, expectedVersion: row.version, status: "ready", idempotencyKey: `ready-${sourceExternalId}` });
  const source = await registerSourceSession(db, principal, { projectId, provider: "claude", externalId: sourceExternalId });
  await updateSourceHeartbeat(db, principal, { sourceId: source.sourceId, currentTaskIds: [created.itemId] });
  return { itemId: created.itemId, sourceId: source.sourceId };
}

test("a live claim sharing a concrete artifact with the proposed scope is a collision", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const { itemId, sourceId } = await readyClaimedItem(db, projectId, "Migrate auth.service.ts to RS256", "col1");

  const matches = await checkCollisions(db, organizationId, projectId, { title: "Add refresh tokens to auth.service.ts" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].workItemId, itemId);
  assert.equal(matches[0].sourceId, sourceId);
  assert.ok(matches[0].sharedArtifacts.includes("service.ts"));
});

test("no artifacts extracted from the proposed scope yields no collisions, not an error", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  await readyClaimedItem(db, projectId, "Migrate auth.service.ts to RS256", "col2");

  const matches = await checkCollisions(db, organizationId, projectId, { title: "improve authentication" });
  assert.deepEqual(matches, []);
});

test("a matching artifact with nobody actively holding the item is not a collision", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  await executeCommand(db, principal, { action: "create_item", projectId, title: "Migrate auth.service.ts to RS256", idempotencyKey: "col3-item" });

  const matches = await checkCollisions(db, organizationId, projectId, { title: "Add refresh tokens to auth.service.ts" });
  assert.deepEqual(matches, []);
});

test("an expired lease does not produce a collision", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const { itemId } = await readyClaimedItem(db, projectId, "Migrate auth.service.ts to RS256", "col4");
  await db.prepare("UPDATE work_claims SET lease_expires_at = now() - interval '1 minute' WHERE work_item_id = ?").bind(itemId).run();

  const matches = await checkCollisions(db, organizationId, projectId, { title: "Add refresh tokens to auth.service.ts" });
  assert.deepEqual(matches, []);
});

test("excludeSourceId omits the caller's own live claim", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const { sourceId } = await readyClaimedItem(db, projectId, "Migrate auth.service.ts to RS256", "col5");

  const matches = await checkCollisions(db, organizationId, projectId, { title: "Add refresh tokens to auth.service.ts" }, { excludeSourceId: sourceId });
  assert.deepEqual(matches, []);
});

test("a collision in another project is invisible", async () => {
  const db = await createTestDb();
  const projectA = await setupProject(db);
  const projectB = (await executeCommand(db, principal, { action: "create_project", name: "Other", idempotencyKey: "col6-proj" })).projectId;
  const organizationId = await organizationFor(db, principal);
  await readyClaimedItem(db, projectB, "Migrate auth.service.ts to RS256", "col6");

  const matches = await checkCollisions(db, organizationId, projectA, { title: "Add refresh tokens to auth.service.ts" });
  assert.deepEqual(matches, []);
});

test("get_planning_context surfaces the collision with who holds it, and a guidance line", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  await readyClaimedItem(db, projectId, "Migrate auth.service.ts to RS256", "col7");

  const context = await getPlanningContext(db, organizationId, { projectId, objective: "Add refresh tokens to auth.service.ts" });
  assert.equal(context.collisions.length, 1);
  assert.equal(context.collisions[0].heldBy, "claude");
  assert.ok(context.collisions[0].sharedArtifacts.includes("service.ts"));
  assert.match(context.guidance.join("\n"), /service\.ts/);
  assert.match(context.guidance.join("\n"), /claude/);
});

test("get_planning_context excludes the calling session's own claim from collisions", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);
  const { sourceId } = await readyClaimedItem(db, projectId, "Migrate auth.service.ts to RS256", "col8");

  const context = await getPlanningContext(db, organizationId, { projectId, objective: "Add refresh tokens to auth.service.ts", sourceId });
  assert.deepEqual(context.collisions, []);
});

test("get_planning_context's collisions never appear for a project with no live claims at all", async () => {
  const db = await createTestDb();
  const projectId = await setupProject(db);
  const organizationId = await organizationFor(db, principal);

  const context = await getPlanningContext(db, organizationId, { projectId, objective: "Add refresh tokens to auth.service.ts" });
  assert.deepEqual(context.collisions, []);
  assert.deepEqual(context.guidance, []);
});
