import type { PgD1 } from "@/db/pg-d1";
import { connectionCredentials } from "@/lib/integrations/core";
import { getSlackPermalink, openSlackModal, postSlackEphemeral } from "@/lib/integrations/slack";
import { parseJson } from "@/lib/integrations/utils";
import { createWorkItemsDeduplicated, type Principal } from "@/lib/store";

/**
 * Slack -> Planbraid, the direction publish.ts never covers. Deliberately message-
 * triggered, not a history scan: a message shortcut delivers the clicked message's full
 * content straight in the interaction payload, so this never calls conversations.history
 * or conversations.replies and needs no scope beyond the shortcut/command features
 * themselves (see core.ts's OAuth scope comment). That was the whole reason the original
 * Slack integration shipped publish-only - this adds import without the scope creep that
 * ruled it out then.
 */

type Json = Record<string, unknown>;
type ModalMetadata = { connectionId: string; channel: string; userId: string; permalink: string };
type ProjectOption = { id: string; name: string };

export const MESSAGE_SHORTCUT_CALLBACK_ID = "create_planbraid_task";
export const TASK_MODAL_CALLBACK_ID = "planbraid_task_modal";

async function connectionForSlackTeam(db: PgD1, teamId: string) {
  const row = await db.prepare("SELECT id, organization_id, owner_user_id FROM integration_connections WHERE provider = 'slack' AND status <> 'disconnected' AND metadata::jsonb->>'teamId' = ? ORDER BY created_at LIMIT 1")
    .bind(teamId).first<{ id: string; organization_id: string; owner_user_id: string }>();
  return row ? { id: row.id, organizationId: row.organization_id, ownerUserId: row.owner_user_id } : null;
}

async function activeProjectsFor(db: PgD1, organizationId: string): Promise<ProjectOption[]> {
  const result = await db.prepare("SELECT id, name FROM projects WHERE organization_id = ? AND status <> 'archived' ORDER BY name LIMIT 100").bind(organizationId).all<ProjectOption>();
  return result.results;
}

async function defaultProjectForChannel(db: PgD1, organizationId: string, channelId: string) {
  const row = await db.prepare("SELECT project_id FROM integration_channel_bindings WHERE organization_id = ? AND provider = 'slack' AND scope_type = 'project' AND external_channel_id = ? AND status <> 'disconnected' LIMIT 1")
    .bind(organizationId, channelId).first<{ project_id: string }>();
  return row?.project_id ?? null;
}

function titleFrom(text: string) {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  return (firstLine || text.trim()).slice(0, 200);
}

function buildTaskModalView(input: { initialTitle: string; initialDescription: string; projects: ProjectOption[]; defaultProjectId: string | null; metadata: ModalMetadata }): Json {
  const projectOptions = input.projects.map((project) => ({ text: { type: "plain_text", text: project.name.slice(0, 75) }, value: project.id }));
  const initialOption = input.defaultProjectId ? projectOptions.find((option) => option.value === input.defaultProjectId) : undefined;
  return {
    type: "modal",
    callback_id: TASK_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(input.metadata).slice(0, 3000),
    title: { type: "plain_text", text: "New Planbraid task" },
    submit: { type: "plain_text", text: "Create" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "input", block_id: "project", label: { type: "plain_text", text: "Project" }, element: { type: "static_select", action_id: "project_id", placeholder: { type: "plain_text", text: "Choose a project" }, options: projectOptions, ...(initialOption ? { initial_option: initialOption } : {}) } },
      { type: "input", block_id: "title", label: { type: "plain_text", text: "Title" }, element: { type: "plain_text_input", action_id: "title", initial_value: input.initialTitle.slice(0, 200), max_length: 200 } },
      { type: "input", block_id: "description", optional: true, label: { type: "plain_text", text: "Description" }, element: { type: "plain_text_input", action_id: "description", multiline: true, initial_value: input.initialDescription.slice(0, 2900), max_length: 3000 } },
    ],
  };
}

async function openTaskModal(db: PgD1, connection: { id: string; organizationId: string }, triggerId: string, channelId: string, userId: string, permalink: string, initialTitle: string, initialDescription: string) {
  const [projects, defaultProjectId] = await Promise.all([
    activeProjectsFor(db, connection.organizationId),
    defaultProjectForChannel(db, connection.organizationId, channelId),
  ]);
  // static_select requires at least one option; nothing sensible to show until a project
  // exists. Best-effort ephemeral nudge rather than a broken empty modal.
  if (!projects.length) {
    await postSlackEphemeral(db, connection.id, channelId, userId, "Create a project in Planbraid first, then this shortcut can file a task into it.");
    return;
  }
  const metadata: ModalMetadata = { connectionId: connection.id, channel: channelId, userId, permalink };
  const view = buildTaskModalView({ initialTitle, initialDescription, projects, defaultProjectId, metadata });
  await openSlackModal(db, connection.id, triggerId, view);
}

export async function handleMessageShortcut(db: PgD1, payload: Json) {
  const teamId = String((payload.team as Json | undefined)?.id ?? "");
  const connection = await connectionForSlackTeam(db, teamId);
  if (!connection) return;
  const channelId = String((payload.channel as Json | undefined)?.id ?? "");
  const message = payload.message as Json | undefined;
  const messageTs = String(message?.ts ?? "");
  const rawText = String(message?.text ?? "");
  const userId = String((payload.user as Json | undefined)?.id ?? "");
  let permalink = "";
  try { permalink = await getSlackPermalink(db, connection.id, channelId, messageTs); } catch { /* best effort - see getSlackPermalink */ }
  await openTaskModal(db, connection, String(payload.trigger_id ?? ""), channelId, userId, permalink, titleFrom(rawText), rawText.trim());
}

export async function handleSlashCommand(db: PgD1, payload: Json) {
  const teamId = String(payload.team_id ?? "");
  const connection = await connectionForSlackTeam(db, teamId);
  if (!connection) return;
  const channelId = String(payload.channel_id ?? "");
  const userId = String(payload.user_id ?? "");
  const text = String(payload.text ?? "").trim();
  await openTaskModal(db, connection, String(payload.trigger_id ?? ""), channelId, userId, "", titleFrom(text), text);
}

export async function handleViewSubmission(db: PgD1, payload: Json): Promise<Json> {
  const view = payload.view as Json | undefined;
  if (String(view?.callback_id ?? "") !== TASK_MODAL_CALLBACK_ID) return {};
  const metadata = parseJson<ModalMetadata>(view?.private_metadata, { connectionId: "", channel: "", userId: "", permalink: "" });
  const values = ((view?.state as Json | undefined)?.values ?? {}) as Record<string, Record<string, Json>>;
  const projectId = String((values.project?.project_id?.selected_option as Json | undefined)?.value ?? "");
  const title = String(values.title?.title?.value ?? "").trim();
  const description = String(values.description?.description?.value ?? "").trim();
  const errors: Record<string, string> = {};
  if (!projectId) errors.project = "Choose a project";
  if (!title) errors.title = "Enter a title";
  if (Object.keys(errors).length) return { response_action: "errors", errors };

  let connection: Awaited<ReturnType<typeof connectionCredentials>>;
  try { connection = await connectionCredentials(db, metadata.connectionId); }
  catch { return {}; } // connection was disconnected mid-flow; nothing left to confirm into

  const principal: Principal = { userId: connection.ownerUserId, email: "slack-import@planbraid.local", displayName: "Slack", authentication: "oauth" };
  const fullDescription = [description, metadata.permalink ? `Original Slack message: ${metadata.permalink}` : ""].filter(Boolean).join("\n\n").slice(0, 8000);
  // view.id is stable across Slack's own transport retries of this same submission (and
  // unique per submit click), so it is the idempotency key - not Date.now(), which would
  // let a retried delivery create a second task.
  const outcome = await createWorkItemsDeduplicated(db, principal, {
    projectId, proposals: [{ title, description: fullDescription, status: "proposed" }],
    idempotencyKey: `slack-import:${String(view?.id ?? "")}`,
  }) as { results?: Array<{ itemKey?: string; status?: string }> };
  const created = outcome.results?.[0];
  const confirmation = created?.itemKey
    ? (created.status === "matched" ? `Matched an existing task: ${created.itemKey}` : `Created ${created.itemKey}: ${title}`)
    : `Filed "${title}" for review in Planbraid.`;
  try { await postSlackEphemeral(db, metadata.connectionId, metadata.channel, metadata.userId, confirmation); } catch { /* best effort */ }
  return {};
}
