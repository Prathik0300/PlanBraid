"use client";

/* Dialog backdrop is presentational; the dialog has a keyboard-accessible close button. */
/* eslint-disable jsx-a11y/no-static-element-interactions */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "@/app/confirm-dialog";
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

/** Solid brand-color badges (see .integration-provider-mark) rather than text on a
 * transparent background, so these render identically in light and dark theme without
 * any theme-conditional CSS - fill="currentColor" just picks up the badge's own fixed
 * white icon color either way.
 *
 * Basecamp, Jira, and Slack all use their real official marks - path data from
 * simple-icons (MIT-licensed, https://github.com/simple-icons/simple-icons), the
 * standard source for exactly this "show a third party's logo in your own product"
 * use case. Slack's own mark was removed from the current package release (most likely
 * a past trademark takedown against the project), so this one is pinned from
 * simple-icons@9.0.0, the last version that still shipped it, rather than the live
 * package the other two came from. */
function SlackMark() {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" /></svg>;
}
function BasecampMark() {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.6516 22.453c-4.0328 0-7.575-1.5542-10.244-4.4946a1.11 1.11 0 0 1-.219-1.1338c.7008-1.8884 2.5935-6.2808 5.0205-6.2948h.0125c1.219 0 2.1312.9655 2.8648 1.7412.2192.2324.555.5875.7818.7611.5656-.5587 1.6775-2.4158 2.5422-4.2779.259-.5567.9203-.7985 1.4765-.5402.557.2584.7988.919.5404 1.4762-2.6217 5.6503-4.019 5.6503-4.478 5.6503-1.022 0-1.7628-.7843-2.4791-1.5422-.3208-.339-.9878-1.045-1.2482-1.045h-.0004c-.5665.095-1.8085 2.0531-2.6966 4.2034 2.1925 2.1722 4.9232 3.2726 8.1266 3.2726 4.3955 0 7.683-1.1964 9.0996-3.2953-.4888-5.585-3.5642-13.1634-9.0996-13.1634-4.6855 0-8.2152 3.264-10.4915 9.7007-.205.579-.8416.8828-1.4187.6776-.5789-.2047-.882-.8398-.6776-1.4185 2.624-7.421 6.859-11.1833 12.5878-11.1833 7.4826 0 10.9304 9.5613 11.3458 15.588a1.1154 1.1154 0 0 1-.1456.6314c-1.7407 3.0221-5.7182 4.6864-11.2002 4.6864Z" /></svg>;
}
function JiraMark() {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005z" />
    <path d="M17.294 5.757H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001z" />
    <path d="M23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0z" />
  </svg>;
}
/** Same shimmering-placeholder primitive as planbraid-app.tsx's Skeleton - duplicated
 * rather than imported since it's three lines and importing across that direction would
 * create planbraid-app.tsx <-> this file's existing one-way import cycle. */
function Skeleton({ width, height }: { width?: string | number; height?: string | number }) {
  return <span className="skeleton" style={{ width, height }} aria-hidden="true" />;
}
function ProviderMark({ provider }: { provider: IntegrationProvider }) {
  return provider === "basecamp" ? <BasecampMark /> : provider === "slack" ? <SlackMark /> : <JiraMark />;
}

/** The per-project entry point (project ⋯ menu → "Manage work integrations"). Thin chrome
 * around IntegrationsPanel, which also powers the account-level Integrations tab in
 * ProfileDialog - the two differ only in projectId scope and surrounding dialog shell. */
export function IntegrationsDialog({ project, projects, close, onImported, toast }: DialogProps) {
  return <div className="dialog-backdrop integrations-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="integrations-dialog" role="dialog" aria-modal="true" aria-labelledby="integrations-title">
      <header><div><span className="eyebrow">WORK INTEGRATIONS</span><h2 id="integrations-title">Integrations for {project.name}</h2><p>Import external work into a review queue, and publish plan updates to Slack.</p></div><button className="icon-button" onClick={close} aria-label="Close">×</button></header>
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
  useEffect(() => { toastRef.current = toast; }, [toast]);

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
      toast(`Found ${result.fetched} items; ${result.changed} changed`); await refreshIntegrations(); await openReview(binding);
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
      setReviewing(binding); setCandidates(data); setSelected(new Set(data.filter((item) => item.reviewStatus === "pending").map((item) => item.id)));
    } catch (error) { toast(messageOf(error)); }
    finally { setBusy(null); }
  }

  async function applySelected() {
    if (!reviewing || !selected.size) return;
    setBusy(`apply:${reviewing.id}`);
    try {
      const result = await api<{ created: number; matched: number }>(`/api/integrations/bindings/${reviewing.id}/candidates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "apply", externalItemIds: [...selected] }) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.integrationCandidates(reviewing.id) });
      toast(`Imported ${result.created}; matched ${result.matched} existing items`); await onImported(); await openReview(reviewing); await refreshIntegrations();
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
    <section><h3>Connected projects</h3>{bindings.length ? <div className="integration-bindings">{bindings.map((binding) => { const rowBusy = busy === `sync:${binding.id}` || busy === `review:${binding.id}` || busy === `disconnect:${binding.id}`; return <article key={binding.id}>
      <span className={`integration-provider-mark ${binding.provider}`}><ProviderMark provider={binding.provider} /></span><div><strong>{binding.externalProjectKey ? `${binding.externalProjectKey} · ` : ""}{binding.externalProjectName}</strong><small>{LABEL[binding.provider]} · {projectName(binding.projectId)} · {binding.status.replaceAll("_", " ")}{binding.lastSyncAt ? ` · last synced ${new Date(binding.lastSyncAt).toLocaleString()}` : " · not synced yet"}{binding.lastErrorCode ? ` · ${binding.lastErrorCode}` : ""}</small></div><span className="integration-count">{binding.pendingCount} pending</span>
      <button disabled={rowBusy} onClick={() => void sync(binding)}>{busy === `sync:${binding.id}` ? "Syncing…" : "Sync"}</button><button disabled={rowBusy} onClick={() => void openReview(binding)}>Review</button><button className="integration-danger" disabled={rowBusy} onClick={() => void disconnect(binding)}>Disconnect</button>
    </article>; })}</div> : <p className="integration-empty compact">No external projects are connected yet.</p>}</section>
    {reviewing && <section className="integration-review"><header><div><h3>Review {reviewing.externalProjectName}</h3><p>{pendingCandidates.length} items are awaiting a decision. Linked updates never overwrite Planbraid work.</p></div><button onClick={() => setReviewing(null)}>Close review</button></header>
      <div className="integration-review-toolbar"><label><input type="checkbox" checked={pendingCandidates.length > 0 && pendingCandidates.every((item) => selected.has(item.id))} onChange={(event) => setSelected(event.target.checked ? new Set(pendingCandidates.map((item) => item.id)) : new Set())} /> Select pending</label><button className="integration-primary" disabled={!selected.size || busy !== null} onClick={() => void applySelected()}>{busy === `apply:${reviewing.id}` ? "Applying…" : `Apply selected (${selected.size})`}</button></div>
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
