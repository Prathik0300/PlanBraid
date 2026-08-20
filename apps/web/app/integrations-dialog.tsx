"use client";

/* Dialog backdrop is presentational; the dialog has a keyboard-accessible close button. */
/* eslint-disable jsx-a11y/no-static-element-interactions */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@/lib/contracts";
import type { ChannelBindingScope, ExternalCandidate, ExternalProject, ExternalResource, IntegrationBindingSummary, IntegrationChannelBindingSummary, IntegrationConnectionSummary, IntegrationProvider } from "@/lib/integrations/types";

type Props = { project: Project; close: () => void; onImported: () => Promise<void>; toast: (message: string) => void };
type ApiError = { error?: { message?: string } };
type SlackChannel = { id: string; name: string; isPrivate: boolean; isMember: boolean };
const LABEL: Record<IntegrationProvider, string> = { basecamp: "Basecamp", jira: "Jira Cloud", slack: "Slack" };
const EVENT_TYPES: Array<{ value: string; label: string }> = [
  { value: "work_item.blocked", label: "New blockers" },
  { value: "work_item.downstream_unblocked", label: "Ready work" },
  { value: "work_item.completion_verified", label: "Work completed" },
  { value: "work_item.completion_reported", label: "Submitted for review" },
];
const DEFAULT_EVENTS = new Set(["work_item.blocked", "work_item.downstream_unblocked", "work_item.completion_verified"]);

export function IntegrationsDialog({ project, close, onImported, toast }: Props) {
  const [connections, setConnections] = useState<IntegrationConnectionSummary[]>([]);
  const [bindings, setBindings] = useState<IntegrationBindingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<IntegrationProvider | null>(null);
  const [resources, setResources] = useState<ExternalResource[]>([]);
  const [resourceId, setResourceId] = useState("");
  const [projects, setProjects] = useState<ExternalProject[]>([]);
  const [externalProjectId, setExternalProjectId] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  const [reviewing, setReviewing] = useState<IntegrationBindingSummary | null>(null);
  const [candidates, setCandidates] = useState<ExternalCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [channelBindings, setChannelBindings] = useState<IntegrationChannelBindingSummary[]>([]);
  const [addingChannel, setAddingChannel] = useState(false);
  const [slackChannels, setSlackChannels] = useState<SlackChannel[]>([]);
  const [slackChannelId, setSlackChannelId] = useState("");
  const [slackScope, setSlackScope] = useState<ChannelBindingScope>("project");
  const [slackConfirmAll, setSlackConfirmAll] = useState(false);
  const [slackEvents, setSlackEvents] = useState<Set<string>>(new Set(DEFAULT_EVENTS));
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const load = useCallback(async () => {
    const data = await api<{ connections: IntegrationConnectionSummary[]; bindings: IntegrationBindingSummary[]; channelBindings: IntegrationChannelBindingSummary[] }>(`/api/integrations?projectId=${encodeURIComponent(project.id)}`);
    setConnections(data.connections);
    setBindings(data.bindings);
    setChannelBindings(data.channelBindings);
  }, [project.id]);

  useEffect(() => {
    let cancelled = false;
    void api<{ connections: IntegrationConnectionSummary[]; bindings: IntegrationBindingSummary[]; channelBindings: IntegrationChannelBindingSummary[] }>(`/api/integrations?projectId=${encodeURIComponent(project.id)}`)
      .then((data) => { if (!cancelled) { setConnections(data.connections); setBindings(data.bindings); setChannelBindings(data.channelBindings); } })
      .catch((error) => toastRef.current(messageOf(error)))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [project.id]);

  async function beginAddChannel() {
    const connection = connections.find((entry) => entry.provider === "slack");
    if (!connection?.id) return;
    setBusy("channels:slack");
    try {
      const data = await api<{ channels: SlackChannel[] }>(`/api/integrations/channels?provider=slack&connectionId=${encodeURIComponent(connection.id)}`);
      setSlackChannels(data.channels); setAddingChannel(true); setSlackChannelId(""); setSlackScope("project"); setSlackConfirmAll(false); setSlackEvents(new Set(DEFAULT_EVENTS));
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function saveChannelBinding() {
    const connection = connections.find((entry) => entry.provider === "slack");
    if (!connection?.id || !slackChannelId) return;
    if (slackScope === "all_projects" && !slackConfirmAll) { toast("Confirm that future projects will publish to this channel"); return; }
    const channel = slackChannels.find((entry) => entry.id === slackChannelId);
    setBusy("bind:slack");
    try {
      await api("/api/integrations/channel-bindings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "slack", connectionId: connection.id, scopeType: slackScope, projectId: project.id, channelId: slackChannelId, channelName: channel?.name ?? slackChannelId, eventTypes: [...slackEvents], confirmedAllProjects: slackConfirmAll }),
      });
      toast("Slack channel connected"); setAddingChannel(false); await load();
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function sendTest(binding: IntegrationChannelBindingSummary) {
    setBusy(`test:${binding.id}`);
    try { await api(`/api/integrations/channel-bindings/${binding.id}/test`, { method: "POST" }); toast(`Test message sent to #${binding.channelName || binding.channelId}`); }
    catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function disconnectChannel(binding: IntegrationChannelBindingSummary) {
    if (!window.confirm(`Stop sending updates to #${binding.channelName || binding.channelId}?`)) return;
    setBusy(`disconnect-channel:${binding.id}`);
    try { await api(`/api/integrations/channel-bindings?bindingId=${encodeURIComponent(binding.id)}`, { method: "DELETE" }); await load(); }
    catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function beginAdd(provider: IntegrationProvider) {
    if (provider === "slack") { await beginAddChannel(); return; }
    const connection = connections.find((entry) => entry.provider === provider);
    if (!connection?.id) return;
    setBusy(`resources:${provider}`);
    try {
      const data = await api<{ resources: ExternalResource[] }>(`/api/integrations/resources?provider=${provider}&connectionId=${encodeURIComponent(connection.id)}`);
      setAdding(provider); setResources(data.resources); setProjects([]); setResourceId(""); setExternalProjectId(""); setFilterQuery("");
      if (data.resources.length === 1) await chooseResource(provider, connection.id, data.resources[0].id);
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function chooseResource(provider: IntegrationProvider, connectionId: string, id: string) {
    setResourceId(id); setProjects([]); setExternalProjectId(""); setBusy(`projects:${provider}`);
    try {
      const data = await api<{ projects: ExternalProject[] }>(`/api/integrations/resources?provider=${provider}&connectionId=${encodeURIComponent(connectionId)}&accountId=${encodeURIComponent(id)}`);
      setProjects(data.projects);
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function saveBinding() {
    if (!adding || !resourceId || !externalProjectId) return;
    const connection = connections.find((entry) => entry.provider === adding);
    if (!connection?.id) return;
    setBusy(`bind:${adding}`);
    try {
      await api("/api/integrations/bindings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, provider: adding, connectionId: connection.id, externalAccountId: resourceId, externalProjectId, filterQuery }) });
      toast(`${LABEL[adding]} project connected`); setAdding(null); await load();
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function sync(binding: IntegrationBindingSummary) {
    setBusy(`sync:${binding.id}`);
    try {
      const result = await api<{ fetched: number; changed: number }>(`/api/integrations/bindings/${binding.id}/sync`, { method: "POST" });
      toast(`Found ${result.fetched} items; ${result.changed} changed`); await load(); await openReview(binding);
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function openReview(binding: IntegrationBindingSummary) {
    setBusy(`review:${binding.id}`);
    try {
      const data = await api<ExternalCandidate[]>(`/api/integrations/bindings/${binding.id}/candidates`);
      setReviewing(binding); setCandidates(data); setSelected(new Set(data.filter((item) => item.reviewStatus === "pending").map((item) => item.id)));
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function applySelected() {
    if (!reviewing || !selected.size) return;
    setBusy(`apply:${reviewing.id}`);
    try {
      const result = await api<{ created: number; matched: number }>(`/api/integrations/bindings/${reviewing.id}/candidates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "apply", externalItemIds: [...selected] }) });
      toast(`Imported ${result.created}; matched ${result.matched} existing items`); await onImported(); await openReview(reviewing); await load();
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function ignore(candidate: ExternalCandidate) {
    if (!reviewing) return;
    setBusy(`ignore:${candidate.id}`);
    try {
      await api(`/api/integrations/bindings/${reviewing.id}/candidates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ignore", externalItemId: candidate.id }) });
      setCandidates((current) => current.map((entry) => entry.id === candidate.id ? { ...entry, reviewStatus: "ignored" } : entry));
      setSelected((current) => { const next = new Set(current); next.delete(candidate.id); return next; });
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function disconnect(binding: IntegrationBindingSummary) {
    if (!window.confirm(`Disconnect ${binding.externalProjectName} from this Planbraid project? Imported work stays in Planbraid.`)) return;
    setBusy(`disconnect:${binding.id}`);
    try { await api(`/api/integrations/bindings?bindingId=${encodeURIComponent(binding.id)}`, { method: "DELETE" }); setReviewing(null); await load(); }
    catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function disconnectAccount(connection: IntegrationConnectionSummary) {
    if (!connection.id || !window.confirm(`Disconnect ${LABEL[connection.provider]} entirely? Every project binding for this account will stop syncing.`)) return;
    setBusy(`account:${connection.id}`);
    try { await api(`/api/integrations?connectionId=${encodeURIComponent(connection.id)}`, { method: "DELETE" }); setAdding(null); setAddingChannel(false); setReviewing(null); await load(); toast(`${LABEL[connection.provider]} account disconnected`); }
    catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  const pendingCandidates = useMemo(() => candidates.filter((item) => item.reviewStatus === "pending"), [candidates]);
  return <div className="dialog-backdrop integrations-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="integrations-dialog" role="dialog" aria-modal="true" aria-labelledby="integrations-title">
      <header><div><span className="eyebrow">WORK INTEGRATIONS</span><h2 id="integrations-title">Integrations for {project.name}</h2><p>Import external work into a review queue, and publish plan updates to Slack.</p></div><button className="icon-button" onClick={close} aria-label="Close">×</button></header>
      {loading ? <p className="integration-empty">Loading integrations…</p> : <div className="integration-body">
        <section><h3>Accounts</h3><div className="integration-provider-grid">{connections.map((connection) => <article className="integration-provider-card" key={connection.provider}>
          <span className={`integration-provider-mark ${connection.provider}`}>{connection.provider === "basecamp" ? "B" : connection.provider === "slack" ? "S" : "J"}</span><div><strong>{LABEL[connection.provider]}</strong><small>{connection.id ? `${connection.label} · ${connection.status.replaceAll("_", " ")}` : connection.configured ? "Ready to connect" : "OAuth configuration required"}</small></div>
          {connection.id ? <span className="integration-provider-actions"><button disabled={busy !== null} onClick={() => void beginAdd(connection.provider)}>{connection.provider === "slack" ? "Add channel" : "Add project"}</button><button className="integration-danger" disabled={busy !== null} onClick={() => void disconnectAccount(connection)}>Disconnect</button></span> : connection.configured ? <a href={`/api/integrations/${connection.provider}/connect?projectId=${encodeURIComponent(project.id)}`}>Connect</a> : <button disabled title="Set the provider OAuth environment variables on the server">Not configured</button>}
        </article>)}</div></section>
        {addingChannel && <section className="integration-add"><header><h3>Add a Slack channel</h3><button onClick={() => setAddingChannel(false)}>Cancel</button></header>
          <label>Channel<select value={slackChannelId} disabled={busy === "channels:slack"} onChange={(event) => setSlackChannelId(event.target.value)}><option value="">{busy === "channels:slack" ? "Loading…" : "Choose…"}</option>{slackChannels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}{channel.isPrivate ? " (private)" : ""}{!channel.isMember ? " - invite the bot first" : ""}</option>)}</select></label>
          <label>Scope<select value={slackScope} onChange={(event) => { setSlackScope(event.target.value as ChannelBindingScope); setSlackConfirmAll(false); }}><option value="project">This project only</option><option value="all_projects">All current and future projects</option></select></label>
          <label className="integration-add-events"><span className="label-row">Send updates for</span><span className="integration-event-toggles">{EVENT_TYPES.map((entry) => <label key={entry.value}><input type="checkbox" checked={slackEvents.has(entry.value)} onChange={() => setSlackEvents((current) => { const next = new Set(current); if (next.has(entry.value)) next.delete(entry.value); else next.add(entry.value); return next; })} /> {entry.label}</label>)}</span></label>
          {slackScope === "all_projects" && <label className="integration-confirm-all"><input type="checkbox" checked={slackConfirmAll} onChange={(event) => setSlackConfirmAll(event.target.checked)} /> I understand every current and future eligible project will publish to this channel</label>}
          <button className="integration-primary" disabled={!slackChannelId || (slackScope === "all_projects" && !slackConfirmAll) || busy !== null} onClick={() => void saveChannelBinding()}>Connect channel</button>
        </section>}
        <section><h3>Slack channels</h3>{channelBindings.length ? <div className="integration-bindings">{channelBindings.map((binding) => <article key={binding.id}>
          <span className="integration-provider-mark slack">S</span><div><strong>#{binding.channelName || binding.channelId}</strong><small>{binding.scopeType === "all_projects" ? "All projects" : binding.projectName ?? "This project"} · {binding.status.replaceAll("_", " ")}{binding.overlapping ? " · overlaps another binding" : ""}{binding.lastErrorCode ? ` · ${binding.lastErrorCode}` : ""}</small></div><span className="integration-count">{binding.eventTypes.length} event{binding.eventTypes.length === 1 ? "" : "s"}</span>
          <button disabled={busy !== null} onClick={() => void sendTest(binding)}>{busy === `test:${binding.id}` ? "Sending…" : "Send test"}</button><button className="integration-danger" disabled={busy !== null} onClick={() => void disconnectChannel(binding)}>Disconnect</button>
        </article>)}</div> : <p className="integration-empty compact">No Slack channels are connected yet.</p>}</section>
        {adding && <section className="integration-add"><header><h3>Add a {LABEL[adding]} project</h3><button onClick={() => setAdding(null)}>Cancel</button></header>
          <label>Account or site<select value={resourceId} onChange={(event) => { const connection = connections.find((entry) => entry.provider === adding); if (connection) void chooseResource(adding, connection.id, event.target.value); }}><option value="">Choose…</option>{resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label>
          <label>Project<select value={externalProjectId} disabled={!resourceId || busy === `projects:${adding}`} onChange={(event) => setExternalProjectId(event.target.value)}><option value="">{busy === `projects:${adding}` ? "Loading…" : "Choose…"}</option>{projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.key ? `${entry.key} · ` : ""}{entry.name}</option>)}</select></label>
          {adding === "jira" && <label>Optional JQL conditions<input value={filterQuery} onChange={(event) => setFilterQuery(event.target.value)} placeholder="e.g. labels = planbraid" maxLength={2000} /><small>Do not include ORDER BY; Planbraid always scopes this to the selected project.</small></label>}
          <button className="integration-primary" disabled={!externalProjectId || busy !== null} onClick={() => void saveBinding()}>Connect project</button>
        </section>}
        <section><h3>Connected projects</h3>{bindings.length ? <div className="integration-bindings">{bindings.map((binding) => <article key={binding.id}>
          <span className={`integration-provider-mark ${binding.provider}`}>{binding.provider === "basecamp" ? "B" : "J"}</span><div><strong>{binding.externalProjectKey ? `${binding.externalProjectKey} · ` : ""}{binding.externalProjectName}</strong><small>{LABEL[binding.provider]} · {binding.status.replaceAll("_", " ")}{binding.lastSyncAt ? ` · last synced ${new Date(binding.lastSyncAt).toLocaleString()}` : " · not synced yet"}{binding.lastErrorCode ? ` · ${binding.lastErrorCode}` : ""}</small></div><span className="integration-count">{binding.pendingCount} pending</span>
          <button disabled={busy !== null} onClick={() => void sync(binding)}>{busy === `sync:${binding.id}` ? "Syncing…" : "Sync"}</button><button disabled={busy !== null} onClick={() => void openReview(binding)}>Review</button><button className="integration-danger" disabled={busy !== null} onClick={() => void disconnect(binding)}>Disconnect</button>
        </article>)}</div> : <p className="integration-empty compact">No external projects are connected yet.</p>}</section>
        {reviewing && <section className="integration-review"><header><div><h3>Review {reviewing.externalProjectName}</h3><p>{pendingCandidates.length} items are awaiting a decision. Linked updates never overwrite Planbraid work.</p></div><button onClick={() => setReviewing(null)}>Close review</button></header>
          <div className="integration-review-toolbar"><label><input type="checkbox" checked={pendingCandidates.length > 0 && pendingCandidates.every((item) => selected.has(item.id))} onChange={(event) => setSelected(event.target.checked ? new Set(pendingCandidates.map((item) => item.id)) : new Set())} /> Select pending</label><button className="integration-primary" disabled={!selected.size || busy !== null} onClick={() => void applySelected()}>{busy === `apply:${reviewing.id}` ? "Applying…" : `Apply selected (${selected.size})`}</button></div>
          <div className="integration-candidates">{candidates.length ? candidates.map((candidate) => <article key={candidate.id} className={candidate.reviewStatus !== "pending" ? "decided" : ""}>
            <input type="checkbox" disabled={candidate.reviewStatus !== "pending"} checked={selected.has(candidate.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(candidate.id)) next.delete(candidate.id); else next.add(candidate.id); return next; })} aria-label={`Select ${candidate.title}`} />
            <div><strong>{candidate.externalKey ? `${candidate.externalKey} · ` : ""}{candidate.title}</strong><small>{candidate.itemType} · {candidate.externalStatus || candidate.normalizedStatus} · {candidate.priority}{candidate.assignee ? ` · ${candidate.assignee}` : ""}</small>{candidate.planningHints.length > 0 && <p>{candidate.planningHints.join(" · ")}</p>}</div><a href={candidate.canonicalUrl} target="_blank" rel="noreferrer">Open</a>{candidate.reviewStatus === "pending" ? <button disabled={busy !== null} onClick={() => void ignore(candidate)}>Ignore</button> : <span className="integration-decision">{candidate.workItemKey ?? candidate.reviewStatus}</span>}
          </article>) : <p className="integration-empty compact">Sync this project to discover work.</p>}</div>
        </section>}
      </div>}
    </section>
  </div>;
}

async function api<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json() as { data?: T } & ApiError;
  if (!response.ok) throw new Error(body.error?.message ?? "Integration request failed");
  return body.data as T;
}
function messageOf(error: unknown) { return error instanceof Error ? error.message : "Integration request failed"; }
