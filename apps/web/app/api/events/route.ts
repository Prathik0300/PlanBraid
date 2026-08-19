import { env } from "@/lib/runtime-env";
import { principalFromRequest } from "@/lib/app-principal";
import { errorResponse, organizationFor } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const principal = await principalFromRequest(env, request);
    const organizationId = await organizationFor(env.DB, principal);
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId");
    const after = Number(url.searchParams.get("after") ?? 0);
    if (!projectId) return Response.json({ error: { code: "VALIDATION_FAILED", message: "projectId is required" } }, { status: 422 });
    const project = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND organization_id = ? AND status <> 'archived'").bind(projectId, organizationId).first();
    if (!project) return Response.json({ error: { code: "NOT_FOUND", message: "Project not found" } }, { status: 404 });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let cursor = after;
        let closed = false;
        const send = async () => {
          if (closed) return;
          const events = await env.DB.prepare("SELECT id, project_revision, event_type, work_item_id, source_id, summary, created_at FROM work_events WHERE project_id = ? AND project_revision > ? ORDER BY project_revision ASC LIMIT 100").bind(projectId, cursor).all<Row>();
          for (const event of events.results) {
            cursor = Number(event.project_revision);
            controller.enqueue(encoder.encode(`id: ${cursor}\nevent: project-event\ndata: ${JSON.stringify(event)}\n\n`));
          }
          controller.enqueue(encoder.encode(`event: heartbeat\ndata: {"cursor":${cursor}}\n\n`));
        };
        await send();
        const interval = setInterval(() => { void send(); }, 3000);
        setTimeout(() => { closed = true; clearInterval(interval); controller.close(); }, 25000);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
  } catch (error) {
    return errorResponse(error);
  }
}

type Row = Record<string, unknown>;
