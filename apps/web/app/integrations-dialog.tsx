"use client";

/* Dialog backdrop is presentational; the dialog has a keyboard-accessible close button. */
/* eslint-disable jsx-a11y/no-static-element-interactions */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "@/app/confirm-dialog";
import { ProviderMark, SlackMark } from "@/app/integration-provider-mark";
import type { Project } from "@/lib/contracts";
import type { ExternalCandidate, ExternalProject, ExternalResource, IntegrationBindingSummary, IntegrationChannelBindingSummary, IntegrationConnectionSummary, IntegrationProvider } from "@/lib/integrations/types";
import { fetchData, queryKeys } from "@/lib/query-cache";

type DialogProps = { project: Project; projects: Project[]; close: () => void; onImported: () => Promise<void>; toast: (message: string) => void };
type PanelProps = { projectId: string | null; projects: Project[]; onImported: () => Promise<void>; toast: (message: string) => void };
type SlackChannel = { id: string; name: string; isPrivate: boolean; isMember: boolean };
const LABEL: Record<IntegrationProvider, string> = { basecamp: "Basecamp", jira: "Jira Cloud", slack: "Slack" };
const EVENT_TYPES: Array<{ value: string; label: string }> = [
  { value: "work_item.blocked", label: "New blockers" },
  { value: "work_item.downstream_unblocked", label: "Ready work" },
  { value: "work_item.completion_verified", label: "Work completed" },
  { value: "work_item.completion_reported", label: "Submitted for review" },
];
const DEFAULT_EVENTS = new Set(["work_item.blocked", "work_item.downstream_unblocked", "work_item.completion_verified"]);
/** Sentinel for the Planbraid-project select's "All current and future projects" option -
 * one dropdown answering "which project(s)" instead of a separate scope selector that
 * shows a different second field depending on its own value, which is what made the
 * previous version of this form confusing (nothing on screen explained why the button
 * stayed disabled after picking "This project only" and no project). */
const ALL_PROJECTS = "__all_projects__";

/** Same shimmering-placeholder primitive as planbraid-app.tsx's Skeleton - duplicated
 * rather than imported since it's three lines and importing across that direction would
 * create planbraid-app.tsx <-> this file's existing one-way import cycle. */
function Skeleton({ width, height }: { width?: string | number; height?: string | number }) {
  return <span className="skeleton" style={{ width, height }} aria-hidden="true" />;
}

/** The per-project entry point (project ⋯ menu → "Manage work integrations"). Thin chrome
 * around IntegrationsPanel, which also powers the account-level Integrations tab in
 * ProfileDialog - the two differ only in projectId scope and surrounding dialog shell. */
export function IntegrationsDialog({ project, projects, close, onImported, toast }: DialogProps) {
  return <div className="dialog-backdrop integrations-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="integrations-dialog" role="dialog" aria-modal="true" aria-labelledby="integrations-title">
      <header><div><span className="eyebrow">WORK INTEGRATIONS</span><h2 id="integrations-title">Integrations for {project.name}</h2><p>Basecamp and Jira are read-only sources: review their work and import it into Planbraid. Only connected Slack channels receive Planbraid updates.</p></div><button className="icon-button" onClick={close} aria-label="Close">×</button></header>
      <IntegrationsPanel projectId={project.id} projects={projects} onImported={onImported} toast={toast} />
    </section>
  </div>;
}

/** projectId null means the account-level view: connections are account-wide already, and
 * this lists every binding across the org instead of one project's. Creating a new binding
 * still needs a target Planbraid project, so the add-channel/add-project panels carry their
 * own project picker (defaulted to projectId when one is in scope). */
export function IntegrationsPanel({ projectId, projects, onImported, toast }: PanelProps) {
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [connections, setConnections] = useState<IntegrationConnectionSummary[]>([]);
  const [bindings, setBindings] = useState<IntegrationBindingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<IntegrationProvider | null>(null);
  const [resources, setResources] = useState<ExternalResource[]>([]);
  const [resourceId, setResourceId] = useState("");
  const [externalProjects, setExternalProjects] = useState<ExternalProject[]>([]);
  const [externalProjectId, setExternalProjectId] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  const [reviewing, setReviewing] = useState<IntegrationBindingSummary | null>(null);
  const [reviewReveal, setReviewReveal] = useState(0);
  const [candidates, setCandidates] = useState<ExternalCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [channelBindings, setChannelBindings] = useState<IntegrationChannelBindingSummary[]>([]);
  const [addingChannel, setAddingChannel] = useState(false);
  const [slackChannels, setSlackChannels] = useState<SlackChannel[]>([]);
  const [slackChannelId, setSlackChannelId] = useState("");
  const [slackConfirmAll, setSlackConfirmAll] = useState(false);
  const [slackEvents, setSlackEvents] = useState<Set<string>>(new Set(DEFAULT_EVENTS));
  const [bindProjectId, setBindProjectId] = useState(projectId ?? "");
  const toastRef = useRef(toast);
  const reviewRef = useRef<HTMLElement | null>(null);
  useEffect(() => { toastRef.current = toast; }, [toast]);
  useEffect(() => {
    if (!reviewReveal) return;
    const frame = requestAnimationFrame(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [reviewReveal]);

  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const integrationsScope = projectId ?? "all";

  const load = useCallback(async () => {
    return queryClient.fetchQuery({
      queryKey: queryKeys.integrations(integrationsScope),
      queryFn: () => fetchData<{ connections: IntegrationConnectionSummary[]; bindings: IntegrationBindingSummary[]; channelBindings: IntegrationChannelBindingSummary[] }>(`/api/integrations${query}`),
      staleTime: 30_000,
    });
  }, [integrationsScope, query, queryClient]);

  const refreshIntegrations = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.integrations(integrationsScope) });
    const data = await load();
    setConnections(data.connections);
    setBindings(data.bindings);
    setChannelBindings(data.channelBindings);
  }, [integrationsScope, load, queryClient]);

  useEffect(() => {
    let cancelled = false;
    void load()
      .then((data) => { if (!cancelled) { setConnections(data.connections); setBindings(data.bindings); setChannelBindings(data.channelBindings); } })
      .catch((error) => toastRef.current(messageOf(error)))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  async function beginAddChannel() {
    const connection = connections.find((entry) => entry.provider === "slack");
    if (!connection?.id) return;
    setBusy("channels:slack");
    try {
      const data = await queryClient.fetchQuery({
        queryKey: queryKeys.integrationChannels("slack", connection.id),
        queryFn: () => fetchData<{ channels: SlackChannel[] }>(`/api/integrations/channels?provider=slack&connectionId=${encodeURIComponent(connection.id)}`),
        staleTime: 5 * 60_000,
      });
      setSlackChannels(data.channels); setAddingChannel(true); setSlackChannelId(""); setSlackConfirmAll(false); setSlackEvents(new Set(DEFAULT_EVENTS)); setBindProjectId(projectId ?? "");
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function saveChannelBinding() {
    const connection = connections.find((entry) => entry.provider === "slack");
    if (!connection?.id || !slackChannelId) return;
    const allProjects = bindProjectId === ALL_PROJECTS;
    if (!allProjects && !bindProjectId) { toast("Choose which project this channel is for"); return; }
    if (allProjects && !slackConfirmAll) { toast("Confirm that future projects will publish to this channel"); return; }
    const channel = slackChannels.find((entry) => entry.id === slackChannelId);
    setBusy("bind:slack");
    try {
      await api("/api/integrations/channel-bindings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "slack", connectionId: connection.id, scopeType: allProjects ? "all_projects" : "project", projectId: allProjects ? null : bindProjectId, channelId: slackChannelId, channelName: channel?.name ?? slackChannelId, eventTypes: [...slackEvents], confirmedAllProjects: slackConfirmAll }),
      });
      toast("Slack channel connected"); setAddingChannel(false); await refreshIntegrations();
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function sendTest(binding: IntegrationChannelBindingSummary) {
    setBusy(`test:${binding.id}`);
    try {
      const result = await api<{ intendedChannelId: string; confirmedChannelId: string }>(`/api/integrations/channel-bindings/${binding.id}/test`, { method: "POST" });
      // Slack's own chat.postMessage response echoes back the channel it actually posted
      // to - comparing that against the id this binding stores is the one check that
      // can't be fooled by a stale cached channel name, on either side of that question.
      toast(result.confirmedChannelId === result.intendedChannelId
        ? `Slack confirms it posted to ${result.confirmedChannelId} - the id this binding stores. If that lands somewhere unexpected in your Slack client, the channel itself was likely renamed there.`
        : `Mismatch: Planbraid asked for ${result.intendedChannelId} but Slack confirms it posted to ${result.confirmedChannelId}. This is a real bug - please report it.`);
    }
    catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function disconnectChannel(binding: IntegrationChannelBindingSummary) {
    if (!await confirm({ title: "Disconnect channel", message: `Stop sending updates to #${binding.channelName || binding.channelId}?`, confirmLabel: "Disconnect", danger: true })) return;
    setBusy(`disconnect-channel:${binding.id}`);
    try { await api(`/api/integrations/channel-bindings?bindingId=${encodeURIComponent(binding.id)}`, { method: "DELETE" }); await refreshIntegrations(); }
    catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function beginAdd(provider: IntegrationProvider) {
    if (provider === "slack") { await beginAddChannel(); return; }
    const connection = connections.find((entry) => entry.provider === provider);
    if (!connection?.id) return;
    setBusy(`resources:${provider}`);
    try {
      const data = await queryClient.fetchQuery({
        queryKey: queryKeys.integrationResources(provider, connection.id),
        queryFn: () => fetchData<{ resources: ExternalResource[] }>(`/api/integrations/resources?provider=${provider}&connectionId=${encodeURIComponent(connection.id)}`),
        staleTime: 5 * 60_000,
      });
      setAdding(provider); setResources(data.resources); setExternalProjects([]); setResourceId(""); setExternalProjectId(""); setFilterQuery(""); setBindProjectId(projectId ?? "");
      if (data.resources.length === 1) await chooseResource(provider, connection.id, data.resources[0].id);
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function chooseResource(provider: IntegrationProvider, connectionId: string, id: string) {
    setResourceId(id); setExternalProjects([]); setExternalProjectId(""); setBusy(`projects:${provider}`);
    try {
      const data = await queryClient.fetchQuery({
        queryKey: queryKeys.integrationProjects(provider, connectionId, id),
        queryFn: () => fetchData<{ projects: ExternalProject[] }>(`/api/integrations/resources?provider=${provider}&connectionId=${encodeURIComponent(connectionId)}&accountId=${encodeURIComponent(id)}`),
        staleTime: 5 * 60_000,
      });
      setExternalProjects(data.projects);
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function saveBinding() {
    if (!adding || !resourceId || !externalProjectId || (adding !== "basecamp" && !bindProjectId)) return;
    const connection = connections.find((entry) => entry.provider === adding);
    if (!connection?.id) return;
    setBusy(`bind:${adding}`);
    try {
      const result = await api<{ projectId: string; projectCreated: boolean }>("/api/integrations/bindings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: bindProjectId || null, provider: adding, connectionId: connection.id, externalAccountId: resourceId, externalProjectId, filterQuery, idempotencyKey: `integration-project-${crypto.randomUUID()}` }) });
      await onImported();
      toast(result.projectCreated ? `${LABEL[adding]} project connected and Planbraid project created` : `${LABEL[adding]} project connected`); setAdding(null); await refreshIntegrations();
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function sync(binding: IntegrationBindingSummary) {
    setBusy(`sync:${binding.id}`);
    try {
      const result = await api<{ fetched: number; changed: number }>(`/api/integrations/bindings/${binding.id}/sync`, { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: queryKeys.integrationCandidates(binding.id) });
      toast(`Fetched ${result.fetched} items; ${result.changed} changed. Nothing is added to Planbraid until you import selected items.`); await refreshIntegrations(); await openReview(binding);
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function openReview(binding: IntegrationBindingSummary) {
    setBusy(`review:${binding.id}`);
    try {
      const data = await queryClient.fetchQuery({
        queryKey: queryKeys.integrationCandidates(binding.id),
        queryFn: () => fetchData<ExternalCandidate[]>(`/api/integrations/bindings/${binding.id}/candidates`),
        staleTime: 30_000,
      });
      setReviewing(binding); setCandidates(data); setSelected(new Set(data.filter((item) => item.reviewStatus === "pending").map((item) => item.id))); setReviewReveal((current) => current + 1);
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function applySelected() {
    if (!reviewing || !selected.size) return;
    setBusy(`apply:${reviewing.id}`);
    try {
      const result = await api<{ created: number; matched: number }>(`/api/integrations/bindings/${reviewing.id}/candidates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "apply", externalItemIds: [...selected] }) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.integrationCandidates(reviewing.id) });
      toast(`Added ${result.created} Planbraid proposals; linked ${result.matched} to existing work`); await onImported(); await openReview(reviewing); await refreshIntegrations();
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function ignore(candidate: ExternalCandidate) {
    if (!reviewing) return;
    setBusy(`ignore:${candidate.id}`);
    try {
      await api(`/api/integrations/bindings/${reviewing.id}/candidates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ignore", externalItemId: candidate.id }) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.integrationCandidates(reviewing.id), refetchType: "none" });
      setCandidates((current) => current.map((entry) => entry.id === candidate.id ? { ...entry, reviewStatus: "ignored" } : entry));
      setSelected((current) => { const next = new Set(current); next.delete(candidate.id); return next; });
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function disconnect(binding: IntegrationBindingSummary) {
    if (!await confirm({ title: "Disconnect project", message: `Disconnect ${binding.externalProjectName} from Planbraid? Imported work stays in Planbraid.`, confirmLabel: "Disconnect", danger: true })) return;
    setBusy(`disconnect:${binding.id}`);
    try { await api(`/api/integrations/bindings?bindingId=${encodeURIComponent(binding.id)}`, { method: "DELETE" }); setReviewing(null); queryClient.removeQueries({ queryKey: queryKeys.integrationCandidates(binding.id) }); await onImported(); await refreshIntegrations(); }
    catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function disconnectAccount(connection: IntegrationConnectionSummary) {
    if (!connection.id || !await confirm({ title: "Disconnect account", message: `Disconnect ${LABEL[connection.provider]} entirely? Every project binding for this account will stop syncing.`, confirmLabel: "Disconnect", danger: true })) return;
    setBusy(`account:${connection.id}`);
    try { await api(`/api/integrations?connectionId=${encodeURIComponent(connection.id)}`, { method: "DELETE" }); setAdding(null); setAddingChannel(false); setReviewing(null); queryClient.removeQueries({ queryKey: ["integration", connection.provider, connection.id] }); await onImported(); await refreshIntegrations(); toast(`${LABEL[connection.provider]} account disconnected`); }
    catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  const pendingCandidates = useMemo(() => candidates.filter((item) => item.reviewStatus === "pending"), [candidates]);
  const projectName = useCallback((id: string) => projects.find((entry) => entry.id === id)?.name ?? "Unknown project", [projects]);
  const selectedExternalProject = externalProjects.find((entry) => entry.id === externalProjectId) ?? null;

  // Caught here, before the request round-trip, rather than only surfaced after the fact
  // via a binding's own "overlapping" flag - the exact "testing" channel bound twice this
  // session is what this is for.
  const duplicateChannelBinding = useMemo(() => {
    if (!slackChannelId || !bindProjectId) return null;
    const allProjects = bindProjectId === ALL_PROJECTS;
    return channelBindings.find((binding) => binding.status !== "disconnected" && binding.channelId === slackChannelId
      && (allProjects ? binding.scopeType === "all_projects" : binding.scopeType === "project" && binding.projectId === bindProjectId)) ?? null;
  }, [channelBindings, slackChannelId, bindProjectId]);
  const duplicateProjectBinding = useMemo(() => {
    if (!adding || !bindProjectId || !externalProjectId) return null;
    return bindings.find((binding) => binding.status !== "disconnected" && binding.provider === adding && binding.projectId === bindProjectId && binding.externalProjectId === externalProjectId) ?? null;
  }, [bindings, adding, bindProjectId, externalProjectId]);

  if (loading) return <div className="integration-body">
    <section><h3>Accounts</h3><div className="integration-provider-grid">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} height={56} />)}</div></section>
    <section><h3>Slack channels</h3><div className="integration-bindings"><Skeleton height={52} /></div></section>
  </div>;
  return <>{confirmDialog}<div className="integration-body">
    <section><h3>Accounts</h3><div className="integration-provider-grid">{connections.map((connection) => { const rowBusy = busy === "channels:slack" || busy === `resources:${connection.provider}` || busy === `account:${connection.id}`; return <article className="integration-provider-card" key={connection.provider}>
      <div className="integration-provider-top"><span className={`integration-provider-mark ${connection.provider}`}><ProviderMark provider={connection.provider} /></span><div><strong>{LABEL[connection.provider]}</strong><small>{connection.id ? `${connection.label} · ${connection.status.replaceAll("_", " ")}` : connection.configured ? "Ready to connect" : "OAuth configuration required"}</small></div></div>
      <div className="integration-provider-actions">{connection.id ? <><button disabled={rowBusy} onClick={() => void beginAdd(connection.provider)}>{connection.provider === "slack" ? "Add channel" : "Add project"}</button><button className="integration-danger" disabled={rowBusy} onClick={() => void disconnectAccount(connection)}>Disconnect</button></> : connection.configured ? <a href={`/api/integrations/${connection.provider}/connect${query}`}>Connect</a> : <button disabled title="Set the provider OAuth environment variables on the server">Not configured</button>}</div>
    </article>; })}</div></section>
    {addingChannel && <section className="integration-add"><header><h3>Add a Slack channel</h3><button onClick={() => setAddingChannel(false)}>Cancel</button></header>
      <label>Channel<select value={slackChannelId} disabled={busy === "channels:slack"} onChange={(event) => setSlackChannelId(event.target.value)}><option value="">{busy === "channels:slack" ? "Loading…" : "Choose…"}</option>{slackChannels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}{channel.isPrivate ? " (private)" : ""}{!channel.isMember ? " - invite the bot first" : ""}</option>)}</select></label>
      <label>Planbraid project<select value={bindProjectId} onChange={(event) => { setBindProjectId(event.target.value); setSlackConfirmAll(false); }}><option value="">Choose…</option>{projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}<option value={ALL_PROJECTS}>All current and future projects</option></select></label>
      {bindProjectId === ALL_PROJECTS && <label className="integration-confirm-all"><input type="checkbox" checked={slackConfirmAll} onChange={(event) => setSlackConfirmAll(event.target.checked)} /> I understand every current and future eligible project will publish to this channel</label>}
      <div className="integration-add-events"><span className="label-row">Send updates for</span><div className="integration-event-toggles">{EVENT_TYPES.map((entry) => <label key={entry.value}><input type="checkbox" checked={slackEvents.has(entry.value)} onChange={() => setSlackEvents((current) => { const next = new Set(current); if (next.has(entry.value)) next.delete(entry.value); else next.add(entry.value); return next; })} /> {entry.label}</label>)}</div></div>
      {duplicateChannelBinding
        ? <small className="integration-add-warning">Already connected: #{duplicateChannelBinding.channelName || duplicateChannelBinding.channelId} already publishes {duplicateChannelBinding.scopeType === "all_projects" ? "to all projects" : `to ${projectName(bindProjectId)}`} with these permissions.</small>
        : !slackChannelId ? <small className="integration-add-hint">Choose a channel to continue.</small> : !bindProjectId ? <small className="integration-add-hint">Choose a Planbraid project to continue.</small> : bindProjectId === ALL_PROJECTS && !slackConfirmAll ? <small className="integration-add-hint">Check the confirmation above to continue.</small> : null}
      <button className="integration-primary" disabled={!slackChannelId || !bindProjectId || (bindProjectId === ALL_PROJECTS && !slackConfirmAll) || Boolean(duplicateChannelBinding) || busy !== null} onClick={() => void saveChannelBinding()}>Connect channel</button>
    </section>}
    <section><h3>Slack channels</h3>{channelBindings.length ? <div className="integration-bindings">{channelBindings.map((binding) => { const rowBusy = busy === `test:${binding.id}` || busy === `disconnect-channel:${binding.id}`; return <article key={binding.id}>
      <span className="integration-provider-mark slack"><SlackMark /></span><div><strong>#{binding.channelName || binding.channelId}</strong><small>{binding.channelId} · {binding.scopeType === "all_projects" ? "All projects" : binding.projectName ?? "Unknown project"} · {binding.status.replaceAll("_", " ")}{binding.overlapping ? " · overlaps another binding" : ""}{binding.lastErrorCode ? ` · ${binding.lastErrorCode}` : ""}</small></div><span className="integration-count">{binding.eventTypes.length} event{binding.eventTypes.length === 1 ? "" : "s"}</span>
      <button disabled={rowBusy} title="Post a confirmation message to this channel now, to check the bot can actually deliver here" onClick={() => void sendTest(binding)}>{busy === `test:${binding.id}` ? "Sending…" : "Send test"}</button><button className="integration-danger" disabled={rowBusy} onClick={() => void disconnectChannel(binding)}>Disconnect</button>
    </article>; })}</div> : <p className="integration-empty compact">No Slack channels are connected yet.</p>}</section>
    {adding && <section className="integration-add"><header><h3>Add a {LABEL[adding]} project</h3><button onClick={() => setAdding(null)}>Cancel</button></header>
      <label>Planbraid project<select value={bindProjectId} onChange={(event) => setBindProjectId(event.target.value)}><option value="">{adding === "basecamp" ? "Create automatically" : "Choose…"}</option>{projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>{adding === "basecamp" && <small>If no Planbraid project is selected, Planbraid will create one with the same name as the Basecamp project{selectedExternalProject ? ` (“${selectedExternalProject.name}”)` : ""} and connect future syncs to it. An existing same-named Planbraid project will be reused.</small>}</label>
      <label>Account or site<select value={resourceId} onChange={(event) => { const connection = connections.find((entry) => entry.provider === adding); if (connection) void chooseResource(adding, connection.id, event.target.value); }}><option value="">Choose…</option>{resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label>
      <label>{LABEL[adding]} project<select value={externalProjectId} disabled={!resourceId || busy === `projects:${adding}`} onChange={(event) => setExternalProjectId(event.target.value)}><option value="">{busy === `projects:${adding}` ? "Loading…" : "Choose…"}</option>{externalProjects.map((entry) => <option key={entry.id} value={entry.id}>{entry.key ? `${entry.key} · ` : ""}{entry.name}</option>)}</select></label>
      {adding === "jira" && <label>Optional JQL conditions<input value={filterQuery} onChange={(event) => setFilterQuery(event.target.value)} placeholder="e.g. labels = planbraid" maxLength={2000} /><small>Do not include ORDER BY; Planbraid always scopes this to the selected project.</small></label>}
      {duplicateProjectBinding && <small className="integration-add-warning">Already connected: {duplicateProjectBinding.externalProjectKey ? `${duplicateProjectBinding.externalProjectKey} · ` : ""}{duplicateProjectBinding.externalProjectName} is already linked to {projectName(bindProjectId)}.</small>}
      <button className="integration-primary" disabled={!externalProjectId || (adding !== "basecamp" && !bindProjectId) || Boolean(duplicateProjectBinding) || busy !== null} onClick={() => void saveBinding()}>{adding === "basecamp" && !bindProjectId ? "Create and connect project" : "Connect project"}</button>
    </section>}
    <section><h3>Connected projects</h3><p className="integration-section-help">Fetch latest reads external items into a private review queue. Review items lets you choose what becomes Planbraid work. Neither action changes Basecamp or Jira.</p>{bindings.length ? <div className="integration-bindings">{bindings.map((binding) => { const rowBusy = busy === `sync:${binding.id}` || busy === `review:${binding.id}` || busy === `disconnect:${binding.id}`; return <article key={binding.id}>
      <span className={`integration-provider-mark ${binding.provider}`}><ProviderMark provider={binding.provider} /></span><div><strong>{binding.externalProjectKey ? `${binding.externalProjectKey} · ` : ""}{binding.externalProjectName}</strong><small>{LABEL[binding.provider]} · {projectName(binding.projectId)} · {binding.status.replaceAll("_", " ")}{binding.lastSyncAt ? ` · last synced ${new Date(binding.lastSyncAt).toLocaleString()}` : " · not synced yet"}{binding.lastErrorCode ? ` · ${binding.lastErrorCode}` : ""}</small></div><span className="integration-count">{binding.pendingCount} pending</span>
      <button disabled={rowBusy} title={`Read the latest work from ${LABEL[binding.provider]} into the review queue`} onClick={() => void sync(binding)}>{busy === `sync:${binding.id}` ? "Fetching…" : "Fetch latest"}</button><button disabled={rowBusy} title="Open the staged items without importing them" onClick={() => void openReview(binding)}>Review items</button><button className="integration-danger" disabled={rowBusy} onClick={() => void disconnect(binding)}>Disconnect</button>
    </article>; })}</div> : <p className="integration-empty compact">No external projects are connected yet.</p>}</section>
    {reviewing && <section ref={reviewRef} className="integration-review"><header><div><h3>Review before importing · {reviewing.externalProjectName}</h3><p>{pendingCandidates.length} items are staged only. Select what you want, then import it into Planbraid. Imported items appear as proposals in the project; nothing here writes work back to {LABEL[reviewing.provider]}.</p></div><button onClick={() => setReviewing(null)}>Close review</button></header>
      <div className="integration-review-toolbar"><label><input type="checkbox" checked={pendingCandidates.length > 0 && pendingCandidates.every((item) => selected.has(item.id))} onChange={(event) => setSelected(event.target.checked ? new Set(pendingCandidates.map((item) => item.id)) : new Set())} /> Select pending</label><button className="integration-primary" disabled={!selected.size || busy !== null} onClick={() => void applySelected()}>{busy === `apply:${reviewing.id}` ? "Importing…" : `Import selected (${selected.size})`}</button></div>
      <div className="integration-candidates">{candidates.length ? candidates.map((candidate) => <article key={candidate.id} className={candidate.reviewStatus !== "pending" ? "decided" : ""}>
        <input type="checkbox" disabled={candidate.reviewStatus !== "pending"} checked={selected.has(candidate.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(candidate.id)) next.delete(candidate.id); else next.add(candidate.id); return next; })} aria-label={`Select ${candidate.title}`} />
        <div><strong>{candidate.externalKey ? `${candidate.externalKey} · ` : ""}{candidate.title}</strong><small>{candidate.itemType} · {candidate.externalStatus || candidate.normalizedStatus} · {candidate.priority}{candidate.assignee ? ` · ${candidate.assignee}` : ""}</small>{candidate.planningHints.length > 0 && <p>{candidate.planningHints.join(" · ")}</p>}</div><a href={candidate.canonicalUrl} target="_blank" rel="noreferrer">Open</a>{candidate.reviewStatus === "pending" ? <button disabled={busy === `ignore:${candidate.id}`} onClick={() => void ignore(candidate)}>Ignore</button> : <span className="integration-decision">{candidate.workItemKey ?? candidate.reviewStatus}</span>}
      </article>) : <p className="integration-empty compact">Sync this project to discover work.</p>}</div>
    </section>}
  </div></>;
}

async function api<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  return fetchData<T>(url, init);
}
function messageOf(error: unknown) { return error instanceof Error ? error.message : "Integration request failed"; }
