"use client";

/* Dialog backdrops are non-interactive presentation layers; every dialog includes a keyboard-accessible close button. */
/* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/no-autofocus */

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { firstValidationMessage, passwordSchema } from "@/lib/auth-validation";
import { GoogleIcon } from "@/app/google-icon";
import type { Command, DashboardState, Notification, Project, Provider, Source, WorkEvent, WorkItem, WorkStatus } from "@/lib/contracts";
import { deriveColumn, isStartedWhileBlocked } from "@/lib/graph/column.ts";
import { DAG_EDGE_TYPES } from "@/lib/graph/edges.ts";
import { accountDisplayName, labelFor, providerFamily } from "@/lib/providers.ts";
import claudeLogo from "@lobehub/icons-static-svg/icons/claude-color.svg";
import codexLogo from "@lobehub/icons-static-svg/icons/codex-color.svg";
import copilotLogo from "@lobehub/icons-static-svg/icons/copilot-color.svg";
import cursorLogo from "@lobehub/icons-static-svg/icons/cursor.svg";
import geminiLogo from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import openAILogo from "@lobehub/icons-static-svg/icons/openai.svg";
import windsurfLogo from "@lobehub/icons-static-svg/icons/windsurf.svg";

type View = "stream" | "board" | "list" | "inbox" | "agents";
type Theme = "dark" | "light";
type McpConnection = { id: string; name: string; scopes: string[]; lastUsedAt: string | null; createdAt: string };
type CommandResult = { projectId?: string; status?: "created" | "matched" | "uncertain"; matchedOn?: string; project?: { id: string; name: string } };
type GithubStatus = { connected: boolean; login: string | null; configured: boolean };
type GithubRepo = { id: number; name: string; fullName: string; description: string; htmlUrl: string; cloneUrl: string; private: boolean; updatedAt: string };
type BundledLogo = string | { src: string };

/** GitHub's mark, inlined so the picker needs no network request to render. */
function GithubMark() {
  return <svg className="github-mark" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>;
}

/** Sidebar collapse/expand toggle: a left arrow next to the logo when open (collapses),
 * a right arrow beneath the logo when collapsed (expands), so the direction always
 * points the way the toggle is about to move the rail. */
function ArrowIcon({ direction }: { direction: "left" | "right" }) {
  return <svg className={`arrow-icon ${direction}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d={direction === "left" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

const statusMeta: Record<WorkStatus, { label: string; dot: string }> = {
  proposed: { label: "Proposed", dot: "○" }, planned: { label: "Planned", dot: "◌" }, ready: { label: "Ready", dot: "◇" },
  in_progress: { label: "In progress", dot: "●" }, blocked: { label: "Blocked", dot: "◆" }, in_review: { label: "Review", dot: "◈" },
  done: { label: "Done", dot: "✓" }, cancelled: { label: "Cancelled", dot: "×" },
};
// Logos stay here rather than in lib/providers.ts: they are bundler-resolved asset
// imports, and that module is imported by server code that must not pull in SVG assets.
const providerLogo: Record<string, BundledLogo> = {
  codex: codexLogo, openai: openAILogo, chatgpt: openAILogo, claude: claudeLogo, anthropic: claudeLogo,
  gemini: geminiLogo, copilot: copilotLogo, github_copilot: copilotLogo, cursor: cursorLogo, windsurf: windsurfLogo,
};

function requestId(prefix = "ui") { return `${prefix}-${crypto.randomUUID()}`; }

type ProposingAccount = { provider: string; family: string; accountId: string | null; accountLabel: string | null };

/**
 * How the UI decides two sessions are "the same proposer". Keyed on the account's name
 * rather than its id: two credentials the owner gave the same name are one account as
 * far as a reader is concerned, and rendering the same label twice in a row reads as a
 * bug. Sessions predating agent accounts have no label and fall back to the model, which
 * is how they always deduped.
 */
function accountKeyOf(source: Source) {
  return `${providerFamily(source.provider)}:${source.agentAccountLabel ?? ""}`;
}

/**
 * Distinct agent accounts that proposed a work item: its own source plus every alias's.
 *
 * Deduped by account rather than by provider string, so the user's two logins for one
 * model stay visible as two proposers instead of collapsing into one (or, when the model
 * happened to register under two different names, silently becoming two *models*).
 * getReadyWork deliberately counts this differently (see its comment in lib/store.ts):
 * evidence strength is a per-model question, provenance is a per-account one.
 */
function corroboratingProviders(item: WorkItem, aliases: DashboardState["aliases"], sources: Source[]): ProposingAccount[] {
  const accounts = new Map<string, ProposingAccount>();
  const add = (source: Source | undefined) => {
    if (!source) return;
    accounts.set(accountKeyOf(source), { provider: source.provider, family: providerFamily(source.provider), accountId: source.agentAccountId, accountLabel: source.agentAccountLabel });
  };
  add(sources.find((source) => source.id === item.sourceId));
  for (const alias of aliases) add(sources.find((entry) => entry.id === alias.sourceId));
  return [...accounts.values()];
}

/** "Claude", or "Claude · work" when more than one account of that model is connected.
 * The qualifier is noise for the overwhelmingly common single-account case. */
function accountName(account: ProposingAccount, ambiguousFamilies: Set<string>) {
  return ambiguousFamilies.has(account.family) ? accountDisplayName(account.provider, account.accountLabel) : labelFor(account.provider);
}

/** The same rule for a plain Source, which is what most of the UI actually holds. */
function sourceName(source: Source, ambiguousFamilies: Set<string>) {
  return accountName({ provider: source.provider, family: providerFamily(source.provider), accountId: source.agentAccountId, accountLabel: source.agentAccountLabel }, ambiguousFamilies);
}

/** Model families the org has connected under more than one account. Computed from all
 * sources, not just one card's, so the same task reads the same way across the board. */
function ambiguousFamiliesOf(sources: Source[]) {
  const seen = new Map<string, Set<string>>();
  for (const source of sources) {
    const family = providerFamily(source.provider);
    if (!seen.has(family)) seen.set(family, new Set());
    seen.get(family)!.add(accountKeyOf(source));
  }
  return new Set([...seen.entries()].filter(([, accounts]) => accounts.size > 1).map(([family]) => family));
}

/**
 * The still-unresolved hard prerequisites behind an item's blockingCount, resolved to
 * their actual work items so the UI can name them rather than just show a number. Kept
 * separate from blockingCount itself (the authoritative, server-maintained value that
 * deriveColumn reads); this is a client-side re-derivation purely for display.
 */
function unresolvedBlockers(item: WorkItem, dependencies: DashboardState["dependencies"], allItems: WorkItem[]) {
  const dagTypes: readonly string[] = DAG_EDGE_TYPES;
  return dependencies
    .filter((edge) => edge.toWorkItemId === item.id && dagTypes.includes(edge.type))
    .map((edge) => allItems.find((entry) => entry.id === edge.fromWorkItemId))
    .filter((entry): entry is WorkItem => entry != null && !["done", "cancelled"].includes(entry.status));
}

export function PlanbraidApp() {
  // Hooked here, not just inside ProfileDialog, so the header and sidebar avatars stay
  // in sync with the same session the dialog reads: one source of truth, not three.
  const { data: session } = authClient.useSession();
  const avatarUrl = session?.user.image ?? null;
  const [data, setData] = useState<DashboardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [view, setView] = useState<View>("stream");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<WorkStatus | "all">("all");
  const [newUpdates, setNewUpdates] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");
  // Which pane the palette opens on: "New project" and the empty state go straight to
  // the form rather than making people find "Create a new project" in a list first.
  const [commandOpen, setCommandOpen] = useState<false | "search" | "project">(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) throw new Error("Planbraid could not load project state");
      const state = await response.json() as DashboardState;
      setData(state);
      setProjectId((current) => {
        if (current && state.projects.some((project) => project.id === current)) return current;
        return [...state.projects].sort((a, b) => state.workItems.filter((item) => item.projectId === b.id).length - state.workItems.filter((item) => item.projectId === a.id).length)[0]?.id ?? "";
      });
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Planbraid could not load");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    // A newly-connected agent (OAuth completing in a separate tab/window, or an MCP
    // client registering a session directly) has no way to push a signal into this tab:
    // the SSE stream is scoped to an already-selected project's revision, so it never
    // fires for a brand new project either. Catching up when the tab regains attention
    // covers both cases without a manual reload.
    const onFocus = () => { if (document.visibilityState !== "hidden") void refresh(true); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [refresh]);

  useEffect(() => {
    const saved = window.localStorage.getItem("planbraid-theme") ?? window.localStorage.getItem("relayboard-theme");
    setTheme(saved === "dark" || saved === "light" ? saved : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("planbraid-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!projectId) return;
    const project = data?.projects.find((entry) => entry.id === projectId);
    const after = project?.revision ?? 0;
    const stream = new EventSource(`/api/events?projectId=${encodeURIComponent(projectId)}&after=${after}`);
    stream.addEventListener("project-event", (message) => {
      setNewUpdates((count) => count + 1);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => void refresh(true), 250);
      try {
        const event = JSON.parse((message as MessageEvent).data) as { summary?: string; event_type?: string };
        void showSystemNotification(event.event_type?.includes("blocked") ? "Planbraid needs attention" : "Planbraid update", event.summary ?? "Project work changed");
      } catch { /* reconnect refresh is authoritative */ }
    });
    stream.onerror = () => stream.close();
    const fallback = setInterval(() => void refresh(true), 15000);
    return () => { stream.close(); clearInterval(fallback); if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [projectId, data?.projects, refresh]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen("search"); }
      if (event.key === "Escape") { setSelectedItemId(null); setCommandOpen(false); setSetupOpen(false); setProfileOpen(false); setSidebarOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const project = data?.projects.find((entry) => entry.id === projectId) ?? null;
  const projectItems = useMemo(() => (data?.workItems ?? []).filter((item) => item.projectId === projectId), [data, projectId]);
  const sources = useMemo(() => (data?.sources ?? []).filter((source) => source.projectId === projectId), [data, projectId]);
  const filteredItems = useMemo(() => projectItems.filter((item) => (!sourceId || item.sourceId === sourceId) && (statusFilter === "all" || deriveColumn(item) === statusFilter) && (!query || `${item.itemKey} ${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase()))), [projectItems, sourceId, statusFilter, query]);
  const events = useMemo(() => (data?.events ?? []).filter((event) => {
    if (event.projectId !== projectId || (sourceId && event.sourceId !== sourceId) || (query && !event.summary.toLowerCase().includes(query.toLowerCase()))) return false;
    if (statusFilter === "all") return true;
    const item = projectItems.find((entry) => entry.id === event.workItemId);
    return item ? deriveColumn(item) === statusFilter : false;
  }), [data, projectId, sourceId, query, statusFilter, projectItems]);
  const selectedItem = data?.workItems.find((item) => item.id === selectedItemId) ?? null;
  const unread = data?.notifications.filter((notification) => !notification.readAt).length ?? 0;

  async function command(command: Command, success: string | ((result: CommandResult) => string)) {
    setMutating(true);
    try {
      const response = await fetch("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
      const body = await response.json() as { data?: CommandResult; error?: { code: string; message: string } };
      if (!response.ok) throw new Error(body.error ? `${body.error.message} (${body.error.code})` : "Update failed");
      const result = body.data ?? {};
      setToast(typeof success === "function" ? success(result) : success);
      setTimeout(() => setToast(null), 4000);
      await refresh(true);
      return result;
    } catch (caught) { setToast(caught instanceof Error ? caught.message : "Update failed"); return {}; }
    finally { setMutating(false); }
  }

  function settleSidebarAfterSelection() {
    if (window.matchMedia("(max-width: 900px)").matches) setSidebarOpen(false);
  }

  if (loading && !data) return <LoadingShell />;
  if (error && !data) return <ErrorState message={error} retry={() => void refresh()} />;

  return (
    <main className={`app-shell ${sidebarOpen ? "sidebar-open" : ""}`}>
      <ProjectRail data={data!} avatarUrl={avatarUrl} selected={projectId} selectedSource={sourceId} sources={sources} onSelect={(id) => { setProjectId(id); setSourceId(null); setSelectedItemId(null); setStatusFilter("all"); setQuery(""); setView("stream"); settleSidebarAfterSelection(); }} onSource={(id) => { setSourceId(id); setStatusFilter("all"); setView("stream"); settleSidebarAfterSelection(); }} open={sidebarOpen} toggle={() => setSidebarOpen((open) => !open)} onNew={() => setCommandOpen("project")} onProfile={() => setProfileOpen(true)} />
      <section className="workspace" aria-label="Unified project workspace">
        <Header project={project} itemCount={projectItems.length} sources={sources} unread={unread} view={view} setView={setView} query={query} setQuery={setQuery} theme={theme} toggleTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")} onSetup={() => setSetupOpen(true)} viewer={data!.viewer} avatarUrl={avatarUrl} onProfile={() => setProfileOpen(true)} />
        {project && view !== "inbox" && view !== "agents" && <FilterBar items={projectItems} filter={statusFilter} setFilter={setStatusFilter} source={sources.find((entry) => entry.id === sourceId) ?? null} clearSource={() => setSourceId(null)} />}
        {newUpdates > 0 && <button className="new-updates" onClick={() => { setNewUpdates(0); window.scrollTo({ top: 0, behavior: "smooth" }); }}>↑ {newUpdates} new {newUpdates === 1 ? "update" : "updates"}</button>}
        <div className="workspace-body">
          {!project && <Empty title="No projects yet" body="Create a project for organized tracking, or connect an agent now and create the project from your MCP client." action="Create project" onAction={() => setCommandOpen("project")} secondaryAction="Connect agent" onSecondaryAction={() => setSetupOpen(true)} />}
          {project && view === "stream" && <Stream events={events} items={projectItems} sources={sources} onItem={setSelectedItemId} />}
          {project && view === "board" && <Board items={filteredItems} sources={sources} aliases={data?.aliases ?? []} dependencies={data?.dependencies ?? []} onItem={setSelectedItemId} onTransition={(item, status) => void command({ action: "transition_item", projectId: item.projectId, itemId: item.id, expectedVersion: item.version, status, idempotencyKey: requestId("drag") }, `${item.itemKey} moved to ${statusMeta[status].label}`)} />}
          {project && view === "list" && <ListView items={filteredItems} sources={sources} aliases={data?.aliases ?? []} onItem={setSelectedItemId} />}
          {project && view === "inbox" && <Inbox notifications={data!.notifications.filter((entry) => entry.projectId === projectId)} onOpen={(notification) => { if (notification.workItemId) setSelectedItemId(notification.workItemId); void command({ action: "mark_notification", notificationId: notification.id, read: true, idempotencyKey: requestId("read") }, "Notification marked read"); }} onResolve={(notification) => void command({ action: "mark_notification", notificationId: notification.id, read: true, resolved: true, idempotencyKey: requestId("resolve") }, "Action resolved")} />}
          {project && view === "agents" && <Agents sources={sources} items={projectItems} />}
        </div>
        {project && view !== "inbox" && view !== "agents" && <Composer project={project} sources={sources} busy={mutating} onCreate={(title, source) => void command({ action: "create_item", projectId, title, sourceId: source || undefined, status: "proposed", idempotencyKey: requestId("create") }, "Task added to the unified plan")} />}
      </section>
      {selectedItem && <TaskDrawer item={selectedItem} source={sources.find((entry) => entry.id === selectedItem.sourceId) ?? null} sources={sources} events={(data?.events ?? []).filter((event) => event.workItemId === selectedItem.id)} evidence={(data?.evidence ?? []).filter((entry) => entry.workItemId === selectedItem.id)} dependencies={(data?.dependencies ?? []).filter((entry) => entry.fromWorkItemId === selectedItem.id || entry.toWorkItemId === selectedItem.id)} aliases={(data?.aliases ?? []).filter((entry) => entry.workItemId === selectedItem.id)} allItems={projectItems} busy={mutating} close={() => setSelectedItemId(null)} transition={(status, reason) => void command({ action: "transition_item", projectId: selectedItem.projectId, itemId: selectedItem.id, expectedVersion: selectedItem.version, status, reason, sourceId: selectedItem.sourceId ?? undefined, idempotencyKey: requestId("transition") }, `${selectedItem.itemKey} is now ${statusMeta[status].label}`)} note={(summary) => void command({ action: "add_note", projectId: selectedItem.projectId, itemId: selectedItem.id, summary, sourceId: selectedItem.sourceId ?? undefined, idempotencyKey: requestId("note") }, "Progress recorded")} splitAlias={(aliasId) => void command({ action: "split_alias", projectId: selectedItem.projectId, aliasId, idempotencyKey: requestId("split") }, "Moved back into its own task")} />}
      {commandOpen && <CommandDialog projects={data!.projects} currentProject={projectId} initialMode={commandOpen === "project" ? "project" : "search"} busy={mutating} close={() => setCommandOpen(false)} create={async (input) => {
        const result = await command({ action: "create_project", name: input.name, description: input.description || undefined, gitRemote: input.gitRemote || undefined, idempotencyKey: requestId("project") }, (outcome) =>
          outcome.status === "matched" ? `Opened "${outcome.project?.name}" instead, the existing project for this ${outcome.matchedOn}`
            : outcome.status === "uncertain" ? `"${outcome.project?.name}" already exists`
              : "Project created");
        // Only "uncertain" leaves a decision open; matched and created both settle here.
        if (result.status !== "uncertain") {
          if (result.projectId) { setProjectId(result.projectId); setSourceId(null); setView("stream"); }
          setCommandOpen(false);
        }
        return result;
      }} />}
      {setupOpen && <SetupDialog project={project} close={() => setSetupOpen(false)} toast={setToast} />}
      {profileOpen && <ProfileDialog viewer={data!.viewer} close={() => setProfileOpen(false)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
      {project && <nav className="mobile-nav" aria-label="Mobile navigation">
        <button className={view === "stream" ? "active" : ""} onClick={() => setView("stream")}>Activity</button><button className={view === "board" ? "active" : ""} onClick={() => setView("board")}>Board</button><button className={view === "inbox" ? "active" : ""} onClick={() => setView("inbox")}>Inbox{unread ? ` · ${unread}` : ""}</button><button className={view === "agents" ? "active" : ""} onClick={() => setView("agents")}>Agents</button>
      </nav>}
    </main>
  );
}

function LoadingShell() { return <div className="loading-screen"><div className="brand-mark graphic" aria-hidden="true" /><div><strong>Planbraid</strong><span>Braiding your project work…</span></div></div>; }
function ErrorState({ message, retry }: { message: string; retry: () => void }) { return <div className="error-screen"><div className="brand-mark graphic" aria-hidden="true" /><h1>Couldn’t open Planbraid</h1><p>{message}</p><button onClick={retry}>Try again</button></div>; }

function ProjectRail({ data, avatarUrl, selected, selectedSource, sources, onSelect, onSource, open, toggle, onNew, onProfile }: { data: DashboardState; avatarUrl: string | null; selected: string; selectedSource: string | null; sources: Source[]; onSelect: (id: string) => void; onSource: (id: string | null) => void; open: boolean; toggle: () => void; onNew: () => void; onProfile: () => void }) {
  const railAmbiguousFamilies = ambiguousFamiliesOf(sources);
  return <aside className={`project-rail ${open ? "open" : "collapsed"}`} aria-label="Projects and agent conversations">
    <div className="rail-brand">
      <span className="planbraid-logo" aria-hidden="true" />
      {open && <strong>Planbraid</strong>}
      {open && <button className="icon-button sidebar-toggle" onClick={toggle} aria-label="Collapse projects and agents" aria-expanded={open}><ArrowIcon direction="left" /></button>}
    </div>
    {!open && <button className="icon-button sidebar-toggle collapsed-toggle" onClick={toggle} aria-label="Expand projects and agents" aria-expanded={open}><ArrowIcon direction="right" /></button>}
    {open && <><button className="new-project" onClick={onNew}><span>＋</span> New project</button>
    <div className="rail-label">Projects</div>
    <div className="project-list">{data.projects.map((project) => {
      const taskCount = data.workItems.filter((item) => item.projectId === project.id).length;
      const activeCount = data.sources.filter((source) => source.projectId === project.id && source.status === "active").length;
      return <button key={project.id} className={`project-row ${selected === project.id ? "selected" : ""}`} onClick={() => onSelect(project.id)} aria-current={selected === project.id ? "page" : undefined}><span className="project-glyph">{project.name.slice(0, 1)}</span><span className="project-copy"><strong>{project.name}</strong><small>{project.description || "Project workspace"}</small><span>{taskCount} {taskCount === 1 ? "task" : "tasks"}{activeCount ? ` · ${activeCount} active` : ""}</span></span></button>;
    })}</div>
    <div className="rail-divider" />
    <div className="rail-label">Chats & agents</div>
    <div className="agent-list"><button className={`source-row all-sources ${selectedSource === null ? "active" : ""}`} onClick={() => onSource(null)}><span className="all-agent-icon">◎</span><span><strong>All activity</strong><small>Every connected conversation</small></span></button>{sources.map((source) => <button key={source.id} className={`source-row ${selectedSource === source.id ? "active" : ""}`} onClick={() => onSource(source.id)}><ProviderIcon provider={source.provider} /><span><strong>{sourceName(source, railAmbiguousFamilies)}</strong><small>{source.title}</small></span><span className={`presence ${source.status}`} title={source.status} /></button>)}</div>
    <button className="rail-footer" onClick={onProfile}><span className="avatar">{avatarUrl ? <span className="profile-image" style={{ backgroundImage: `url(${JSON.stringify(avatarUrl)})` }} aria-hidden="true" /> : data.viewer.name.slice(0, 1).toUpperCase()}</span><span><strong>{data.viewer.name}</strong><small>Account &amp; profile</small></span><b aria-hidden="true">›</b></button></>}
  </aside>;
}

function Header({ project, itemCount, sources, unread, view, setView, query, setQuery, theme, toggleTheme, onSetup, viewer, avatarUrl, onProfile }: { project: Project | null; itemCount: number; sources: Source[]; unread: number; view: View; setView: (view: View) => void; query: string; setQuery: (query: string) => void; theme: Theme; toggleTheme: () => void; onSetup: () => void; viewer: DashboardState["viewer"]; avatarUrl: string | null; onProfile: () => void }) {
  return <><header className="workspace-header">
    {project && <div className="workspace-heading"><span className="workspace-project"><h1>{project.name}</h1><p>{itemCount} {itemCount === 1 ? "task" : "tasks"} · {sources.length} connected {sources.length === 1 ? "conversation" : "conversations"}</p></span></div>}
    <div className="header-actions">{project && <label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks and updates" aria-label="Search tasks and updates"/></label>}{project && <div className="sync-pill" aria-label={`${sources.filter((source) => source.status === "active").length} active agents`}><span className="presence active" /> Live</div>}<button className={`theme-switch ${theme}`} role="switch" aria-checked={theme === "light"} onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}><span className="theme-switch-thumb" aria-hidden="true"><span className="theme-switch-icon moon">☾</span><span className="theme-switch-icon sun">☼</span></span></button><button className="setup-button" onClick={onSetup}>Connect agent</button><button className="profile-trigger" onClick={onProfile} aria-label="Open account and profile" title="Account and profile"><span className="avatar">{avatarUrl ? <span className="profile-image" style={{ backgroundImage: `url(${JSON.stringify(avatarUrl)})` }} aria-hidden="true" /> : viewer.name.slice(0, 1).toUpperCase()}</span></button></div>
  </header>{project && <nav className="view-tabs" aria-label="Project views">{(["stream", "board", "list", "inbox", "agents"] as View[]).map((entry) => <button key={entry} className={view === entry ? "active" : ""} aria-pressed={view === entry} onClick={() => setView(entry)}>{entry === "stream" ? "Activity" : entry[0].toUpperCase() + entry.slice(1)}{entry === "inbox" && unread > 0 ? <b>{unread}</b> : null}</button>)}</nav>}</>;
}

function ProfileDialog({ viewer, close }: { viewer: DashboardState["viewer"]; close: () => void }) {
  const { data: session, isPending } = authClient.useSession();
  const [name, setName] = useState(viewer.name);
  const [providers, setProviders] = useState<string[]>([]);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [github, setGithub] = useState<GithubStatus | null>(null);
  const local = viewer.email.endsWith("@planbraid.local");

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/github", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json() as { data?: GithubStatus };
      setGithub(body.data ?? null);
    })();
  }, []);

  async function disconnectGithub() {
    setBusy(true);
    try {
      await fetch("/api/github", { method: "DELETE" });
      setGithub((current) => current ? { ...current, connected: false, login: null } : current);
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (local) return;
    void Promise.all([
      authClient.listAccounts(),
      fetch("/api/account/config", { cache: "no-store" }).then((response) => response.json()),
    ]).then(([accounts, config]) => {
      setProviders((accounts.data ?? []).map((account) => account.providerId));
      setGoogleEnabled(Boolean((config as { data?: { googleEnabled?: boolean } }).data?.googleEnabled));
      setAccountsLoaded(true);
    }).catch(() => { setAccountsLoaded(true); setMessage("Account details could not be refreshed."); });
  }, [local]);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    const cleanName = name.trim();
    if (local || cleanName.length < 2) return;
    setBusy(true);
    setMessage(null);
    const result = await authClient.updateUser({ name: cleanName });
    if (result.error) { setMessage(result.error.message || "Profile update failed"); setBusy(false); return; }
    window.location.reload();
  }

  async function signOut() {
    setBusy(true);
    await authClient.signOut();
    window.location.assign("/sign-in");
  }

  async function linkGoogle() {
    setBusy(true);
    const result = await authClient.linkSocial({ provider: "google", callbackURL: "/" });
    if (result?.error) { setMessage(result.error.message || "Google connection failed"); setBusy(false); }
  }

  async function addPassword(event: FormEvent) {
    event.preventDefault();
    const parsed = passwordSchema.safeParse(newPassword);
    if (!parsed.success) { setMessage(firstValidationMessage(parsed.error)); return; }
    if (newPassword !== confirmPassword) { setMessage("The two passwords do not match."); return; }
    setBusy(true);
    setMessage(null);
    const response = await fetch("/api/account/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: parsed.data }) });
    const body = await response.json() as { error?: { message?: string } };
    if (!response.ok) { setMessage(body.error?.message ?? "Password setup failed"); setBusy(false); return; }
    setProviders((current) => [...new Set([...current, "credential"])]);
    setNewPassword("");
    setConfirmPassword("");
    setMessage("Email and password sign-in is now connected to this same account.");
    setBusy(false);
  }

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title">
    <header><div><span className="eyebrow">PLANBRAID ACCOUNT</span><h2 id="profile-title">Account &amp; profile</h2><p>Your identity and persistent workspace settings.</p></div><button className="icon-button" onClick={close} aria-label="Close account and profile">×</button></header>
    <div className="profile-identity"><span className="profile-avatar">{session?.user.image ? <span className="profile-image" style={{ backgroundImage: `url(${JSON.stringify(session.user.image)})` }} aria-hidden="true" /> : viewer.name.slice(0, 1).toUpperCase()}</span><span><strong>{session?.user.name || viewer.name}</strong><small>{session?.user.email || viewer.email}</small></span></div>
    {local ? <div className="profile-local-note"><strong>Local development workspace</strong><p>Account sessions are required on the hosted Planbraid app. Localhost keeps a developer-only workspace so the product can be tested without creating an account.</p></div> : <>
      <form className="profile-form" onSubmit={saveProfile}><label><span>Display name</span><input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} disabled={isPending || busy} /></label><label><span>Email</span><input value={session?.user.email || viewer.email} disabled /></label><button className="primary-wide" disabled={busy || isPending || name.trim() === (session?.user.name || viewer.name)}>Save profile</button></form>
      <div className="login-methods"><div><h3>Sign-in methods</h3><p>Methods with the same verified email belong to this one account and workspace.</p></div><div className={`login-method ${accountsLoaded && !providers.includes("credential") ? "unavailable" : ""}`}><span className="method-icon">@</span><span><strong>Email &amp; password</strong><small>{providers.includes("credential") ? "Connected to this account" : accountsLoaded ? "No password set" : "Checking…"}</small></span><b>{providers.includes("credential") ? "Connected" : accountsLoaded ? "Not set" : "…"}</b></div>{accountsLoaded && !providers.includes("credential") && <form className="password-setup" onSubmit={addPassword}><strong>Add password sign-in</strong><p>You signed up with Google. Set a password if you also want to sign in with this account&apos;s email address.</p><p className="field-hint">Use 10 or more characters with uppercase, lowercase, a number, and a special character.</p><label><span>New password</span><input type="password" autoComplete="new-password" minLength={10} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label><label><span>Confirm password</span><input type="password" autoComplete="new-password" minLength={10} maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label><button className="primary-wide" disabled={busy}>Add password</button></form>}{providers.includes("google") ? <div className="login-method"><ProviderIcon provider="google" /><span><strong>Google</strong><small>Connected to this account</small></span><b>Connected</b></div> : googleEnabled ? <button className="login-method connect-method" disabled={busy} onClick={() => void linkGoogle()}><ProviderIcon provider="google" /><span><strong>Google</strong><small>Add another secure sign-in method</small></span><b>Connect</b></button> : <div className="login-method unavailable"><ProviderIcon provider="google" /><span><strong>Google</strong><small>Waiting for OAuth credentials</small></span><b>Setup needed</b></div>}</div>
      {github?.configured && <div className="login-methods">
        <div><h3>Connected services</h3><p>Link GitHub to pick a repository when you create a project. Planbraid reads repository names only, never your code.</p></div>
        {github.connected
          ? <div className="login-method"><span className="method-icon"><GithubMark /></span><span><strong>GitHub</strong><small>Connected as @{github.login}</small></span><button className="link-button" disabled={busy} onClick={() => void disconnectGithub()}>Disconnect</button></div>
          : <a className="login-method connect-method" href="/api/github/connect"><span className="method-icon"><GithubMark /></span><span><strong>GitHub</strong><small>Choose which repositories Planbraid can see</small></span><b>Connect</b></a>}
      </div>}
      {message && <div className="auth-error" role="status">{message}</div>}
      <div className="profile-actions"><button className="signout-button" disabled={busy} onClick={() => void signOut()}>Sign out</button><small>Signing out does not disconnect your authorized MCP agents.</small></div>
    </>}
  </section></div>;
}

function FilterBar({ items, filter, setFilter, source, clearSource }: { items: WorkItem[]; filter: WorkStatus | "all"; setFilter: (status: WorkStatus | "all") => void; source: Source | null; clearSource: () => void }) {
  const statuses: Array<WorkStatus | "all"> = ["all", "in_progress", "ready", "blocked", "in_review", "done"];
  return <div className="filter-bar"><div className="filter-scroll">{statuses.map((status) => <button key={status} className={filter === status ? "active" : ""} onClick={() => setFilter(status)}>{status === "all" ? "All work" : statusMeta[status].label}<span>{status === "all" ? items.length : items.filter((item) => deriveColumn(item) === status).length}</span></button>)}</div>{source && <button className="source-filter" onClick={clearSource}><ProviderIcon provider={source.provider} /> {source.title} ×</button>}</div>;
}

function Stream({ events, items, sources, onItem }: { events: WorkEvent[]; items: WorkItem[]; sources: Source[]; onItem: (id: string) => void }) {
  if (!events.length) return <Empty title="No updates in this view" body="Change the source or search filter, or create the first task update." />;
  return <div className="stream" aria-live="polite">{events.map((event, index) => {
    const day = new Date(event.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(event.createdAt).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
    const item = items.find((entry) => entry.id === event.workItemId);
    const source = sources.find((entry) => entry.id === event.sourceId);
    const previousDay = index > 0 ? new Date(events[index - 1].createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(events[index - 1].createdAt).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined }) : "";
    const separator = day !== previousDay;
    return <div key={event.id}>{separator && <div className="day-separator"><span>{day}</span></div>}<article className={`event-card ${eventTone(event)}`}><div className="event-icon"><ProviderIcon provider={(source?.provider ?? (event.actorName.toLowerCase() as Provider))} /></div><div className="event-content"><div className="event-meta"><strong>{event.actorName}</strong><span>{eventAction(event.eventType)}</span><time title={new Date(event.createdAt).toLocaleString()}>{relative(event.createdAt)}</time></div><p>{event.summary}</p>{item && <button className="event-task" onClick={() => onItem(item.id)}><span className={`status-dot ${item.status}`}>{statusMeta[item.status].dot}</span><b>{item.itemKey}</b><span>{item.title}</span><small>{statusMeta[item.status].label}</small></button>}{event.eventType === "interaction.completed" && <div className="interaction-chip">Turn reconciled · {String(event.metadata.reconciliation ?? "recorded").replaceAll("_", " ")}</div>}</div></article></div>;
  })}</div>;
}

function Board({ items, sources, aliases, dependencies, onItem, onTransition }: { items: WorkItem[]; sources: Source[]; aliases: DashboardState["aliases"]; dependencies: DashboardState["dependencies"]; onItem: (id: string) => void; onTransition: (item: WorkItem, status: WorkStatus) => void }) {
  const columns: WorkStatus[] = ["proposed", "planned", "ready", "in_progress", "blocked", "in_review", "done"];
  // Grouped by the derived column, not raw status: a card here moves on its own once
  // its last blocker resolves, with no write to the card's own row. See lib/graph/column.ts.
  const byColumn = new Map(columns.map((status) => [status, items.filter((item) => deriveColumn(item) === status)]));
  const ambiguousFamilies = ambiguousFamiliesOf(sources);
  return <div className="board">{columns.map((status) => <section className="board-column" key={status}><header><span className={`status-dot ${status}`}>{statusMeta[status].dot}</span><strong>{statusMeta[status].label}</strong><b>{byColumn.get(status)?.length ?? 0}</b></header><div className="board-stack">{byColumn.get(status)?.map((item) => <TaskCard key={item.id} item={item} source={sources.find((source) => source.id === item.sourceId)} aliases={aliases.filter((alias) => alias.workItemId === item.id)} sources={sources} ambiguousFamilies={ambiguousFamilies} dependencies={dependencies} allItems={items} onClick={() => onItem(item.id)} onMove={(next) => onTransition(item, next)} />)}</div></section>)}</div>;
}

function TaskCard({ item, source, aliases, sources, ambiguousFamilies, dependencies, allItems, onClick, onMove }: { item: WorkItem; source?: Source; aliases: DashboardState["aliases"]; sources: Source[]; ambiguousFamilies: Set<string>; dependencies: DashboardState["dependencies"]; allItems: WorkItem[]; onClick: () => void; onMove: (status: WorkStatus) => void }) {
  const corroboration = corroboratingProviders(item, aliases, sources);
  const corroborated = corroboration.length > 1;
  const aliasTitle = aliases.map((alias) => { const aliasSource = sources.find((entry) => entry.id === alias.sourceId); return `${aliasSource ? sourceName(aliasSource, ambiguousFamilies) : "Another agent"} also proposed: "${alias.title}"`; }).join("\n");
  const column = deriveColumn(item);
  const waitingOn = column === "blocked" && item.status !== "blocked" ? unresolvedBlockers(item, dependencies, allItems) : [];
  const anomaly = isStartedWhileBlocked(item);
  return <article className="task-card"><button className="task-card-main" onClick={onClick}><div><span className={`priority ${item.priority}`} /> <b>{item.itemKey}</b>{aliases.length > 0 && <span className={`alias-badge ${corroborated ? "corroborated" : ""}`} title={aliasTitle}>+{aliases.length}</span>}{anomaly && <span className="anomaly-badge" title="This is in progress, but a prerequisite is unresolved: either it was reopened, or the dependency was added after work started.">⚠ started while blocked</span>}<small>v{item.version}</small></div><h3>{item.title}</h3>{item.blockerReason && <p className="blocker-copy">{item.blockerReason}</p>}{waitingOn.length > 0 && <p className="blocker-copy">Waiting on {waitingOn.map((entry) => entry.itemKey).join(", ")}</p>}{/* corroboration already includes the card's own source, so a plural stack replaces
    the single-source label rather than sitting beside a duplicate of itself. */}
          <footer>{corroborated ? <ProviderStack accounts={corroboration} ambiguousFamilies={ambiguousFamilies} /> : source ? <span><ProviderIcon provider={source.provider} /> {sourceName(source, ambiguousFamilies)}</span> : <span>Manual</span>}</footer></button><select aria-label={`Move ${item.itemKey}`} value={item.status} onChange={(event) => onMove(event.target.value as WorkStatus)}>{Object.entries(statusMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></article>;
}

function ListView({ items, sources, aliases, onItem }: { items: WorkItem[]; sources: Source[]; aliases: DashboardState["aliases"]; onItem: (id: string) => void }) {
  const ambiguousFamilies = ambiguousFamiliesOf(sources);
  return <div className="list-view"><div className="list-head"><span>Work item</span><span>Status</span><span>Source</span><span>Corroboration</span><span>Updated</span></div>{items.map((item) => {
    const source = sources.find((entry) => entry.id === item.sourceId);
    const column = deriveColumn(item);
    const corroboration = corroboratingProviders(item, aliases.filter((alias) => alias.workItemId === item.id), sources);
    return <button className="list-row" key={item.id} onClick={() => onItem(item.id)}><span className="list-title"><span className={`priority ${item.priority}`} /><b>{item.itemKey}</b><strong>{item.title}</strong></span><span className={`status-badge ${column}`}>{statusMeta[column].dot} {statusMeta[column].label}</span><span>{source ? <><ProviderIcon provider={source.provider} /> {sourceName(source, ambiguousFamilies)}</> : "Manual"}</span><span>{corroboration.length > 0 ? <ProviderStack accounts={corroboration} ambiguousFamilies={ambiguousFamilies} /> : <span className="muted">·</span>}</span><span>{relative(item.updatedAt)}</span></button>;
  })}</div>;
}

function Inbox({ notifications, onOpen, onResolve }: { notifications: Notification[]; onOpen: (notification: Notification) => void; onResolve: (notification: Notification) => void }) {
  const [tab, setTab] = useState<"action" | "updates" | "all">("action");
  const visible = notifications.filter((notification) => tab === "all" || tab === "action" ? (tab === "all" || notification.requiresAction && !notification.resolvedAt) : !notification.requiresAction);
  return <div className="inbox"><div className="inbox-heading"><span><h2>Inbox</h2><p>Decisions, completed turns, blockers, and agent health.</p></span><div className="segment"><button className={tab === "action" ? "active" : ""} onClick={() => setTab("action")}>Needs action</button><button className={tab === "updates" ? "active" : ""} onClick={() => setTab("updates")}>Updates</button><button className={tab === "all" ? "active" : ""} onClick={() => setTab("all")}>All</button></div></div>{visible.length ? <div className="inbox-list">{visible.map((notification) => <article className={`notification-card ${notification.readAt ? "read" : ""}`} key={notification.id}><span className={`notification-priority ${notification.priority}`}>!</span><button className="notification-main" onClick={() => onOpen(notification)}><div><strong>{notification.title}</strong><time>{relative(notification.createdAt)}</time></div><p>{notification.body}</p><small>{notification.eventType.replaceAll("_", " ").replaceAll(".", " · ")}</small></button>{notification.requiresAction && !notification.resolvedAt && <button className="resolve-button" onClick={() => onResolve(notification)}>Resolve</button>}</article>)}</div> : <Empty title="You’re caught up" body="Nothing in this notification view needs your attention." />}</div>;
}

function Agents({ sources, items }: { sources: Source[]; items: WorkItem[] }) { const agentAmbiguousFamilies = ambiguousFamiliesOf(sources); return <div className="agents-view"><div className="inbox-heading"><span><h2>Connected agents</h2><p>Sessions, coding spaces, capture assurance, and current work.</p></span></div><div className="agent-grid">{sources.map((source) => <article className="agent-card" key={source.id}><header><ProviderIcon provider={source.provider} /><span><h3>{sourceName(source, agentAmbiguousFamilies)}</h3><p>{source.model ?? "Agent session"}</p></span><span className={`agent-status ${source.status}`}>{source.status}</span></header><h4>{source.title}</h4><div className="assurance-line"><Assurance value={source.assurance} /><span>Last event {relative(source.lastSeenAt)}</span></div><div className="agent-work">{items.filter((item) => item.sourceId === source.id && !["done", "cancelled"].includes(item.status)).map((item) => <span key={item.id}><b>{item.itemKey}</b> {item.title}</span>)}</div></article>)}</div></div>; }

function Composer({ project, sources, busy, onCreate }: { project: Project | null; sources: Source[]; busy: boolean; onCreate: (title: string, source: string) => void }) {
  const [title, setTitle] = useState(""); const [source, setSource] = useState("");
  const composerAmbiguousFamilies = ambiguousFamiliesOf(sources);
  function submit(event: FormEvent) { event.preventDefault(); if (!title.trim()) return; onCreate(title.trim(), source); setTitle(""); }
  return <form className="composer" onSubmit={submit}><span className="composer-plus">＋</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`Add work to ${project?.name ?? "this project"}…`} aria-label="New task title"/><select value={source} onChange={(event) => setSource(event.target.value)} aria-label="Task source"><option value="">Manual</option>{sources.map((entry) => <option value={entry.id} key={entry.id}>{sourceName(entry, composerAmbiguousFamilies)} · {entry.title}</option>)}</select><button disabled={busy || !title.trim()}>{busy ? "Saving…" : "Add task"}</button></form>;
}

function TaskDrawer({ item, source, sources, events, evidence, dependencies, aliases, allItems, busy, close, transition, note, splitAlias }: { item: WorkItem; source: Source | null; sources: Source[]; events: WorkEvent[]; evidence: DashboardState["evidence"]; dependencies: DashboardState["dependencies"]; aliases: DashboardState["aliases"]; allItems: WorkItem[]; busy: boolean; close: () => void; transition: (status: WorkStatus, reason?: string) => void; note: (summary: string) => void; splitAlias: (aliasId: string) => void }) {
  const [tab, setTab] = useState<"overview" | "activity" | "evidence">("overview"); const [noteText, setNoteText] = useState("");
  const corroboratedProviders = corroboratingProviders(item, aliases, sources);
  const drawerAmbiguousFamilies = ambiguousFamiliesOf(sources);
  const waitingOn = unresolvedBlockers(item, dependencies, allItems);
  const anomaly = isStartedWhileBlocked(item);
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><aside className="task-drawer" aria-label={`${item.itemKey} details`}><header className="drawer-header"><span className={`status-badge ${item.status}`}>{statusMeta[item.status].dot} {statusMeta[item.status].label}</span><button className="icon-button" onClick={close} aria-label="Close task">×</button></header><div className="drawer-title"><small>{item.itemKey} · v{item.version}</small><h2>{item.title}</h2><p>{item.description || "No description has been added yet."}</p>{corroboratedProviders.length > 1 && <p className="corroboration-banner">Proposed independently by {corroboratedProviders.map((account) => accountName(account, drawerAmbiguousFamilies)).join(" and ")}.</p>}{anomaly && <p className="anomaly-banner">⚠ In progress, but {waitingOn.length ? `${waitingOn.map((entry) => entry.itemKey).join(", ")} is still unresolved` : "a prerequisite is still unresolved"}.</p>}</div><div className="drawer-fields"><label>Status<select value={item.status} disabled={busy} onChange={(event) => transition(event.target.value as WorkStatus, event.target.value === "blocked" ? "Blocked from task detail" : undefined)}>{Object.entries(statusMeta).map(([value, meta]) => <option value={value} key={value}>{meta.label}</option>)}</select></label><label>Priority<strong className={`priority-value ${item.priority}`}>{item.priority}</strong></label><label>Owner<strong>{item.assignee ?? "Unassigned"}</strong></label><label>Source<strong>{source ? <><ProviderIcon provider={source.provider} /> {sourceName(source, drawerAmbiguousFamilies)}</> : "Manual"}</strong></label></div><nav className="drawer-tabs"><button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Overview</button><button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Activity {events.length}</button><button className={tab === "evidence" ? "active" : ""} onClick={() => setTab("evidence")}>Evidence {evidence.length}</button></nav><div className="drawer-body">{tab === "overview" && <><section><h3>Completion</h3><div className="confidence"><span>{item.completionConfidence}</span><span>{item.verificationStatus}</span></div></section>{item.blockerReason && <section className="blocker-panel"><h3>Blocker</h3><p>{item.blockerReason}</p></section>}{waitingOn.length > 0 && <section className="blocker-panel"><h3>Waiting on</h3>{waitingOn.map((entry) => <p key={entry.id}><b>{entry.itemKey}</b> {entry.title} · {statusMeta[entry.status].label}</p>)}</section>}<section><h3>Dependencies</h3>{dependencies.length ? dependencies.map((edge) => { const linkedId = edge.fromWorkItemId === item.id ? edge.toWorkItemId : edge.fromWorkItemId; const linked = allItems.find((entry) => entry.id === linkedId); return <div className="dependency-row" key={edge.id}><span>{edge.type}</span><b>{linked?.itemKey}</b><p>{linked?.title}</p></div>; }) : <p className="muted">No dependencies.</p>}</section>{aliases.length > 0 && <section><h3>Also proposed</h3>{aliases.map((alias) => { const aliasSource = sources.find((entry) => entry.id === alias.sourceId); return <div className="alias-row" key={alias.id}><ProviderIcon provider={(aliasSource?.provider ?? "system") as Provider} /><span><strong>{alias.title}</strong><small>{aliasSource ? sourceName(aliasSource, drawerAmbiguousFamilies) : "Another agent"} · {relative(alias.createdAt)} · {alias.matchReason}</small></span><button className="alias-split" disabled={busy} onClick={() => splitAlias(alias.id)}>Not the same, make separate task</button></div>; })}</section>}</>}{tab === "activity" && events.map((event) => { const eventSource = sources.find((entry) => entry.id === event.sourceId); return <div className="mini-event" key={event.id}><ProviderIcon provider={(eventSource?.provider ?? "system") as Provider}/><span><strong>{event.summary}</strong><small>{event.actorName} · {relative(event.createdAt)}</small></span></div>; })}{tab === "evidence" && (evidence.length ? evidence.map((entry) => { const evidenceSource = sources.find((entry2) => entry2.id === entry.sourceId); return <div className="evidence-row" key={entry.id}>{evidenceSource ? <ProviderIcon provider={evidenceSource.provider} /> : <span className="evidence-check">✓</span>}<span><strong>{entry.label}</strong><small>{entry.type} · {entry.result ?? "recorded"} · {evidenceSource ? `by ${sourceName(evidenceSource, drawerAmbiguousFamilies)}` : "Manual"} · {relative(entry.createdAt)}</small></span></div>; }) : <p className="muted">No evidence attached yet.</p>)}</div><form className="drawer-note" onSubmit={(event) => { event.preventDefault(); if (!noteText.trim()) return; note(noteText.trim()); setNoteText(""); }}><input value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="Add a progress update…"/><button disabled={!noteText.trim() || busy}>Add</button></form></aside></div>;
}

function CommandDialog({ projects, currentProject, initialMode = "search", busy, close, create }: { projects: Project[]; currentProject: string; initialMode?: "search" | "project"; busy: boolean; close: () => void; create: (input: { name: string; description: string; gitRemote: string }) => Promise<CommandResult> }) {
  const [mode, setMode] = useState<"search" | "project">(initialMode);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [github, setGithub] = useState<GithubStatus | null>(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [repoQuery, setRepoQuery] = useState("");
  const [linkedRepo, setLinkedRepo] = useState<GithubRepo | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [collision, setCollision] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (mode !== "project") return;
    void (async () => {
      const response = await fetch("/api/github", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json() as { data?: GithubStatus };
      setGithub(body.data ?? null);
      if (!body.data?.connected) return;
      const repoResponse = await fetch("/api/github/repos", { cache: "no-store" });
      const repoBody = await repoResponse.json() as { data?: GithubRepo[]; error?: { message?: string } };
      if (repoResponse.ok) setRepos(repoBody.data ?? []);
      else setRepoError(repoBody.error?.message ?? "Could not load your repositories");
    })();
  }, [mode]);

  function pickRepo(repo: GithubRepo) {
    setLinkedRepo(repo);
    setRepoQuery("");
    // Prefill rather than overwrite: whatever the person already typed wins.
    setName((current) => current.trim() || repo.name);
    setDescription((current) => current.trim() || repo.description);
    if (error) setError(null);
  }

  /** Appends -2, -3, ... so "create it anyway" produces a name that no longer collides. */
  function distinctName(base: string) {
    const taken = new Set(projects.map((project) => project.name.trim().toLowerCase()));
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // Previously this was `name.trim() && create(...)`, so an empty name silently did
    // nothing at all. Never fail silently: say what is missing.
    if (!name.trim()) { setError("Give the project a name to continue."); return; }
    const result = await create({ name: name.trim(), description: description.trim(), gitRemote: linkedRepo?.htmlUrl ?? "" });
    // A name collision is only a guess at sameness, so it comes back for a decision
    // rather than quietly reusing someone else's project or making a confusing twin.
    if (result.status === "uncertain" && result.project) setCollision({ id: result.project.id, name: result.project.name });
  }

  const visibleRepos = (repos ?? []).filter((repo) => !repoQuery.trim() || repo.fullName.toLowerCase().includes(repoQuery.trim().toLowerCase())).slice(0, 6);

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="command-dialog" role="dialog" aria-modal="true" aria-label={mode === "project" ? "Create a project" : "Command palette"}>
      {mode === "project"
        ? <>
          <header className="dialog-heading"><strong>Create a project</strong><button type="button" className="icon-button" onClick={close} aria-label="Close">×</button></header>
          <form className="project-form" onSubmit={submit}>
            <label>Project name
              <input autoFocus value={name} onChange={(event) => { setName(event.target.value); if (error) setError(null); }} placeholder="Planbraid" aria-invalid={error ? true : undefined} />
            </label>
            {error && <span className="field-error">{error}</span>}
            <label><span className="label-row">Description <span className="label-optional">optional</span></span>
              <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this project covers" />
            </label>
            {github?.configured && <div className="repo-link">
              {linkedRepo
                ? <div className="repo-linked"><span><GithubMark /><strong>{linkedRepo.fullName}</strong></span><button type="button" onClick={() => setLinkedRepo(null)}>Remove</button></div>
                : github.connected
                  ? <>
                    <span className="label-row">GitHub repository <span className="label-optional">optional</span></span>
                    <input value={repoQuery} onChange={(event) => setRepoQuery(event.target.value)} placeholder={repos ? "Search your repositories" : "Loading repositories…"} disabled={!repos} />
                    {repoError && <span className="field-error">{repoError}</span>}
                    {repos && <div className="repo-options">{visibleRepos.length ? visibleRepos.map((repo) => <button type="button" key={repo.id} onClick={() => pickRepo(repo)}><GithubMark /><span><strong>{repo.fullName}</strong><small>{repo.private ? "Private" : "Public"}{repo.description ? ` · ${repo.description}` : ""}</small></span></button>) : <p className="oauth-help">No repositories match. Adjust which ones the app can see from GitHub.</p>}</div>}
                  </>
                  : <a className="repo-connect" href="/api/github/connect"><GithubMark /> Connect GitHub to pick a repository</a>}
            </div>}
            {collision && <div className="collision-prompt">
              <strong>&ldquo;{collision.name}&rdquo; already exists</strong>
              <p>Is this the same project? Reusing it keeps every agent on one plan.</p>
              <span>
                <a className="primary-wide" href={`/?project=${collision.id}`}>Yes, open it</a>
                <button type="button" className="secondary-wide" disabled={busy} onClick={() => { const next = distinctName(name.trim()); setName(next); setCollision(null); void create({ name: next, description: description.trim(), gitRemote: linkedRepo?.htmlUrl ?? "" }); }}>No, create &ldquo;{distinctName(name.trim())}&rdquo;</button>
              </span>
            </div>}
            <span className="field-hint">Connect an agent from this project and it binds its own folder automatically, so you never have to type a path.</span>
            <button className="primary-wide" disabled={busy || Boolean(collision)}>{busy ? "Creating…" : "Create project"}</button>
          </form>
        </>
        : <>
          <header><span>⌕</span><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Type a command or project…" /><kbd>esc</kbd></header>
          <div className="command-results">
            <button onClick={() => setMode("project")}><span>＋</span><b>Create a new project</b><small>Track work across every connected agent</small></button>
            {projects.filter((project) => !search.trim() || `${project.name} ${project.description} ${project.directory}`.toLowerCase().includes(search.trim().toLowerCase())).map((project) => <a href={`/?project=${project.id}`} key={project.id} className={project.id === currentProject ? "current" : ""}><span className="project-glyph">{project.name[0]}</span><b>Open {project.name}</b><small>{project.directory || project.description}</small></a>)}
          </div>
        </>}
    </div>
  </div>;
}

function SetupDialog({ project, close, toast }: { project: Project | null; close: () => void; toast: (message: string) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"oauth" | "token">("oauth");
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [oauthConnections, setOauthConnections] = useState<McpConnection[]>([]);
  const [revokingOAuthId, setRevokingOAuthId] = useState<string | null>(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("");
  // The label this connection stamps on its work. Two CLI aliases for one model share a
  // credential unless you give them separate ones, so this is what tells them apart.
  const [agentMarker, setAgentMarker] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function copy(key: string, text: string, message: string) {
    void navigator.clipboard.writeText(text);
    toast(message);
    setCopiedKey(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedKey(null), 5000);
  }
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || Notification.permission !== "granted") return;
      const registration = await navigator.serviceWorker.getRegistration("/sw.js");
      const subscription = await registration?.pushManager.getSubscription();
      if (!cancelled && subscription) setPushEnabled(true);
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch("/api/oauth-connections", { headers: { accept: "application/json" } });
      const body = await response.json() as { data?: McpConnection[] };
      if (!cancelled && response.ok) setOauthConnections(body.data ?? []);
    })();
    return () => { cancelled = true; };
  }, []);
  const loadConnections = useCallback(async () => {
    const response = await fetch("/api/tokens", { headers: { accept: "application/json" } });
    const body = await response.json() as { data?: McpConnection[] };
    if (response.ok) setConnections(body.data ?? []);
  }, []);
  async function generate() {
    setBusy(true);
    try {
      // The name is how the connection identifies itself in every event it later
      // records, so it is worth letting people write one instead of stamping them all
      // with the same generated string and leaving two logins indistinguishable.
      const response = await fetch("/api/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: tokenName.trim() || `${project?.name ?? "Project"} coding agents` }) });
      const body = await response.json() as { data?: { token: string }; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Could not generate an agent token");
      setToken(body.data?.token ?? "");
      await loadConnections();
    } catch (error) { toast(error instanceof Error ? error.message : "Could not generate an agent token"); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setRevokingId(id);
    try {
      const response = await fetch("/api/tokens", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Could not revoke this connection");
      setConnections((current) => current.filter((entry) => entry.id !== id));
      toast("MCP connection revoked");
    } catch (error) { toast(error instanceof Error ? error.message : "Could not revoke this connection"); }
    finally { setRevokingId(null); }
  }
  async function renameOAuth(id: string, name: string) {
    if (!name.trim()) return;
    try {
      const response = await fetch("/api/oauth-connections", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, name: name.trim() }) });
      const body = await response.json() as { data?: { name: string }; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Could not rename this connection");
      setOauthConnections((current) => current.map((entry) => entry.id === id ? { ...entry, name: body.data?.name ?? name.trim() } : entry));
      setRenamingId(null);
      toast("Connection renamed");
    } catch (error) { toast(error instanceof Error ? error.message : "Could not rename this connection"); }
  }
  async function revokeOAuth(id: string) {
    setRevokingOAuthId(id);
    try {
      const response = await fetch("/api/oauth-connections", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Could not revoke this connection");
      setOauthConnections((current) => current.filter((entry) => entry.id !== id));
      toast("OAuth connection revoked");
    } catch (error) { toast(error instanceof Error ? error.message : "Could not revoke this connection"); }
    finally { setRevokingOAuthId(null); }
  }
  async function alerts() {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return toast("This browser does not support Web Push");
    if (pushEnabled) {
      try {
        const registration = await navigator.serviceWorker.getRegistration("/sw.js");
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          await fetch("/api/push/subscriptions", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
          await subscription.unsubscribe();
        }
        setPushEnabled(false);
        toast("Push alerts disabled");
      } catch (error) { toast(error instanceof Error ? error.message : "Could not disable push alerts"); }
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return toast("Notification permission was not enabled");
      await navigator.serviceWorker.register("/sw.js");
      const keyResponse = await fetch("/api/push/key", { cache: "no-store" });
      const keyBody = await keyResponse.json() as { data?: { publicKey?: string }; error?: { message?: string } };
      if (!keyResponse.ok || !keyBody.data?.publicKey) throw new Error(keyBody.error?.message ?? "Web Push is not configured");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlKey(keyBody.data.publicKey) });
      const saveResponse = await fetch("/api/push/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: subscription.toJSON(), mode: "all_interactions" }) });
      if (!saveResponse.ok) throw new Error("The browser subscription could not be saved");
      setPushEnabled(true);
      toast("Push alerts enabled - even when Planbraid is closed");
    } catch (error) { toast(error instanceof Error ? error.message : "Could not enable push alerts"); }
  }
  const baseEndpoint = typeof location !== "undefined" ? `${location.origin}/mcp` : "/mcp";
  // A per-alias marker rides on the URL rather than in a header, because the URL is the
  // one part of an MCP server entry every client lets you edit by hand.
  const marker = agentMarker.trim();
  const endpoint = marker ? `${baseEndpoint}?agent=${encodeURIComponent(marker)}` : baseEndpoint;
  const oauthConfig = JSON.stringify({ mcpServers: { planbraid: { type: "http", url: endpoint } } }, null, 2);
  const tokenConfig = JSON.stringify({ mcpServers: { planbraid: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${token || "<PLANBRAID_TOKEN>"}` } } } }, null, 2);
  const markerField = <label className="agent-marker"><span>Label this connection <span className="label-optional">optional</span></span><input value={agentMarker} onChange={(event) => setAgentMarker(event.target.value)} placeholder="work" maxLength={60} /><small>Running the same model under two logins? Give each its own label and Planbraid will tell their work apart instead of showing both as one agent.</small></label>;
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="setup-dialog" role="dialog" aria-modal="true" aria-label="Connect coding agents">
      <header><span><small>REMOTE MCP ACCESS</small><h2>Connect Planbraid to an agent</h2></span><button className="icon-button" onClick={close} aria-label="Close connection setup">×</button></header>
      <div className="setup-body">
      <p>Connect any MCP-compatible client to Planbraid - hosted coding agents, local model runners, custom tools, or personal models. Planbraid does not restrict which provider or model you use.</p>
      {!project && <div className="connection-scope-note"><strong>No project required</strong><span>This connection belongs to your Planbraid account. Your agent can create a project or connect work to one later.</span></div>}
      <div className="connection-tabs" role="tablist" aria-label="MCP authentication method"><button role="tab" aria-selected={mode === "oauth"} className={mode === "oauth" ? "active" : ""} onClick={() => setMode("oauth")}><strong>OAuth</strong><small>Recommended</small></button><button role="tab" aria-selected={mode === "token"} className={mode === "token" ? "active" : ""} onClick={() => { setMode("token"); void loadConnections(); }}><strong>Access token</strong><small>Standard MCP config</small></button></div>
      {mode === "oauth" ? <section className="oauth-setup-card connection-panel" role="tabpanel">
        <header><span><span className="oauth-lock">✓</span><strong>Automatic OAuth access</strong></span></header>
        <ol><li>Open your client&apos;s <strong>MCP servers</strong> or <strong>Connectors</strong> settings.</li><li>Add a remote HTTP server and paste the Planbraid URL below.</li><li>Your client opens Planbraid in a browser. Sign in and approve read/write access.</li></ol>
        <div className="endpoint-box"><small>Remote MCP server URL</small><code>{endpoint}</code><button onClick={() => copy("endpoint", endpoint, "MCP URL copied")}>{copiedKey === "endpoint" ? "Copied" : "Copy URL"}</button></div>
        {markerField}<div className="config-box"><span><small>Common MCP JSON configuration</small><button onClick={() => copy("oauthConfig", oauthConfig, "OAuth MCP config copied")}>{copiedKey === "oauthConfig" ? "Copied" : "Copy config"}</button></span><pre>{oauthConfig}</pre></div>
        <p className="oauth-help">Planbraid uses standard MCP and OAuth discovery. The connected client identifies its own provider, session, and optional model when it begins reporting work.</p>
        <div className="connection-list"><h3>Connected apps <span>{oauthConnections.length}</span></h3>{oauthConnections.length ? oauthConnections.map((entry) => <div className="connection-row" key={entry.id}>{renamingId === entry.id
          ? <form className="connection-rename" onSubmit={(event) => { event.preventDefault(); void renameOAuth(entry.id, renameDraft); }}><input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} maxLength={60} aria-label={`Rename ${entry.name}`} /><button type="submit">Save</button><button type="button" onClick={() => setRenamingId(null)}>Cancel</button></form>
          : <><span><strong>{entry.name}</strong><small>{entry.lastUsedAt ? `Last used ${relative(entry.lastUsedAt)}` : "Not used yet"} · {entry.scopes.join(", ")}</small></span><button onClick={() => { setRenamingId(entry.id); setRenameDraft(entry.name); }}>Rename</button><button onClick={() => void revokeOAuth(entry.id)} disabled={revokingOAuthId === entry.id}>{revokingOAuthId === entry.id ? "Revoking…" : "Revoke"}</button></>}</div>) : <p className="oauth-help">No connected apps yet.</p>}</div>
      </section> : <section className="token-setup-card connection-panel" role="tabpanel">
        <header><span><span className="token-key">⌁</span><strong>Bearer token access</strong></span></header>
        <p>For clients without OAuth, create a personal token and send it in the <code>Authorization</code> header. The secret is shown only once.</p>
        {token ? <><div className="token-box"><small>New token - copy it now</small><code>{token}</code><button onClick={() => copy("token", token, "Token copied")}>{copiedKey === "token" ? "Copied" : "Copy"}</button></div><div className="config-box"><span><small>Common MCP JSON configuration</small><button onClick={() => copy("tokenConfig", tokenConfig, "Token MCP config copied")}>{copiedKey === "tokenConfig" ? "Copied" : "Copy config"}</button></span><pre>{tokenConfig}</pre></div></> : <><label className="agent-marker"><span>Name this connection <span className="label-optional">optional</span></span><input value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder={`${project?.name ?? "Project"} coding agents`} maxLength={60} /><small>This name is what Planbraid shows against everything the connection records.</small></label>{markerField}<button className="primary-wide" onClick={() => void generate()} disabled={busy}>{busy ? "Generating…" : `Generate access token for ${project?.name ?? "Planbraid"}`}</button></>}
        <div className="connection-list"><h3>Active token connections <span>{connections.length}</span></h3>{connections.length ? connections.map((entry) => <div className="connection-row" key={entry.id}><span><strong>{entry.name}</strong><small>{entry.lastUsedAt ? `Last used ${relative(entry.lastUsedAt)}` : "Not used yet"} · {entry.scopes.join(", ")}</small></span><button onClick={() => void revoke(entry.id)} disabled={revokingId === entry.id}>{revokingId === entry.id ? "Revoking…" : "Revoke"}</button></div>) : <p className="oauth-help">No active bearer-token connections.</p>}</div>
      </section>}
      <div className="access-note"><strong>Network access required</strong><span>The MCP URL must be reachable by the agent without a hosting-level sign-in wall. Planbraid still protects every project request with OAuth or a bearer token.</span></div>
      <button className={`secondary-wide push-toggle ${pushEnabled ? "is-on" : "is-off"}`} onClick={() => void alerts()}>{pushEnabled ? "Disable browser alerts" : "Enable browser alerts"}</button>
      <div className="setup-note"><strong>Per-turn synchronization</strong><span>Connected agents can read current project state, record todo lifecycle changes, and reconcile every completed interaction.</span></div>
      </div>
    </div>
  </div>;
}

function ProviderIcon({ provider }: { provider: Provider | string }) {
  const key = providerFamily(provider);
  const bundledLogo = providerLogo[key];
  const logo = typeof bundledLogo === "string" ? bundledLogo : bundledLogo?.src;
  const label = labelFor(provider);
  // These are tiny bundled SVG marks; an image optimizer would add overhead without reducing payload.
  // No family match at all (an agent name nobody has mapped yet) gets its own modifier
  // class so the fallback diamond can be styled larger and centered, rather than reusing
  // the tight sizing built for an actual logo image.
  return <span className={`provider-icon ${key === "google" || logo ? key : "unknown"}`} role="img" aria-label={`${label} logo`} title={label}>{key === "google" ? <GoogleIcon /> : logo ? <img src={logo} alt="" aria-hidden="true" /> : <span className="provider-fallback" aria-hidden="true">◇</span>}</span>; // eslint-disable-line @next/next/no-img-element
}
/** Which agent account(s) proposed a task: one logo for a single proposer, overlapping
 * logos when more than one did. Two logos can be the same model under two accounts, so
 * the tooltip is what disambiguates, hence the account name rather than just the model. */
function ProviderStack({ accounts, ambiguousFamilies }: { accounts: ProposingAccount[]; ambiguousFamilies: Set<string> }) {
  const names = accounts.map((account) => accountName(account, ambiguousFamilies)).join(", ");
  const title = accounts.length > 1 ? `Proposed by ${names}` : `Suggested by ${names}`;
  return <span className="provider-stack" title={title}>{accounts.map((account) => <ProviderIcon key={account.accountId ?? account.family} provider={account.provider} />)}</span>;
}
function Assurance({ value }: { value: Source["assurance"] }) { return <span className={`assurance ${value}`} title={`Capture assurance: ${value}`}>{value === "enforced" ? "✓" : value === "observed" ? "◉" : value === "instructed" ? "↗" : "○"}</span>; }
function Empty({ title, body, action, onAction, secondaryAction, onSecondaryAction }: { title: string; body: string; action?: string; onAction?: () => void; secondaryAction?: string; onSecondaryAction?: () => void }) { return <div className="empty-state"><span>☷</span><h3>{title}</h3><p>{body}</p><div className="empty-actions">{action && onAction && <button onClick={onAction}>{action}</button>}{secondaryAction && onSecondaryAction && <button className="secondary" onClick={onSecondaryAction}>{secondaryAction}</button>}</div></div>; }
function relative(value: string) { const delta = Date.now() - new Date(value).getTime(); const minutes = Math.max(0, Math.floor(delta / 60000)); if (minutes < 1) return "now"; if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h`; return `${Math.floor(hours / 24)}d`; }
function eventAction(event: string) { return ({ "work_item.created": "created work", "work_item.started": "started work", "work_item.blocked": "reported a blocker", "work_item.completion_reported": "requested review", "work_item.completion_verified": "completed work", "work_item.progress_reported": "shared progress", "interaction.completed": "completed a turn", "evidence.attached": "attached evidence" } as Record<string, string>)[event] ?? event.replaceAll("_", " ").replace("work item.", ""); }
function eventTone(event: WorkEvent) { if (event.eventType.includes("unblocked")) return "success"; if (event.eventType.includes("blocked") || event.eventType.includes("failed")) return "danger"; if (event.eventType.includes("verified") || event.toStatus === "done") return "success"; if (event.eventType.includes("review")) return "review"; return "normal"; }
async function showSystemNotification(title: string, body: string) { if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState === "visible") return; const registration = await navigator.serviceWorker.ready; await registration.showNotification(title, { body, icon: "/planbraid-mark.png", badge: "/planbraid-mark.png", tag: `planbraid-${title}`, data: { url: "/" } }); }
function base64UrlKey(value: string) { const padded = value + "=".repeat((4 - value.length % 4) % 4); const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/")); const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index); return bytes.buffer; }
