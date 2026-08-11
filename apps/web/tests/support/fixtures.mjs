/** Shared setup helpers for store-layer tests running against the local-pg harness. */
import { executeCommand } from "@/lib/store.ts";

export const principal = { userId: "u_graph", email: "graph@planbraid.local", displayName: "Graph Tester" };

export async function setupProject(db) {
  const project = await executeCommand(db, principal, { action: "create_project", name: "Graph Project", idempotencyKey: `proj-${crypto.randomUUID()}` });
  return project.projectId;
}

export async function createItem(db, projectId, title, key = crypto.randomUUID()) {
  const item = await executeCommand(db, principal, { action: "create_item", projectId, title, idempotencyKey: `item-${key}` });
  return item.itemId;
}
