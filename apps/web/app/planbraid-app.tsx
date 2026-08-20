"use client";

/* Dialog backdrops are non-interactive presentation layers; every dialog includes a keyboard-accessible close button. */
/* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/no-autofocus */

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { authClient } from "@/lib/auth-client";
import { firstValidationMessage, passwordSchema } from "@/lib/auth-validation";
import { GoogleIcon } from "@/app/google-icon";
import { ALLOWED_TRANSITIONS, type Command, type DashboardState, type Notification, type Project, type Provider, type Source, type WorkEvent, type WorkItem, type WorkStatus } from "@/lib/contracts";
import { deriveColumn, isStartedWhileBlocked } from "@/lib/graph/column.ts";
import { DAG_EDGE_TYPES } from "@/lib/graph/edges.ts";
import { accountDisplayName, labelFor, providerFamily } from "@/lib/providers.ts";
import { confidenceOf } from "@/lib/trust/confidence.ts";
import { provenanceLabel } from "@/lib/trust/provenance.ts";
import claudeLogo from "@lobehub/icons-static-svg/icons/claude-color.svg";
import codexLogo from "@lobehub/icons-static-svg/icons/codex-color.svg";
import copilotLogo from "@lobehub/icons-static-svg/icons/copilot-color.svg";
import cursorLogo from "@lobehub/icons-static-svg/icons/cursor.svg";
import geminiLogo from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import openAILogo from "@lobehub/icons-static-svg/icons/openai.svg";
import windsurfLogo from "@lobehub/icons-static-svg/icons/windsurf.svg";

type View = "stream" | "board" | "proposals" | "decisions" | "list" | "inbox" | "agents";
type Theme = "dark" | "light";
type McpConnection = { id: string; name: string; scopes: string[]; lastUsedAt: string | null; createdAt: string };
type CommandResult = { projectId?: string; status?: "created" | "matched" | "uncertain"; matchedOn?: string; project?: { id: string; name: string } };
type GithubStatus = { connected: boolean; login: string | null; configured: boolean };
type GithubRepo = { id: number; name: string; fullName: string; description: string; htmlUrl: string; cloneUrl: string; private: boolean; updatedAt: string };
type BundledLogo = string | { src: string };
type FindingKind = "duplicate" | "possible_duplicate" | "redundant_done" | "conflicting_work" | "blocked_chain" | "cycle" | "started_while_blocked" | "stale" | "do_first" | "planning_loop" | "possibly_implemented" | "evidence_removed" | "agent_flagged";
type SimplifyFinding = { id: string; kind: FindingKind; workItemId: string; relatedWorkItemId?: string; verdict: "certain" | "possible" | "informational"; reason: string; detail: string; proposedCommand?: unknown; origin: string; agreedBy: string[]; status: "open" | "applied" | "dismissed" };
type SimplifyRun = { id: string; projectId: string; status: string; requestedBy: string; createdAt: string; findings: SimplifyFinding[] };
type DecisionOption = { id: string; label: string; relatedWorkItemId: string | null; rationale: string; status: "open" | "accepted" | "rejected" };
type Decision = { workItemId: string; itemKey: string; question: string; status: string; options: DecisionOption[] };
type DebtEntry = { findingId: string; kind: string; weight: number; workItemId: string; itemKey: string | null; title: string | null; reason: string };
type PlanningHealth = { debt: DebtEntry[]; totalWeight: number; score: number; breakdown: Array<{ kind: string; count: number; weight: number }> };
type SavedViewName = "active" | "blocking_release" | "keeps_getting_proposed" | "no_proof" | "needs_decision";
type SavedViewItem = { itemKey: string; workItemId: string; title: string; detail: string };
type PlanStep = WorkItem & { reason: string; corroboration: number; depth: number; slack: number; critical: boolean };
type PlanWave = { wave: number; items: PlanStep[] };
type StuckItem = WorkItem & { reason: string };
type ExecutionPlan = { waves: PlanWave[]; stuck: StuckItem[]; criticalPath: Array<Pick<WorkItem, "id" | "itemKey" | "title">> };
const SAVED_VIEW_LABELS: Record<SavedViewName, string> = { active: "Active", blocking_release: "Blocking release", keeps_getting_proposed: "Keeps getting proposed", no_proof: "No proof", needs_decision: "Needs a decision" };

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

/** Why a finished item finished the way it did. "Cancelled" alone never distinguished a
 * rejected approach from one that is merely waiting for a better week. */
const resolutionLabel: Record<string, string> = {
  completed: "Completed", rejected: "Rejected", deferred: "Deferred", superseded: "Superseded",
  duplicate: "Duplicate", abandoned: "Abandoned", obsolete: "No longer relevant", unspecified: "No reason recorded",
};

/** An item nobody has accepted yet. Both unaccepted rungs read the same on a card. */
function isProposal(item: WorkItem) {
  return item.maturity === "proposal" || item.maturity === "idea";
}
// Logos stay here rather than in lib/providers.ts: they are bundler-resolved asset
// imports, and that module is imported by server code that must not pull in SVG assets.
const providerLogo: Record<string, BundledLogo> = {
  codex: codexLogo, openai: openAILogo, chatgpt: openAILogo, claude: claudeLogo, anthropic: claudeLogo,
  gemini: geminiLogo, copilot: copilotLogo, github_copilot: copilotLogo, cursor: cursorLogo, windsurf: windsurfLogo,
};

function requestId(prefix = "ui") { return `${prefix}-${crypto.randomUUID()}`; }

/** Reads the theme the blocking script in layout.tsx already stamped on <html> before
 * hydration, so this component's first render agrees with what actually painted
 * instead of assuming "dark" and correcting itself a moment later. Server-rendered
 * HTML has no document, so it falls back to "dark" there - <html> already carries
 * suppressHydrationWarning for exactly this client/server difference. */
function initialTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  const attr = document.documentElement.dataset.theme;
  return attr === "light" || attr === "dark" ? attr : "dark";
}

const NAV_STORAGE_KEY = "planbraid-last-nav";
const VIEWS: readonly View[] = ["stream", "board", "proposals", "decisions", "list", "inbox", "agents"];

/** Restores the project and tab a reload lands back on. Scoped to sessionStorage rather
 * than localStorage on purpose: a page script has no way to tell a cache-bypassing
 * reload from an ordinary one (both report the same PerformanceNavigationTiming type),
 * so "same tab, however it got refreshed" is the closest thing to "soft refresh" that is
 * actually detectable - and it is sessionStorage's own boundary for free, since a fresh
 * tab or window starts with nothing stored and falls back to the welcome screen exactly
 * as refresh() below already guarantees once the loaded project list confirms an id. */
function initialNav(): { projectId: string; view: View } {
  if (typeof window === "undefined") return { projectId: "", view: "stream" };
  try {
    const raw = window.sessionStorage.getItem(NAV_STORAGE_KEY);
    if (!raw) return { projectId: "", view: "stream" };
    const parsed = JSON.parse(raw) as { projectId?: string; view?: string };
    const view = VIEWS.includes(parsed.view as View) ? (parsed.view as View) : "stream";
    return { projectId: parsed.projectId ?? "", view };
  } catch { return { projectId: "", view: "stream" }; }
}

type ProposingAccount = { provider: string; family: string; accountId: string | null; accountLabel: string | null };

/**
 * How the UI decides two sessions are "the same proposer". Keyed on the account's name
 * rather than its id: two credentials the owner gave the same name are one account as
 * far as a reader is concerned, and rendering the same label twice in a row reads as a
 * bug. Sessions predating agent accounts have no label and fall back to the model, which
 * is how they always deduped.
 */
function accountKeyOf(source: Source) {
  const family = providerFamily(source.provider);
  // An explicit label still groups by name (unchanged: two credentials the owner named
  // the same thing read as one account). With no label, every unlabeled account used to
  // fall into one shared "" bucket for that family, silently merging genuinely distinct
  // logins into a single display identity - the exact case that made two different
  // unlabeled Codex connections both render as plain "Codex" with nothing to tell them
  // apart. agentAccountId (falling back to the source's own id for pre-migration
  // sessions with neither) gives each one its own key instead.
  if (source.agentAccountLabel) return `${family}:${source.agentAccountLabel}`;
  return `${family}:${source.agentAccountId ?? source.id}`;
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
 * The qualifier is noise for the overwhelmingly common single-account case. `index`, when
 * given, names an unlabeled ambiguous account "Claude 2" instead of a bare, indistinct
 * "Claude" - only used when there is no label to disambiguate with instead. */
function accountName(account: ProposingAccount, ambiguousFamilies: Set<string>, index?: number) {
  if (!ambiguousFamilies.has(account.family)) return labelFor(account.provider);
  if (account.accountLabel) return accountDisplayName(account.provider, account.accountLabel);
  return index ? `${labelFor(account.provider)} ${index}` : labelFor(account.provider);
}

/** The same rule for a plain Source, which is what most of the UI actually holds. */
function sourceName(source: Source, ambiguousFamilies: Set<string>, accountIndex?: Map<string, number>) {
  return accountName({ provider: source.provider, family: providerFamily(source.provider), accountId: source.agentAccountId, accountLabel: source.agentAccountLabel }, ambiguousFamilies, accountIndex?.get(accountKeyOf(source)));
}

/** Stable per-family numbering for accounts with no explicit label to tell them apart:
 * "Codex 1", "Codex 2", assigned in the order the sources happen to be given. Only
 * families connected under more than one account need this at all (ambiguousFamilies);
 * a labeled account never receives a number since accountName prefers its label. */
function accountIndexOf(sources: Source[], ambiguousFamilies: Set<string>) {
  const index = new Map<string, number>();
  const nextByFamily = new Map<string, number>();
  for (const source of sources) {
    const family = providerFamily(source.provider);
    if (!ambiguousFamilies.has(family) || source.agentAccountLabel) continue;
    const key = accountKeyOf(source);
    if (index.has(key)) continue;
    const next = (nextByFamily.get(family) ?? 0) + 1;
    nextByFamily.set(family, next);
    index.set(key, next);
  }
  return index;
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
  const [projectId, setProjectId] = useState(() => initialNav().projectId);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => initialNav().view);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<WorkStatus | "all">("all");
  const [newUpdates, setNewUpdates] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  // Which pane the palette opens on: "New project" and the empty state go straight to
  // the form rather than making people find "Create a new project" in a list first.
  const [commandOpen, setCommandOpen] = useState<false | "search" | "project">(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [simplifyRun, setSimplifyRun] = useState<SimplifyRun | null>(null);
  const [simplifying, setSimplifying] = useState(false);
  const [handoffText, setHandoffText] = useState<string | null>(null);
  const [handoffLoading, setHandoffLoading] = useState(false);
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [decisionsLoading, setDecisionsLoading] = useState(false);
  const [health, setHealth] = useState<PlanningHealth | null>(null);
  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [activeSavedView, setActiveSavedView] = useState<SavedViewName>("active");
  const [savedViewItems, setSavedViewItems] = useState<SavedViewItem[] | null>(null);
  const [savedViewLoading, setSavedViewLoading] = useState(false);
  const [resolvingDecision, setResolvingDecision] = useState<string | null>(null);
  const [applyingFinding, setApplyingFinding] = useState<string | null>(null);
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
      // A selection restored from sessionStorage (or just picked) is only honored if the
      // project still exists: deleted, or a stale id left over from a much older session,
      // both fall back to the welcome screen rather than a broken-looking selected-but-
      // gone state. This same check is what makes a background refresh never interrupt
      // actually working in a project - it re-validates, not re-picks.
      setProjectId((current) => (current && state.projects.some((project) => project.id === current)) ? current : "");
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Planbraid could not load");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Persists the last project/tab so an ordinary reload picks up where it left off; see
  // initialNav's own note on why sessionStorage (not localStorage) is the right scope.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!projectId) { window.sessionStorage.removeItem(NAV_STORAGE_KEY); return; }
    window.sessionStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ projectId, view }));
  }, [projectId, view]);

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

  // theme's own useState initializer (below) already reads the value the blocking
  // script in layout.tsx set on <html> before hydration, so there is nothing left to
  // correct here on mount. There used to be: a two-effect "read saved value, then
  // write it back" dance where the write effect's first run fired with the hardcoded
  // "dark" default (effects run with the render's own state, not a later setState's
  // result), overwriting a saved "light" preference in localStorage with "dark" before
  // the read effect's correction landed. Usually invisible because the very next
  // commit wrote the correct value straight back - except under React's development
  // Strict Mode double-invoke, where the second mount's read effect read back the
  // already-corrupted "dark" and locked it in. This effect still exists to persist
  // theme when the user actually toggles it.
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
  // Removed sessions stay available for historical provider/name attribution. Only the
  // connected-agent surfaces hide them; reconnecting the same session restores it.
  const projectSources = useMemo(() => (data?.sources ?? []).filter((source) => source.projectId === projectId), [data, projectId]);
  const sources = useMemo(() => projectSources.filter((source) => source.status !== "removed"), [projectSources]);
  const proposals = useMemo(() => projectItems.filter((item) => isProposal(item) && !["done", "cancelled"].includes(item.status)), [projectItems]);
  // With gating on, unaccepted work leaves the board and lives in the Proposals queue
  // instead. Off by default, so an existing project's board is unchanged until someone
  // turns it on. See PLANNING_INTELLIGENCE_ROADMAP.md §9 decision 2.
  const decidedItems = useMemo(() => project?.gateProposals ? projectItems.filter((item) => !isProposal(item)) : projectItems, [projectItems, project?.gateProposals]);
  const filteredItems = useMemo(() => decidedItems.filter((item) => (!sourceId || item.sourceId === sourceId) && (statusFilter === "all" || deriveColumn(item) === statusFilter) && (!query || `${item.itemKey} ${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase()))), [decidedItems, sourceId, statusFilter, query]);
  const events = useMemo(() => (data?.events ?? []).filter((event) => {
    if (event.projectId !== projectId || (sourceId && event.sourceId !== sourceId) || (query && !event.summary.toLowerCase().includes(query.toLowerCase()))) return false;
    if (statusFilter === "all") return true;
    const item = projectItems.find((entry) => entry.id === event.workItemId);
    return item ? deriveColumn(item) === statusFilter : false;
  }), [data, projectId, sourceId, query, statusFilter, projectItems]);
  const selectedItem = data?.workItems.find((item) => item.id === selectedItemId) ?? null;
  // Scoped to the open project: the Inbox tab it badges only ever shows this project's own
  // notifications (see the view === "inbox" render below), so an account-wide count here
  // showed a badge for work in other projects entirely, with nothing behind it to click.
  const unread = data?.notifications.filter((notification) => !notification.readAt && notification.projectId === projectId).length ?? 0;

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

  async function runSimplify() {
    setSimplifying(true);
    try {
      const response = await fetch("/api/simplify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId }) });
      const body = await response.json() as { data?: SimplifyRun; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Could not review this plan");
      setSimplifyRun(body.data ?? null);
    } catch (caught) { setToast(caught instanceof Error ? caught.message : "Could not review this plan"); setTimeout(() => setToast(null), 4000); }
    finally { setSimplifying(false); }
  }

  async function runHandoff() {
    setHandoffLoading(true);
    try {
      const response = await fetch(`/api/handoff?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const body = await response.json() as { data?: { text: string }; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Could not prepare a handoff");
      setHandoffText(body.data.text);
    } catch (caught) { setToast(caught instanceof Error ? caught.message : "Could not prepare a handoff"); setTimeout(() => setToast(null), 4000); }
    finally { setHandoffLoading(false); }
  }

  async function runHealth() {
    setHealthLoading(true);
    try {
      const response = await fetch(`/api/health?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const body = await response.json() as { data?: PlanningHealth; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Could not compute planning health");
      setHealth(body.data);
    } catch (caught) { setToast(caught instanceof Error ? caught.message : "Could not compute planning health"); setTimeout(() => setToast(null), 4000); }
    finally { setHealthLoading(false); }
  }

  async function runPlan() {
    setPlanLoading(true);
    try {
      const response = await fetch(`/api/plan?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const body = await response.json() as { data?: ExecutionPlan; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Could not compute an execution plan");
      setPlan(body.data);
    } catch (caught) { setToast(caught instanceof Error ? caught.message : "Could not compute an execution plan"); setTimeout(() => setToast(null), 4000); }
    finally { setPlanLoading(false); }
  }

  const loadSavedView = useCallback(async (view: SavedViewName) => {
    if (!projectId) return;
    setSavedViewLoading(true);
    try {
      const response = await fetch(`/api/views?projectId=${encodeURIComponent(projectId)}&view=${view}`, { cache: "no-store" });
      const body = await response.json() as { data?: { items: SavedViewItem[] }; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Could not load this view");
      setSavedViewItems(body.data?.items ?? []);
    } catch (caught) { setToast(caught instanceof Error ? caught.message : "Could not load this view"); setTimeout(() => setToast(null), 4000); }
    finally { setSavedViewLoading(false); }
  }, [projectId]);

  useEffect(() => { if (viewsOpen) void loadSavedView(activeSavedView); }, [viewsOpen, activeSavedView, loadSavedView]);

  const loadDecisions = useCallback(async () => {
    if (!projectId) return;
    setDecisionsLoading(true);
    try {
      const response = await fetch(`/api/decisions?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const body = await response.json() as { data?: Decision[]; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Could not load decisions");
      setDecisions(body.data ?? []);
    } catch (caught) { setToast(caught instanceof Error ? caught.message : "Could not load decisions"); setTimeout(() => setToast(null), 4000); }
    finally { setDecisionsLoading(false); }
  }, [projectId]);

  useEffect(() => { if (view === "decisions") void loadDecisions(); }, [view, loadDecisions]);

  async function resolveDecisionChoice(decisionWorkItemId: string, winningOptionId: string) {
    setResolvingDecision(winningOptionId);
    try {
      const response = await fetch("/api/decisions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, decisionWorkItemId, winningOptionId }) });
      const body = await response.json() as { data?: Decision; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Could not resolve this decision");
      setDecisions((current) => current ? current.filter((entry) => entry.workItemId !== decisionWorkItemId) : current);
      setToast(`${body.data?.itemKey ?? "Decision"} resolved`);
      setTimeout(() => setToast(null), 4000);
      await refresh(true);
    } catch (caught) { setToast(caught instanceof Error ? caught.message : "Could not resolve this decision"); setTimeout(() => setToast(null), 4000); }
    finally { setResolvingDecision(null); }
  }

  async function resolveFinding(findingId: string, action: "apply" | "dismiss") {
    setApplyingFinding(findingId);
    try {
      const response = await fetch("/api/simplify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ findingId, action }) });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Could not apply this");
      // Drop it from the open list locally so the panel reacts immediately, then refresh
      // the board underneath it.
      setSimplifyRun((current) => current ? { ...current, findings: current.findings.map((finding) => finding.id === findingId ? { ...finding, status: action === "apply" ? "applied" : "dismissed" } : finding) } : current);
      if (action === "apply") await refresh(true);
    } catch (caught) { setToast(caught instanceof Error ? caught.message : "Could not apply this"); setTimeout(() => setToast(null), 4000); }
    finally { setApplyingFinding(null); }
  }

  function settleSidebarAfterSelection() {
    if (window.matchMedia("(max-width: 900px)").matches) setSidebarOpen(false);
  }

  if (loading && !data) return <LoadingShell />;
  if (error && !data) return <ErrorState message={error} retry={() => void refresh()} />;

  return (
    <main className={`app-shell ${sidebarOpen ? "sidebar-open" : ""}`}>
      <ProjectRail data={data!} avatarUrl={avatarUrl} selected={projectId} selectedSource={sourceId} sources={sources} onSelect={(id) => { setProjectId(id); setSourceId(null); setSelectedItemId(null); setStatusFilter("all"); setQuery(""); setView("stream"); settleSidebarAfterSelection(); }} onSource={(id) => { setSourceId(id); setStatusFilter("all"); setView("stream"); settleSidebarAfterSelection(); }} open={sidebarOpen} toggle={() => setSidebarOpen((open) => !open)} onNew={() => setCommandOpen("project")} onProfile={() => setProfileOpen(true)} command={command} busy={mutating} onOpenAccountSetup={() => setSetupOpen(true)} />
      <section className="workspace" aria-label="Unified project workspace">
        <Header project={project} itemCount={projectItems.length} sources={sources} unread={unread} proposalCount={proposals.length} decisionCount={decisions?.length ?? 0} view={view} setView={setView} query={query} setQuery={setQuery} theme={theme} toggleTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")} onSetup={() => setSetupOpen(true)} viewer={data!.viewer} avatarUrl={avatarUrl} onProfile={() => setProfileOpen(true)} />
        {project && view !== "inbox" && view !== "agents" && view !== "proposals" && view !== "decisions" && <FilterBar items={projectItems} filter={statusFilter} setFilter={setStatusFilter} source={sources.find((entry) => entry.id === sourceId) ?? null} clearSource={() => setSourceId(null)} onSimplify={() => void runSimplify()} simplifying={simplifying} onHandoff={() => void runHandoff()} handoffLoading={handoffLoading} onHealth={() => void runHealth()} healthLoading={healthLoading} onPlan={() => void runPlan()} planLoading={planLoading} onViews={() => setViewsOpen(true)} project={project} sources={sources} importRequests={data?.importRequests ?? []} onSetup={() => setSetupOpen(true)} toast={(message) => { setToast(message); setTimeout(() => setToast(null), 4000); }} />}
        {newUpdates > 0 && <button className="new-updates" onClick={() => { setNewUpdates(0); window.scrollTo({ top: 0, behavior: "smooth" }); }}>↑ {newUpdates} new {newUpdates === 1 ? "update" : "updates"}</button>}
        <div className="workspace-body">
          {!project && <Empty title={`Welcome back, ${data!.viewer.name}`} body={data!.projects.length ? "Pick a project from the sidebar, create a new one, or connect an agent to get started." : "Create a project for organized tracking, or connect an agent now and create the project from your MCP client."} action="Create project" onAction={() => setCommandOpen("project")} secondaryAction="Connect agent" onSecondaryAction={() => setSetupOpen(true)} />}
          {project && view === "stream" && <Stream events={events} items={projectItems} sources={projectSources} onItem={setSelectedItemId} />}
          {project && view === "board" && <Board items={filteredItems} sources={projectSources} aliases={data?.aliases ?? []} dependencies={data?.dependencies ?? []} onItem={setSelectedItemId} onTransition={(item, status) => void command({ action: "transition_item", projectId: item.projectId, itemId: item.id, expectedVersion: item.version, status, idempotencyKey: requestId("drag") }, `${item.itemKey} moved to ${statusMeta[status].label}`)} />}
          {project && view === "proposals" && <Proposals
            items={proposals} sources={projectSources} busy={mutating} gated={project.gateProposals} onItem={setSelectedItemId}
            onAccept={(item) => void command({ action: "set_maturity", projectId: item.projectId, itemIds: [item.id], maturity: "accepted", idempotencyKey: requestId("accept") }, `${item.itemKey} accepted`)}
            onAcceptAll={() => void command({ action: "set_maturity", projectId, itemIds: proposals.map((item) => item.id), maturity: "accepted", idempotencyKey: requestId("accept-all") }, `${proposals.length} proposal${proposals.length === 1 ? "" : "s"} accepted`)}
            onReject={(item) => void command({ action: "transition_item", projectId: item.projectId, itemId: item.id, expectedVersion: item.version, status: "cancelled", resolution: "rejected", reason: "Rejected from the proposals queue", idempotencyKey: requestId("reject") }, `${item.itemKey} rejected`)}
            onToggleGate={() => void command({ action: "update_project", projectId, gateProposals: !project.gateProposals, idempotencyKey: requestId("gate") }, project.gateProposals ? "Proposals now appear on the board again" : "Proposals are kept off the board until accepted")}
          />}
          {project && view === "decisions" && <Decisions decisions={decisions} loading={decisionsLoading} items={projectItems} resolvingOptionId={resolvingDecision} onResolve={resolveDecisionChoice} onItem={setSelectedItemId} />}
          {project && view === "list" && <ListView items={filteredItems} sources={projectSources} aliases={data?.aliases ?? []} onItem={setSelectedItemId} />}
          {project && view === "inbox" && <Inbox notifications={data!.notifications.filter((entry) => entry.projectId === projectId)} onOpen={(notification) => { if (notification.workItemId) setSelectedItemId(notification.workItemId); void command({ action: "mark_notification", notificationId: notification.id, read: true, idempotencyKey: requestId("read") }, "Notification marked read"); }} onResolve={(notification) => void command({ action: "mark_notification", notificationId: notification.id, read: true, resolved: true, idempotencyKey: requestId("resolve") }, "Action resolved")} />}
          {project && view === "agents" && <Agents sources={sources} items={projectItems} claims={data?.claims ?? []} busy={mutating} onSetup={() => setSetupOpen(true)} onDelete={(source) => void command({ action: "remove_source", projectId, sourceId: source.id, idempotencyKey: requestId("remove-source") }, `${sourceName(source, ambiguousFamiliesOf(sources))} removed from this project`)} />}
        </div>
        {project && view !== "inbox" && view !== "agents" && view !== "proposals" && <Composer project={project} sources={sources} busy={mutating} onCreate={(title, source) => void command({ action: "create_item", projectId, title, sourceId: source || undefined, status: "proposed", idempotencyKey: requestId("create") }, "Task added to the unified plan")} />}
      </section>
      {selectedItem && <TaskDrawer item={selectedItem} source={projectSources.find((entry) => entry.id === selectedItem.sourceId) ?? null} sources={projectSources} events={(data?.events ?? []).filter((event) => event.workItemId === selectedItem.id)} evidence={(data?.evidence ?? []).filter((entry) => entry.workItemId === selectedItem.id)} dependencies={(data?.dependencies ?? []).filter((entry) => entry.fromWorkItemId === selectedItem.id || entry.toWorkItemId === selectedItem.id)} aliases={(data?.aliases ?? []).filter((entry) => entry.workItemId === selectedItem.id)} allItems={projectItems} viewerName={data!.viewer.name} busy={mutating} hideNoteInput={Boolean(plan)} transparentBackdrop={Boolean(plan)} close={() => setSelectedItemId(null)} transition={(status, reason) => void command({ action: "transition_item", projectId: selectedItem.projectId, itemId: selectedItem.id, expectedVersion: selectedItem.version, status, reason, idempotencyKey: requestId("transition") }, `${selectedItem.itemKey} is now ${statusMeta[status].label}`)} note={(summary) => void command({ action: "add_note", projectId: selectedItem.projectId, itemId: selectedItem.id, summary, idempotencyKey: requestId("note") }, "Progress recorded")} splitAlias={(aliasId) => void command({ action: "split_alias", projectId: selectedItem.projectId, aliasId, idempotencyKey: requestId("split") }, "Moved back into its own task")} onItem={setSelectedItemId} linkDependencies={(prerequisiteIds) => { void (async () => { for (const prerequisiteId of prerequisiteIds) await command({ action: "add_dependency", projectId: selectedItem.projectId, fromWorkItemId: prerequisiteId, toWorkItemId: selectedItem.id, type: "blocks", idempotencyKey: requestId("link") }, "Dependency added"); })(); }} />}
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
      {simplifyRun && <SimplifyPanel run={simplifyRun} busy={applyingFinding} close={() => setSimplifyRun(null)} onApply={(findingId) => void resolveFinding(findingId, "apply")} onDismiss={(findingId) => void resolveFinding(findingId, "dismiss")} />}
      {handoffText && <HandoffDialog text={handoffText} close={() => setHandoffText(null)} toast={(message) => { setToast(message); setTimeout(() => setToast(null), 4000); }} />}
      {health && <HealthDialog health={health} close={() => setHealth(null)} onItem={(id) => { setHealth(null); setSelectedItemId(id); }} />}
      {plan && <PlanDialog plan={plan} sources={projectSources} allItems={projectItems} events={data?.events ?? []} evidence={data?.evidence ?? []} dependencies={data?.dependencies ?? []} aliases={data?.aliases ?? []} close={() => { setPlan(null); setSelectedItemId(null); }} onItem={setSelectedItemId} />}
      {viewsOpen && <ViewsDialog active={activeSavedView} setActive={setActiveSavedView} items={savedViewItems} loading={savedViewLoading} close={() => { setViewsOpen(false); setSavedViewItems(null); }} onItem={(id) => { setViewsOpen(false); setSavedViewItems(null); setSelectedItemId(id); }} />}
      {toast && <div className="toast" role="status">{toast}</div>}
      {project && <nav className="mobile-nav" aria-label="Mobile navigation">
        <button className={view === "stream" ? "active" : ""} onClick={() => setView("stream")}>Activity</button><button className={view === "board" ? "active" : ""} onClick={() => setView("board")}>Board</button><button className={view === "inbox" ? "active" : ""} onClick={() => setView("inbox")}>Inbox{unread ? ` · ${unread}` : ""}</button><button className={view === "agents" ? "active" : ""} onClick={() => setView("agents")}>Agents</button>
      </nav>}
    </main>
  );
}

function LoadingShell() { return <div className="loading-screen"><div className="brand-mark graphic" aria-hidden="true" /><div><strong>Planbraid</strong><span>Braiding your project work…</span></div></div>; }
function ErrorState({ message, retry }: { message: string; retry: () => void }) { return <div className="error-screen"><div className="brand-mark graphic" aria-hidden="true" /><h1>Couldn’t open Planbraid</h1><p>{message}</p><button onClick={retry}>Try again</button></div>; }

function ProjectRail({ data, avatarUrl, selected, selectedSource, sources, onSelect, onSource, open, toggle, onNew, onProfile, command, busy, onOpenAccountSetup }: { data: DashboardState; avatarUrl: string | null; selected: string; selectedSource: string | null; sources: Source[]; onSelect: (id: string) => void; onSource: (id: string | null) => void; open: boolean; toggle: () => void; onNew: () => void; onProfile: () => void; command: (command: Command, success: string | ((result: CommandResult) => string)) => Promise<CommandResult>; busy: boolean; onOpenAccountSetup: () => void }) {
  const railAmbiguousFamilies = ambiguousFamiliesOf(sources);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [managingProject, setManagingProject] = useState<Project | null>(null);

  function startRename(project: Project) { setRenamingId(project.id); setRenameDraft(project.name); }
  async function saveRename(project: Project) {
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!name || name === project.name) return;
    await command({ action: "update_project", projectId: project.id, name, idempotencyKey: requestId("rename-project") }, `Renamed to "${name}"`);
  }

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
      if (renamingId === project.id) {
        return <form key={project.id} className="project-row project-rename" onSubmit={(event) => { event.preventDefault(); void saveRename(project); }}>
          <span className="project-glyph">{project.name.slice(0, 1).toUpperCase()}</span>
          <input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onBlur={() => void saveRename(project)} onKeyDown={(event) => { if (event.key === "Escape") setRenamingId(null); }} maxLength={120} aria-label={`Rename ${project.name}`} />
        </form>;
      }
      return <div key={project.id} className={`project-row-wrap ${selected === project.id ? "selected" : ""}`}>
        <button className="project-row" onClick={() => onSelect(project.id)} aria-current={selected === project.id ? "page" : undefined}><span className="project-glyph">{project.name.slice(0, 1).toUpperCase()}</span><span className="project-copy"><strong>{project.name}</strong><small>{project.description || "Project workspace"}</small><span>{taskCount} {taskCount === 1 ? "task" : "tasks"}{activeCount ? ` · ${activeCount} active` : ""}</span></span></button>
        <ProjectMenu project={project} busy={busy} onRename={() => startRename(project)} onManageAgents={() => setManagingProject(project)} onDelete={() => void command({ action: "delete_project", projectId: project.id, idempotencyKey: requestId("delete-project") }, `Deleted "${project.name}"`)} />
      </div>;
    })}</div>
    <div className="rail-divider" />
    <div className="rail-label">Chats & agents</div>
    <div className="agent-list"><button className={`source-row all-sources ${selectedSource === null ? "active" : ""}`} onClick={() => onSource(null)}><span className="all-agent-icon">◎</span><span><strong>All activity</strong><small>Every connected conversation</small></span></button>{sources.map((source) => <button key={source.id} className={`source-row ${selectedSource === source.id ? "active" : ""}`} onClick={() => onSource(source.id)}><ProviderIcon provider={source.provider} /><span><strong>{sourceName(source, railAmbiguousFamilies)}</strong><small>{source.title}</small></span><span className={`presence ${source.status}`} title={source.status} /></button>)}</div>
    <button className="rail-footer" onClick={onProfile}><span className="avatar">{avatarUrl ? <span className="profile-image" style={{ backgroundImage: `url(${JSON.stringify(avatarUrl)})` }} aria-hidden="true" /> : data.viewer.name.slice(0, 1).toUpperCase()}</span><span><strong>{data.viewer.name}</strong><small>Account &amp; profile</small></span><b aria-hidden="true">›</b></button></>}
    {managingProject && <AgentsManageDialog project={managingProject} sources={data.sources.filter((source) => source.projectId === managingProject.id && source.status !== "removed")} busy={busy} command={command} close={() => setManagingProject(null)} onOpenAccountSetup={() => { setManagingProject(null); onOpenAccountSetup(); }} />}
  </aside>;
}

function ProjectMenu({ project, busy, onRename, onManageAgents, onDelete }: { project: Project; busy: boolean; onRename: () => void; onManageAgents: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeMenu = () => { setOpen(false); setConfirmingDelete(false); };
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node) || triggerRef.current?.contains(event.target as Node)) return;
      closeMenu();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeMenu(); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", closeMenu);
    return () => { document.removeEventListener("mousedown", onPointerDown); document.removeEventListener("scroll", closeMenu, true); window.removeEventListener("keydown", onKey); window.removeEventListener("resize", closeMenu); };
  }, [open]);

  return <div className="project-menu-wrap">
    <button ref={triggerRef} type="button" className="project-menu-button" onClick={(event) => {
      event.stopPropagation();
      if (open) { setOpen(false); setConfirmingDelete(false); return; }
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = 190;
      const menuHeight = 122;
      const viewportGap = 8;
      const left = Math.min(Math.max(viewportGap, rect.right - menuWidth), window.innerWidth - menuWidth - viewportGap);
      const top = rect.bottom + 4 + menuHeight <= window.innerHeight ? rect.bottom + 4 : Math.max(viewportGap, rect.top - menuHeight - 4);
      setPosition({ top, left });
      setOpen(true);
    }} aria-haspopup="menu" aria-expanded={open} aria-label={`More actions for ${project.name}`} title="More actions">⋯</button>
    {open && position && createPortal(<div ref={menuRef} className="project-menu" role="menu" style={position}>
      <button role="menuitem" onClick={() => { setOpen(false); setConfirmingDelete(false); onRename(); }}>Rename</button>
      <button role="menuitem" onClick={() => { setOpen(false); setConfirmingDelete(false); onManageAgents(); }}>Manage connected agents</button>
      {confirmingDelete
        ? <button role="menuitem" className="project-menu-danger" disabled={busy} onClick={() => { setOpen(false); setConfirmingDelete(false); onDelete(); }}>Confirm delete?</button>
        : <button role="menuitem" className="project-menu-danger" onClick={() => setConfirmingDelete(true)}>Delete project</button>}
    </div>, document.body)}
  </div>;
}

function AgentsManageDialog({ project, sources, busy, command, close, onOpenAccountSetup }: { project: Project; sources: Source[]; busy: boolean; command: (command: Command, success: string | ((result: CommandResult) => string)) => Promise<CommandResult>; close: () => void; onOpenAccountSetup: () => void }) {
  const ambiguousFamilies = ambiguousFamiliesOf(sources);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  function startRename(source: Source) { setRenamingId(source.id); setRenameDraft(source.title); }
  async function saveRename(source: Source) {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!title || title === source.title) return;
    await command({ action: "update_source", projectId: project.id, sourceId: source.id, title, idempotencyKey: requestId("rename-source") }, "Agent connection renamed");
  }

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="agents-manage-dialog" role="dialog" aria-modal="true" aria-labelledby="agents-manage-title">
      <header><div><span className="eyebrow">AGENTS</span><h2 id="agents-manage-title">Connected agents for {project.name}</h2><p>Rename how an agent shows up here, or block it from this project specifically.</p></div><button className="icon-button" onClick={close} aria-label="Close">×</button></header>
      <div className="agents-manage-list">
        {sources.length ? sources.map((source) => <div className="agent-manage-row" key={source.id}>
          {renamingId === source.id
            ? <form className="connection-rename" onSubmit={(event) => { event.preventDefault(); void saveRename(source); }}><input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} maxLength={120} aria-label={`Rename ${source.title}`} /><button type="submit">Save</button><button type="button" onClick={() => setRenamingId(null)}>Cancel</button></form>
            : <><div className="agent-manage-identity"><ProviderIcon provider={source.provider} /><span className="agent-manage-copy"><strong>{sourceName(source, ambiguousFamilies)}</strong><small>{source.title} · {source.accessBlocked ? "Blocked from this project" : `Last seen ${relative(source.lastSeenAt)}`}</small></span></div>
              <div className="agent-manage-actions"><button onClick={() => startRename(source)}>Rename</button>
                <button
                  disabled={busy || !source.credentialId}
                  title={source.credentialId ? undefined : "This session connected before blocking existed here; it needs to reconnect once before it can be blocked"}
                  onClick={() => void command({ action: "set_project_access", projectId: project.id, credentialId: source.credentialId!, blocked: !source.accessBlocked, idempotencyKey: requestId("project-access") }, source.accessBlocked ? "Agent unblocked from this project" : "Agent blocked from this project")}
                >{source.accessBlocked ? "Unblock" : "Block from this project"}</button></div></>}
        </div>) : <p className="oauth-help">No agents have connected to this project yet.</p>}
      </div>
      <p className="oauth-help">Blocking is enforced on every call this connection makes for this project, and survives it reconnecting, though it can still use the same token or OAuth connection for your other projects. To cut off a connection everywhere, revoke it entirely in <button className="inline-link-button" onClick={onOpenAccountSetup}>Setup → Connected apps</button>.</p>
    </section>
  </div>;
}

function Header({ project, itemCount, sources, unread, proposalCount, decisionCount, view, setView, query, setQuery, theme, toggleTheme, onSetup, viewer, avatarUrl, onProfile }: { project: Project | null; itemCount: number; sources: Source[]; unread: number; proposalCount: number; decisionCount: number; view: View; setView: (view: View) => void; query: string; setQuery: (query: string) => void; theme: Theme; toggleTheme: () => void; onSetup: () => void; viewer: DashboardState["viewer"]; avatarUrl: string | null; onProfile: () => void }) {
  return <><header className="workspace-header">
    {project && <div className="workspace-heading"><span className="workspace-project"><h1>{project.name}</h1><p>{itemCount} {itemCount === 1 ? "task" : "tasks"} · {sources.length} connected {sources.length === 1 ? "conversation" : "conversations"}</p></span></div>}
    <div className="header-actions">{project && <label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks and updates" aria-label="Search tasks and updates"/></label>}{project && <div className="sync-pill" aria-label={`${sources.filter((source) => source.status === "active").length} active agents`}><span className="presence active" /> Live</div>}<button className={`theme-switch ${theme}`} role="switch" aria-checked={theme === "light"} onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}><span className="theme-switch-thumb" aria-hidden="true"><span className="theme-switch-icon moon">☾</span><span className="theme-switch-icon sun">☼</span></span></button><button className="setup-button" onClick={onSetup}>Connect agent</button><button className="profile-trigger" onClick={onProfile} aria-label="Open account and profile" title="Account and profile"><span className="avatar">{avatarUrl ? <span className="profile-image" style={{ backgroundImage: `url(${JSON.stringify(avatarUrl)})` }} aria-hidden="true" /> : viewer.name.slice(0, 1).toUpperCase()}</span></button></div>
  </header>{project && <nav className="view-tabs" aria-label="Project views">{(["stream", "board", "proposals", "decisions", "list", "inbox", "agents"] as View[]).map((entry) => <button key={entry} className={view === entry ? "active" : ""} aria-pressed={view === entry} onClick={() => setView(entry)}>{entry === "stream" ? "Activity" : entry[0].toUpperCase() + entry.slice(1)}{entry === "inbox" && unread > 0 ? <b>{unread}</b> : null}{entry === "proposals" && proposalCount > 0 ? <b>{proposalCount}</b> : null}{entry === "decisions" && decisionCount > 0 ? <b>{decisionCount}</b> : null}</button>)}</nav>}</>;
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

function FilterBar({ items, filter, setFilter, source, clearSource, onSimplify, simplifying, onHandoff, handoffLoading, onHealth, healthLoading, onPlan, planLoading, onViews, project, sources, importRequests, onSetup, toast }: { items: WorkItem[]; filter: WorkStatus | "all"; setFilter: (status: WorkStatus | "all") => void; source: Source | null; clearSource: () => void; onSimplify: () => void; simplifying: boolean; onHandoff: () => void; handoffLoading: boolean; onHealth: () => void; healthLoading: boolean; onPlan: () => void; planLoading: boolean; onViews: () => void; project: Project; sources: Source[]; importRequests: DashboardState["importRequests"]; onSetup: () => void; toast: (message: string) => void }) {
  const statuses: Array<WorkStatus | "all"> = ["all", "in_progress", "ready", "blocked", "in_review", "done"];
  // Simplify is the rightmost control, so it owns the margin-left:auto that used to sit
  // on .source-filter; the source chip now just trails the status filters.
  const filterBarAmbiguousFamilies = ambiguousFamiliesOf(sources);
  const filterBarAccountIndex = accountIndexOf(sources, filterBarAmbiguousFamilies);
  return <div className="filter-bar"><div className="filter-scroll">{statuses.map((status) => <button key={status} className={filter === status ? "active" : ""} onClick={() => setFilter(status)}>{status === "all" ? "All work" : statusMeta[status].label}<span>{status === "all" ? items.length : items.filter((item) => deriveColumn(item) === status).length}</span></button>)}</div><button className="views-button" onClick={onViews} title="Saved structured views: active, blocking release, keeps getting proposed, no proof, needs a decision">Views</button><button className="health-button" onClick={onHealth} disabled={healthLoading} title="See planning debt: open findings weighted by kind">{healthLoading ? "Checking…" : "Health"}</button><button className="handoff-button" onClick={onHandoff} disabled={handoffLoading} title="Copy a project handoff for another agent">{handoffLoading ? "Preparing…" : "Handoff"}</button><button className="plan-button" onClick={onPlan} disabled={planLoading || !items.length} title="The most efficient order to work through everything open, respecting dependencies">{planLoading ? "Planning…" : "Plan"}</button>{source && <button className="source-filter" onClick={clearSource} title={source.title}><ProviderIcon provider={source.provider} /> {sourceName(source, filterBarAmbiguousFamilies, filterBarAccountIndex)} ×</button>}<button className="simplify-button" onClick={onSimplify} disabled={simplifying || !items.length} title="Find duplicates, blocked chains, and what to do first">{simplifying ? "Reviewing…" : "Simplify"}</button><ImportMenu project={project} sources={sources} importRequests={importRequests} onSetup={onSetup} toast={toast} /></div>;
}

/**
 * Asks one connected agent to report everything it knows about this project. Planbraid
 * cannot reach into a live agent conversation, so clicking a row both files a durable
 * request (picked up automatically the next time that agent's session starts) and
 * copies a ready-to-paste prompt so it also works immediately without waiting for that.
 *
 * Positioned position: fixed and clamped to the viewport from the trigger button's own
 * rect, computed on open rather than in CSS, because .filter-bar's ancestor
 * .filter-scroll scrolls horizontally - anything positioned relative to a scrolling
 * ancestor gets clipped by it exactly like the "Import complete Planbraid roadmap"
 * chip that was cut off.
 */
function ImportMenu({ project, sources, importRequests, onSetup, toast }: { project: Project; sources: Source[]; importRequests: DashboardState["importRequests"]; onSetup: () => void; toast: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; opensUp: boolean } | null>(null);
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const ambiguousFamilies = ambiguousFamiliesOf(sources);
  const MENU_WIDTH = 280;

  const place = useCallback(() => {
    const button = triggerRef.current;
    if (!button) return;
    const box = button.getBoundingClientRect();
    // Right-aligned to the button by default, then clamped so it can never render off
    // either edge of the viewport regardless of where the button sits. Opens upward
    // instead of down when there isn't 200px of room below - just enough for the
    // heading plus a couple of rows - so a trigger near the bottom of the screen
    // doesn't produce a menu that opens mostly off-screen.
    const left = Math.min(Math.max(8, box.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - 8);
    const opensUp = window.innerHeight - box.bottom < 200 && box.top > 200;
    // Anchored by the edge nearest the button either way: top of the menu 6px below the
    // button when opening down, bottom of the menu 6px above it when opening up (via
    // CSS `bottom`, since the menu's own height isn't known until it renders).
    const top = opensUp ? window.innerHeight - box.top + 6 : box.bottom + 6;
    setRect({ top, left, opensUp });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onResize = () => place();
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node) || triggerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("resize", onResize);
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("resize", onResize); document.removeEventListener("mousedown", onPointerDown); window.removeEventListener("keydown", onKey); };
  }, [open, place]);

  async function importFrom(source: Source) {
    setBusySourceId(source.id);
    try {
      const response = await fetch("/api/import-requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, sourceId: source.id }) });
      const body = await response.json() as { data?: { importRequestId: string; status: string }; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Could not start the import");
      const name = sourceName(source, ambiguousFamilies);
      const prompt = `Call resolve_project for this repository (or use project_id "${project.id}" for "${project.name}") on Planbraid, then read every task or plan item you have for it and report all of them in one create_work_items call with your registered source_id and import_request_id="${body.data.importRequestId}", so Planbraid can match against existing work and mark this import complete.`;
      await navigator.clipboard.writeText(prompt);
      toast(`Prompt copied - paste it into ${name}`);
      setOpen(false);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not start the import");
    } finally { setBusySourceId(null); }
  }

  return <div className="import-menu-wrap">
    <button ref={triggerRef} type="button" className="import-menu-button" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open} aria-label="Import from a connected agent" title="Import from a connected agent">⋯</button>
    {open && rect && <div ref={menuRef} className="import-menu" role="menu" style={rect.opensUp ? { bottom: rect.top, left: rect.left, width: MENU_WIDTH } : { top: rect.top, left: rect.left, width: MENU_WIDTH }}>
      <div className="import-menu-heading">Import from a connected agent</div>
      {sources.length
        ? sources.map((source) => {
          const pending = importRequests.find((request) => request.sourceId === source.id);
          const name = sourceName(source, ambiguousFamilies);
          return <button key={source.id} type="button" role="menuitem" className="import-menu-item" disabled={Boolean(pending) || busySourceId === source.id} onClick={() => void importFrom(source)}>
            <ProviderIcon provider={source.provider} />
            <span className="import-menu-item-copy"><strong>{pending ? `Waiting for ${name}…` : `Import from ${name}`}</strong><small>{source.status === "active" ? "Active" : `Last seen ${relative(source.lastSeenAt)}`}</small></span>
          </button>;
        })
        : <div className="import-menu-empty"><p>No agents connected yet.</p><button type="button" onClick={() => { setOpen(false); onSetup(); }}>Connect an agent</button></div>}
    </div>}
  </div>;
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
  // Keyed off the blockers themselves rather than the derived column: unscheduled work
  // with prerequisites no longer derives to "blocked" (that column is reserved for real
  // exceptions now), so gating this on the column would have deleted the only per-card
  // trace of the dependency graph. An explicitly blocked item shows blockerReason instead.
  const waitingOn = item.status !== "blocked" ? unresolvedBlockers(item, dependencies, allItems) : [];
  const anomaly = isStartedWhileBlocked(item);
  return <article className="task-card"><button className="task-card-main" onClick={onClick}><div><span className={`priority ${item.priority}`} /> <b>{item.itemKey}</b>{isProposal(item) && <span className="proposal-badge" title="Proposed by an agent and not yet accepted by anyone.">proposal</span>}{aliases.length > 0 && <span className={`alias-badge ${corroborated ? "corroborated" : ""}`} title={aliasTitle}>+{aliases.length}</span>}{anomaly && <span className="anomaly-badge" title="This is in progress, but a prerequisite is unresolved: either it was reopened, or the dependency was added after work started.">⚠ started while blocked</span>}<small>v{item.version}</small></div><h3>{item.title}</h3>{item.resolution && item.resolution !== "completed" && <p className="resolution-copy">{resolutionLabel[item.resolution] ?? item.resolution}{item.resolutionReason ? `: ${item.resolutionReason}` : ""}</p>}{item.deferredUntil && <p className="blocker-copy">Deferred until {new Date(item.deferredUntil).toLocaleDateString()}</p>}{item.blockerReason && <p className="blocker-copy">{item.blockerReason}</p>}{waitingOn.length > 0 && <p className="waiting-copy" title={waitingOn.map((entry) => `${entry.itemKey} ${entry.title}`).join("\n")}>Waiting on {waitingOn.map((entry) => entry.itemKey).join(", ")}</p>}{/* corroboration already includes the card's own source, so a plural stack replaces
    the single-source label rather than sitting beside a duplicate of itself. */}
          <footer>{corroborated ? <ProviderStack accounts={corroboration} ambiguousFamilies={ambiguousFamilies} /> : source ? <span><ProviderIcon provider={source.provider} /> {sourceName(source, ambiguousFamilies)}</span> : <span>Manual</span>}</footer></button><select aria-label={`Move ${item.itemKey}`} value={item.status} onChange={(event) => onMove(event.target.value as WorkStatus)}>{[item.status, ...ALLOWED_TRANSITIONS[item.status]].map((value) => <option key={value} value={value}>{statusMeta[value].label}</option>)}</select></article>;
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

/** Grouped in the order a person would act on them: things to collapse, then things
 * blocking progress, then what to start. Informational kinds carry no Apply button
 * because there is nothing safe to do automatically about them. */
const findingGroups: Array<{ kinds: FindingKind[]; title: string; blurb: string }> = [
  { kinds: ["duplicate", "possible_duplicate"], title: "Duplicates", blurb: "The same work written twice. Merging keeps the older task and files the other under it." },
  { kinds: ["redundant_done"], title: "Already covered", blurb: "Open work that repeats something finished." },
  { kinds: ["conflicting_work"], title: "Conflicting work", blurb: "Opposite intent on the same thing. Record a decision to pick one." },
  { kinds: ["cycle"], title: "Circular dependencies", blurb: "These wait on each other, so none of them can start." },
  { kinds: ["blocked_chain"], title: "Root blockers", blurb: "One line per root cause, not one per blocked task: fix these and everything behind them moves." },
  { kinds: ["do_first"], title: "Start here", blurb: "Unblocked work that frees the most once it lands." },
  { kinds: ["planning_loop"], title: "Planning loops", blurb: "Proposed again and again, by different agents, with nothing ever implemented. Resolve, reject, or schedule it." },
  { kinds: ["possibly_implemented", "evidence_removed"], title: "Plan vs. repository", blurb: "What a connected agent's own commits say does not match what the plan says." },
  { kinds: ["started_while_blocked", "stale", "agent_flagged"], title: "Worth a look", blurb: "Not wrong, but not right either." },
];

const DIVERGENCE_KINDS = new Set<FindingKind>(["possibly_implemented", "evidence_removed"]);

/** "Claude and Codex", "Claude, Codex and Gemini": model family keys from a finding's
 * agreedBy, turned into the display names the rest of the app already uses. */
function listOfLabels(families: string[]) {
  const labels = families.map((family) => labelFor(family));
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function SimplifyPanel({ run, busy, close, onApply, onDismiss }: { run: SimplifyRun; busy: string | null; close: () => void; onApply: (findingId: string) => void; onDismiss: (findingId: string) => void }) {
  const open = run.findings.filter((finding) => finding.status === "open");
  const actionable = open.filter((finding) => finding.proposedCommand);
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="simplify-dialog" role="dialog" aria-modal="true" aria-labelledby="simplify-title">
      <header><div><span className="eyebrow">PLAN REVIEW</span><h2 id="simplify-title">Simplify the plan</h2><p>{open.length ? `${open.length} thing${open.length === 1 ? "" : "s"} worth looking at. Nothing changes until you apply it.` : "Nothing to collapse or reorder - this plan already reads cleanly."}</p></div><button className="icon-button" onClick={close} aria-label="Close plan review">×</button></header>
      <div className="simplify-body">
        {findingGroups.map((group) => {
          const found = open.filter((finding) => group.kinds.includes(finding.kind));
          if (!found.length) return null;
          return <section className="simplify-group" key={group.title}>
            <h3>{group.title} <span>{found.length}</span></h3>
            <p className="simplify-blurb">{group.blurb}</p>
            {found.map((finding) => <article className={`simplify-finding ${finding.verdict}`} key={finding.id}>
              <div><strong>{finding.reason}</strong><small>{finding.detail}</small>
                {/* agreedBy holds independent corroboration: a connected agent agreeing
                    with the structural pass, or with another agent, the same signal a
                    task card shows via corroboratingProviders, applied to a finding
                    instead of a task. Named agents, never a count alone. */}
                {finding.agreedBy.length > 0 && <small className="simplify-corroboration">Also flagged by {listOfLabels(finding.agreedBy)}.</small>}
              </div>
              {finding.proposedCommand ? <span className="simplify-actions">
                <button className="simplify-apply" disabled={busy === finding.id} onClick={() => onApply(finding.id)}>{busy === finding.id ? "Applying…" : finding.kind === "redundant_done" ? "Cancel it" : DIVERGENCE_KINDS.has(finding.kind) ? "Move to ready" : "Merge"}</button>
                <button className="simplify-dismiss" disabled={busy === finding.id} onClick={() => onDismiss(finding.id)}>{DIVERGENCE_KINDS.has(finding.kind) ? "Leave as is" : "Keep both"}</button>
              </span> : null}
            </article>)}
          </section>;
        })}
        {!open.length && <Empty title="Nothing to simplify" body="No duplicates, cycles, or stalled work were found in this project." />}
      </div>
      {actionable.length > 0 && <footer className="simplify-footer"><small>{actionable.length} of these can be applied. Every merge is reversible from the task it was filed under.</small></footer>}
    </section>
  </div>;
}

/** M13: the plain-text form of the project handoff, ready to paste into any agent that
 * isn't connected yet. A textarea rather than a styled summary on purpose: the point is
 * copying the exact text a model reads, not a prettier restatement of it. */
function HandoffDialog({ text, close, toast }: { text: string; close: () => void; toast: (message: string) => void }) {
  async function copy() {
    try { await navigator.clipboard.writeText(text); toast("Handoff copied"); }
    catch { toast("Could not copy; select the text and copy manually"); }
  }
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
      <header><div><span className="eyebrow">HANDOFF</span><h2 id="handoff-title">Project handoff</h2><p>Paste this into any agent picking up the project cold.</p></div><button className="icon-button" onClick={close} aria-label="Close handoff">×</button></header>
      <textarea className="handoff-text" readOnly value={text} onFocus={(event) => event.target.select()} />
      <footer className="handoff-footer"><button onClick={() => void copy()}>Copy to clipboard</button></footer>
    </section>
  </div>;
}

/** M22: the debt list first, the score only as a visible sum of it - never an opaque
 * number on its own, matching the roadmap's own rule for this feature. */
function HealthDialog({ health, close, onItem }: { health: PlanningHealth; close: () => void; onItem: (workItemId: string) => void }) {
  const level = health.score >= 80 ? "good" : health.score >= 50 ? "fair" : "poor";
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="health-dialog" role="dialog" aria-modal="true" aria-labelledby="health-title">
      <header><div><span className="eyebrow">PLANNING HEALTH</span><h2 id="health-title">Planning debt</h2><p>Weighted by kind, heaviest first. The score below is just the sum of this list.</p></div><button className="icon-button" onClick={close} aria-label="Close planning health">×</button></header>
      <div className={`health-score ${level}`}><strong>{health.score}</strong><span>/ 100</span></div>
      {health.breakdown.length > 0 && <div className="health-breakdown">{health.breakdown.map((entry) => <span key={entry.kind}>{entry.kind.replaceAll("_", " ")} <b>{entry.count}</b></span>)}</div>}
      {health.debt.length
        ? <div className="health-debt-list">{health.debt.map((entry) => <button className="health-debt-row" key={entry.findingId} onClick={() => onItem(entry.workItemId)}>
            <span className="health-weight">{entry.weight}</span>
            <span><strong>{entry.itemKey ? `${entry.itemKey} ` : ""}{entry.reason}</strong><small>{entry.kind.replaceAll("_", " ")}</small></span>
          </button>)}</div>
        : <Empty title="No planning debt found" body="Every open Simplify finding is either resolved or informational-only. Nothing here to act on." />}
    </section>
  </div>;
}

/** The most efficient order to clear everything open: waves computed by simulating the
 * dependency graph forward (see lib/planning/plan.ts), each wave ranked the same way
 * get_ready_work ranks a single step. Wave 1 is actionable now; each later wave is what
 * that unlocks. Anything that never joins a wave is genuinely stuck on a manual block,
 * not on other tracked work, and is called out separately rather than silently omitted. */
/** Animates a plan row's accordion open on a CSS grid-rows track, which (unlike height)
 * needs no measured pixel value to transition smoothly either direction. A element that
 * mounts already carrying the "open" class never gets a "closed" frame to transition
 * from, so this renders closed for one frame first and flips open on the next - the
 * standard fix for a CSS transition that should also run on mount. */
function PlanStepShell({ open, onClosed, children }: { open: boolean; onClosed: () => void; children: React.ReactNode }) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return <div className={`plan-step-shell ${open && entered ? "open" : ""}`} onTransitionEnd={(event) => { if (event.propertyName === "grid-template-rows" && !open) onClosed(); }}>
    <div className="plan-step-clip">{children}</div>
  </div>;
}

/**
 * A work item row inside the Execution Plan modal expands in place instead of navigating
 * away: opening detail on a plan step used to close the whole modal, which threw away the
 * plan the moment anyone looked closer at a task. Rows toggle a local accordion here;
 * onItem is now reserved for links *inside* that accordion (dependencies, the critical
 * path chain), which open the task drawer on top of this modal without dismissing it.
 */
function PlanDialog({ plan, sources, allItems, events, evidence, dependencies, aliases, close, onItem }: { plan: ExecutionPlan; sources: Source[]; allItems: WorkItem[]; events: WorkEvent[]; evidence: DashboardState["evidence"]; dependencies: DashboardState["dependencies"]; aliases: DashboardState["aliases"]; close: () => void; onItem: (workItemId: string) => void }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Kept mounted a beat past collapse so the grid-rows transition below has something to
  // shrink: unmounting on the same tick as the class flip would cut the animation short.
  const [closingId, setClosingId] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "activity" | "evidence">("overview");
  // Lets the pinned bar scroll straight back to whichever row it mirrors, however far the
  // waves have scrolled it out of view - a plain map keyed by item id rather than one ref
  // per row, since the row set changes every time a wave renders.
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  function toggle(id: string) {
    setExpandedId((current) => {
      if (current === id) { setClosingId(id); return null; }
      if (current) setClosingId(current);
      setTab("overview");
      return id;
    });
  }
  function row(item: PlanStep | StuckItem, stuck = false) {
    const expanded = item.id === expandedId;
    const mounted = expanded || item.id === closingId;
    const corroboration = "corroboration" in item ? item.corroboration : 0;
    return <div className={`plan-step-wrap ${mounted ? "expanded" : ""}`} key={item.id} ref={(el) => { if (el) rowRefs.current.set(item.id, el); else rowRefs.current.delete(item.id); }}>
      <button className={`plan-step-row ${stuck ? "stuck" : ""}`} onClick={() => toggle(item.id)} aria-expanded={expanded}>
        <span className="plan-step-main">
          <span className={`priority ${item.priority}`} />
          <span><strong>{item.itemKey} {item.title}</strong><small>{item.reason}{corroboration > 1 ? ` · proposed independently by ${corroboration} models` : ""}</small></span>
        </span>
        {"critical" in item ? (item.critical ? <span className="plan-flag critical" title="On the critical path: delaying this delays the whole project.">critical</span> : <span className="plan-flag" title={`This can start up to ${item.slack} step${item.slack === 1 ? "" : "s"} later without moving the finish date.`}>slack {item.slack}</span>) : null}
      </button>
      {mounted && <PlanStepShell open={expanded} onClosed={() => setClosingId((current) => current === item.id ? null : current)}>
          <PlanItemAccordion item={item} source={sources.find((entry) => entry.id === item.sourceId) ?? null} sources={sources} events={events.filter((entry) => entry.workItemId === item.id)} evidence={evidence.filter((entry) => entry.workItemId === item.id)} dependencies={dependencies.filter((entry) => entry.fromWorkItemId === item.id || entry.toWorkItemId === item.id)} aliases={aliases.filter((entry) => entry.workItemId === item.id)} allItems={allItems} tab={tab} setTab={setTab} onItem={onItem} />
      </PlanStepShell>}
    </div>;
  }
  // A sticky row can only stick within its own parent's box, so pinning the row itself
  // stops working the moment a later wave scrolls past that box entirely - which is
  // exactly when losing track of what's open is the real problem. A dedicated bar as a
  // direct child of the scroll container has no such ceiling: it can stick for the whole
  // list, however many waves separate it from the row it mirrors.
  const expandedItem = expandedId ? (plan.waves.flatMap((wave) => wave.items).find((item) => item.id === expandedId) ?? plan.stuck.find((item) => item.id === expandedId)) : null;
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="plan-dialog" role="dialog" aria-modal="true" aria-labelledby="plan-title">
      <header><div><span className="eyebrow">EXECUTION PLAN</span><h2 id="plan-title">The most efficient order</h2><p>Ordered by critical path: the longest chain of work sets the finish date, so it goes first. Everything else has float.</p></div><button className="icon-button" onClick={close} aria-label="Close execution plan">×</button></header>
      {plan.criticalPath.length > 1 && <div className="plan-critical">
        <h3>Critical path <small>{plan.criticalPath.length} steps, in sequence</small></h3>
        <p className="muted">However many agents you run, the project cannot finish faster than this chain. Every other task can slip without costing time.</p>
        <div className="plan-critical-chain">{plan.criticalPath.map((entry, index) => <span key={entry.id}>
          {index > 0 && <b aria-hidden="true">→</b>}
          <button onClick={() => onItem(entry.id)} title={entry.title}>{entry.itemKey}</button>
        </span>)}</div>
      </div>}
      {plan.waves.length
        ? <div className="plan-waves">
            {expandedItem && <button className="plan-pinned-title" onClick={() => rowRefs.current.get(expandedItem.id)?.scrollIntoView({ behavior: "smooth", block: "start" })} title="Scroll back to this item">
              <span className={`priority ${expandedItem.priority}`} />
              <strong>{expandedItem.itemKey} {expandedItem.title}</strong>
              <span className="plan-pinned-hint">viewing</span>
            </button>}
            {plan.waves.map((wave) => <div className="plan-wave" key={wave.wave}>
            <h3>Wave {wave.wave}<small>· {wave.items.length} task{wave.items.length === 1 ? "" : "s"}{wave.wave === 1 ? " · actionable now" : ""}</small></h3>
            {wave.items.map((item) => row(item))}
          </div>)}</div>
        : <Empty title="Nothing open" body="Every work item is done or cancelled, so there's no plan to compute." />}
      {plan.stuck.length > 0 && <div className="plan-stuck"><h3>Needs manual attention</h3><p className="muted">Finishing other tracked work can't unblock these; a person has to look.</p>{plan.stuck.map((item) => row(item, true))}</div>}
    </section>
  </div>;
}

/** The same detail a task drawer shows, opened inline from a plan row instead of in its own
 * panel. Deliberately lighter than the drawer: no status/priority editing, no add-dependency
 * picker, and no progress-note input - this view is for orienting inside the plan, and every
 * action it does offer (a dependency link) opens the real drawer rather than acting here. */
function PlanItemAccordion({ item, source, sources, events, evidence, dependencies, aliases, allItems, tab, setTab, onItem }: { item: WorkItem; source: Source | null; sources: Source[]; events: WorkEvent[]; evidence: DashboardState["evidence"]; dependencies: DashboardState["dependencies"]; aliases: DashboardState["aliases"]; allItems: WorkItem[]; tab: "overview" | "activity" | "evidence"; setTab: (tab: "overview" | "activity" | "evidence") => void; onItem: (id: string) => void }) {
  const accordionAmbiguousFamilies = ambiguousFamiliesOf(sources);
  const corroboratedProviders = corroboratingProviders(item, aliases, sources);
  const confidence = confidenceOf({ item, events, corroboration: corroboratedProviders.length, evidenceCount: evidence.length, verifiedEvidenceCount: evidence.filter((entry) => entry.result === "verified").length, now: currentTime() });
  const waitingOn = unresolvedBlockers(item, dependencies, allItems);
  const blockedByEdges = dependencies.filter((edge) => edge.toWorkItemId === item.id);
  const blocksEdges = dependencies.filter((edge) => edge.fromWorkItemId === item.id);
  return <div className="plan-step-accordion">
    {item.description && <p className="plan-step-desc">{item.description}</p>}
    <div className="drawer-fields">
      <label>Status<strong className={`status-badge ${item.status}`}>{statusMeta[item.status].dot} {statusMeta[item.status].label}</strong></label>
      <label>Priority<strong className={`priority-value ${item.priority}`}>{item.priority}</strong></label>
      <label>Owner<strong>{item.assignee ?? "Unassigned"}</strong></label>
      <label>Source<strong>{source ? <><ProviderIcon provider={source.provider} /> {sourceName(source, accordionAmbiguousFamilies)}</> : "Manual"}</strong></label>
    </div>
    <nav className="drawer-tabs"><button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Overview</button><button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Activity {events.length}</button><button className={tab === "evidence" ? "active" : ""} onClick={() => setTab("evidence")}>Evidence {evidence.length}</button></nav>
    <div className="drawer-body">
      {tab === "overview" && <>
        <section><h3>Confidence</h3><div className="confidence"><span className={`confidence-level ${confidence.level}`}>{confidence.level}</span><span>{item.completionConfidence}</span></div></section>
        {item.blockerReason && <section className="blocker-panel"><h3>Blocker</h3><p>{item.blockerReason}</p></section>}
        {waitingOn.length > 0 && <section className="blocker-panel"><h3>Waiting on</h3>{waitingOn.map((entry) => <p className="waiting-on-row" role="button" tabIndex={0} key={entry.id} onClick={() => onItem(entry.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onItem(entry.id); } }}><b>{entry.itemKey}</b> {entry.title} · {statusMeta[entry.status].label}</p>)}</section>}
        <section><h3>Dependencies</h3>{dependencies.length ? <>{blockedByEdges.map((edge) => { const linked = allItems.find((entry) => entry.id === edge.fromWorkItemId); const label = edge.type === "blocks" ? "blocked by" : edge.type === "requires" ? "required by" : edge.type === "supersedes" ? "superseded by" : edge.type; return <div className="dependency-row incoming" role={linked ? "button" : undefined} tabIndex={linked ? 0 : undefined} key={edge.id} onClick={linked ? () => onItem(linked.id) : undefined} onKeyDown={linked ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onItem(linked.id); } } : undefined}><span>{label}</span><b>{linked?.itemKey}</b><p>{linked?.title}</p></div>; })}{blocksEdges.map((edge) => { const linked = allItems.find((entry) => entry.id === edge.toWorkItemId); return <div className="dependency-row" role={linked ? "button" : undefined} tabIndex={linked ? 0 : undefined} key={edge.id} onClick={linked ? () => onItem(linked.id) : undefined} onKeyDown={linked ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onItem(linked.id); } } : undefined}><span>{edge.type}</span><b>{linked?.itemKey}</b><p>{linked?.title}</p></div>; })}</> : <p className="muted">No dependencies.</p>}</section>
        {aliases.length > 0 && <section><h3>Also proposed</h3>{aliases.map((alias) => { const aliasSource = sources.find((entry) => entry.id === alias.sourceId); return <div className="alias-row" key={alias.id}><ProviderIcon provider={(aliasSource?.provider ?? "system") as Provider} /><span><strong>{alias.title}</strong><small>{aliasSource ? sourceName(aliasSource, accordionAmbiguousFamilies) : "Another agent"} · {relative(alias.createdAt)} · {alias.matchReason}</small></span></div>; })}</section>}
      </>}
      {tab === "activity" && (events.length ? events.map((event) => { const eventSource = sources.find((entry) => entry.id === event.sourceId); return <div className="mini-event" key={event.id}><ProviderIcon provider={(eventSource?.provider ?? "system") as Provider}/><span><strong>{event.summary}</strong><small>{event.actorName} · {relative(event.createdAt)}</small></span></div>; }) : <p className="muted">No activity yet.</p>)}
      {tab === "evidence" && (evidence.length ? evidence.map((entry) => { const evidenceSource = sources.find((entry2) => entry2.id === entry.sourceId); return <div className="evidence-row" key={entry.id}>{evidenceSource ? <ProviderIcon provider={evidenceSource.provider} /> : <span className="evidence-check">✓</span>}<span><strong>{entry.label}</strong><small>{entry.type} · {entry.result ?? "recorded"} · {evidenceSource ? `by ${sourceName(evidenceSource, accordionAmbiguousFamilies)}` : "Manual"} · {relative(entry.createdAt)}</small></span></div>; }) : <p className="muted">No evidence attached yet.</p>)}
    </div>
  </div>;
}

/** M23: five fixed, named queries over structured state - no prose parsing, no free-form
 * search. Switching the segment re-fetches rather than filtering client-side data already
 * loaded, since some views (no_proof, blocking_release) need computation the dashboard's
 * own state does not carry. */
function ViewsDialog({ active, setActive, items, loading, close, onItem }: { active: SavedViewName; setActive: (view: SavedViewName) => void; items: SavedViewItem[] | null; loading: boolean; close: () => void; onItem: (workItemId: string) => void }) {
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="views-dialog" role="dialog" aria-modal="true" aria-labelledby="views-title">
      <header><div><span className="eyebrow">SAVED VIEWS</span><h2 id="views-title">{SAVED_VIEW_LABELS[active]}</h2><p>Fixed structured queries over the current plan, not a search.</p></div><button className="icon-button" onClick={close} aria-label="Close saved views">×</button></header>
      <div className="views-segment">{(Object.keys(SAVED_VIEW_LABELS) as SavedViewName[]).map((view) => <button key={view} className={active === view ? "active" : ""} onClick={() => setActive(view)}>{SAVED_VIEW_LABELS[view]}</button>)}</div>
      {loading
        ? <p className="muted views-loading">Loading…</p>
        : items && items.length
          ? <div className="views-list">{items.map((item) => <button className="views-row" key={item.workItemId} onClick={() => onItem(item.workItemId)}>
              <span><strong>{item.itemKey} {item.title}</strong><small>{item.detail}</small></span>
            </button>)}</div>
          : <Empty title="Nothing here" body="This view has nothing to show right now." />}
    </section>
  </div>;
}

/**
 * The queue that keeps AI brainstorming out of the plan.
 *
 * An agent listing "we could migrate to GraphQL" produces a proposal, not a task. Nothing
 * here is destructive: accepting promotes, rejecting records a rejection with a reason
 * (which is what later stops the same idea coming back), and doing neither leaves it
 * exactly where it is.
 */
function Proposals({ items, sources, busy, gated, onItem, onAccept, onAcceptAll, onReject, onToggleGate }: { items: WorkItem[]; sources: Source[]; busy: boolean; gated: boolean; onItem: (id: string) => void; onAccept: (item: WorkItem) => void; onAcceptAll: () => void; onReject: (item: WorkItem) => void; onToggleGate: () => void }) {
  const ambiguousFamilies = ambiguousFamiliesOf(sources);
  return <div className="proposals-view">
    <div className="inbox-heading">
      <span>
        <h2>Proposals</h2>
        <p>Work agents suggested but nobody has accepted yet. Accepting makes it part of the plan.</p>
      </span>
      <div className="proposal-controls">
        <button className="secondary" onClick={onToggleGate} disabled={busy} title={gated ? "Proposals are currently hidden from the board" : "Proposals currently appear on the board alongside accepted work"}>
          {gated ? "Showing on board: off" : "Showing on board: on"}
        </button>
        {items.length > 1 && <button onClick={onAcceptAll} disabled={busy}>Accept all {items.length}</button>}
      </div>
    </div>
    {!items.length
      ? <Empty title="Nothing waiting" body="Everything an agent proposed has been accepted or rejected. New proposals show up here as agents record them." />
      : <div className="proposal-list">{items.map((item) => {
        const source = sources.find((entry) => entry.id === item.sourceId);
        return <article className="proposal-card" key={item.id}>
          <div className="proposal-body">
            <button className="proposal-open" onClick={() => onItem(item.id)}>
              <span className="proposal-meta">{source ? <ProviderIcon provider={source.provider} /> : null}<b>{item.itemKey}</b><small>{source ? sourceName(source, ambiguousFamilies) : "Manual"} · {relative(item.createdAt)}</small></span>
              <strong>{item.title}</strong>
              {item.description && <p>{item.description.slice(0, 240)}</p>}
            </button>
          </div>
          <div className="proposal-actions">
            <button onClick={() => onAccept(item)} disabled={busy}>Accept</button>
            <button className="secondary" onClick={() => onReject(item)} disabled={busy}>Reject</button>
          </div>
        </article>;
      })}</div>}
  </div>;
}

/** M19's decision queue. A decision is raised by anyone, agent or person, but only a
 * person can resolve one from here: choosing an option cancels every other option's
 * linked work item as superseded, which is exactly the kind of permanent, plan-shaping
 * call this product never lets an agent make on its own. */
function Decisions({ decisions, loading, items, resolvingOptionId, onResolve, onItem }: { decisions: Decision[] | null; loading: boolean; items: WorkItem[]; resolvingOptionId: string | null; onResolve: (decisionWorkItemId: string, winningOptionId: string) => void; onItem: (id: string) => void }) {
  return <div className="proposals-view">
    <div className="inbox-heading">
      <span>
        <h2>Decisions</h2>
        <p>Competing approaches somebody flagged as mutually exclusive. Choosing one supersedes the rest.</p>
      </span>
    </div>
    {loading && !decisions
      ? <Empty title="Loading decisions…" body="" />
      : !decisions?.length
        ? <Empty title="Nothing to decide" body="A decision shows up here when an agent or teammate flags two approaches as conflicting with record_decision." />
        : <div className="proposal-list">{decisions.map((decision) => <article className="proposal-card decision-card" key={decision.workItemId}>
          <div className="proposal-body">
            <button className="proposal-open" onClick={() => onItem(decision.workItemId)}>
              <span className="proposal-meta"><b>{decision.itemKey}</b></span>
              <strong>{decision.question}</strong>
            </button>
            <div className="decision-options">{decision.options.map((option) => {
              const related = option.relatedWorkItemId ? items.find((entry) => entry.id === option.relatedWorkItemId) : null;
              return <div className="decision-option" key={option.id}>
                <div className="decision-option-body">
                  <strong>{option.label}</strong>
                  {related && <small>Keeps {related.itemKey}: {related.title}</small>}
                  {option.rationale && <p>{option.rationale}</p>}
                </div>
                <button onClick={() => onResolve(decision.workItemId, option.id)} disabled={resolvingOptionId !== null}>
                  {resolvingOptionId === option.id ? "Choosing…" : "Choose"}
                </button>
              </div>;
            })}</div>
          </div>
        </article>)}</div>}
  </div>;
}

function Inbox({ notifications, onOpen, onResolve }: { notifications: Notification[]; onOpen: (notification: Notification) => void; onResolve: (notification: Notification) => void }) {
  const [tab, setTab] = useState<"action" | "updates" | "all">("all");
  const visible = notifications.filter((notification) => tab === "all" || tab === "action" ? (tab === "all" || notification.requiresAction && !notification.resolvedAt) : !notification.requiresAction);
  return <div className="inbox"><div className="inbox-heading"><span><h2>Inbox</h2><p>Decisions, completed turns, blockers, and agent health.</p></span><div className="segment"><button className={tab === "action" ? "active" : ""} onClick={() => setTab("action")}>Needs action</button><button className={tab === "updates" ? "active" : ""} onClick={() => setTab("updates")}>Updates</button><button className={tab === "all" ? "active" : ""} onClick={() => setTab("all")}>All</button></div></div>{visible.length ? <div className="inbox-list">{visible.map((notification) => <article className={`notification-card ${notification.readAt ? "read" : ""}`} key={notification.id}><span className={`notification-priority ${notification.priority}`}>!</span><button className="notification-main" onClick={() => onOpen(notification)}><div><strong>{notification.title}</strong><time>{relative(notification.createdAt)}</time></div><p>{notification.body}</p><small>{notification.eventType.replaceAll("_", " ").replaceAll(".", " · ")}</small></button>{notification.requiresAction && !notification.resolvedAt && <button className="resolve-button" onClick={() => onResolve(notification)}>Resolve</button>}</article>)}</div> : <Empty title="You’re caught up" body="Nothing in this notification view needs your attention." />}</div>;
}

/** M14: "who holds what, and for how long" - read from live work_claims leases (F1), not
 * from sourceId (who originally proposed an item). A session can hold work someone else
 * created, and conflating the two would show the wrong agent as the active holder. */
function Agents({ sources, items, claims, busy, onSetup, onDelete }: { sources: Source[]; items: WorkItem[]; claims: DashboardState["claims"]; busy: boolean; onSetup: () => void; onDelete: (source: Source) => void }) {
  const agentAmbiguousFamilies = ambiguousFamiliesOf(sources);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  return <div className="agents-view"><div className="inbox-heading"><span><h2>Connected agents</h2><p>Sessions, coding spaces, capture assurance, and current work.</p></span></div><div className="agent-grid">{sources.map((source) => {
    const held = claims.filter((claim) => claim.sourceId === source.id).map((claim) => ({ claim, item: items.find((entry) => entry.id === claim.workItemId) })).filter((entry): entry is { claim: DashboardState["claims"][number]; item: WorkItem } => entry.item != null);
    return <article className="agent-card" key={source.id}><header><ProviderIcon provider={source.provider} /><span><h3>{sourceName(source, agentAmbiguousFamilies)}</h3><p>{source.model ?? "Agent session"}</p></span><span className={`agent-status ${source.status}`}>{source.status}</span></header><h4>{source.title}</h4><div className="assurance-line"><Assurance value={source.assurance} /><span>Last event {relative(source.lastSeenAt)}</span></div><div className="agent-work">{held.length ? held.map(({ claim, item }) => <span key={claim.id}><b>{item.itemKey}</b> {item.title} <small>holds for {expiresIn(claim.leaseExpiresAt)}</small></span>) : <span className="muted">Holding nothing right now</span>}</div>
      {/* Planbraid cannot itself re-open a dropped MCP connection: there is no
          server-to-client channel, only the agent's own next request. This button is
          honest about that, and takes you to the same connection instructions
          "Connect agent" already shows, to paste back into this specific agent, rather
          than silently marking the card active while nothing has actually reconnected. */}
      <div className="agent-card-actions">
        {source.status === "ended" && <button className="agent-reconnect" onClick={onSetup}>Reconnect {sourceName(source, agentAmbiguousFamilies)}</button>}
        <button className="agent-delete" disabled={busy} onClick={() => {
          if (confirmingDeleteId === source.id) { setConfirmingDeleteId(null); onDelete(source); }
          else setConfirmingDeleteId(source.id);
        }}>{confirmingDeleteId === source.id ? "Confirm delete" : "Delete"}</button>
      </div>
    </article>;
  })}</div></div>;
}

function Composer({ project, sources, busy, onCreate }: { project: Project | null; sources: Source[]; busy: boolean; onCreate: (title: string, source: string) => void }) {
  const [title, setTitle] = useState(""); const [source, setSource] = useState("");
  const composerAmbiguousFamilies = ambiguousFamiliesOf(sources);
  function submit(event: FormEvent) { event.preventDefault(); if (!title.trim()) return; onCreate(title.trim(), source); setTitle(""); }
  return <form className="composer" onSubmit={submit}><span className="composer-plus">＋</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`Add work to ${project?.name ?? "this project"}…`} aria-label="New task title"/><select value={source} onChange={(event) => setSource(event.target.value)} aria-label="Task source"><option value="">Manual</option>{sources.map((entry) => <option value={entry.id} key={entry.id}>{sourceName(entry, composerAmbiguousFamilies)} · {entry.title}</option>)}</select><button disabled={busy || !title.trim()}>{busy ? "Saving…" : "Add task"}</button></form>;
}

function TaskDrawer({ item, source, sources, events, evidence, dependencies, aliases, allItems, viewerName, busy, hideNoteInput, transparentBackdrop, close, transition, note, splitAlias, onItem, linkDependencies }: { item: WorkItem; source: Source | null; sources: Source[]; events: WorkEvent[]; evidence: DashboardState["evidence"]; dependencies: DashboardState["dependencies"]; aliases: DashboardState["aliases"]; allItems: WorkItem[]; viewerName: string; busy: boolean; hideNoteInput?: boolean; transparentBackdrop?: boolean; close: () => void; transition: (status: WorkStatus, reason?: string) => void; note: (summary: string) => void; splitAlias: (aliasId: string) => void; onItem: (id: string) => void; linkDependencies: (prerequisiteIds: string[]) => void }) {
  const [tab, setTab] = useState<"overview" | "activity" | "evidence">("overview"); const [noteText, setNoteText] = useState("");
  const [addDependencyOpen, setAddDependencyOpen] = useState(false);
  const [whyNotDoneItemId, setWhyNotDoneItemId] = useState(item.id);
  const [whyNotDone, setWhyNotDone] = useState<{ summary: string; cause: string } | null>(null);
  // The "adjust state during render" pattern React recommends for resetting state when a
  // prop changes, rather than an effect that calls setState synchronously on every run:
  // switching items must clear stale text before the new fetch resolves, so a card never
  // briefly shows another item's explanation.
  if (item.id !== whyNotDoneItemId) { setWhyNotDoneItemId(item.id); setWhyNotDone(null); }
  // Fetched per item rather than derived client-side: the causal answer needs work_claims
  // (who currently holds it) and the project-wide dependency chain, neither of which
  // DashboardState carries. Errors are swallowed: this is a supplementary explanation,
  // not something the drawer's core functionality should ever block on.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/explain?workItemId=${encodeURIComponent(item.id)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((body) => { if (!cancelled && body?.data) setWhyNotDone(body.data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [item.id]);
  const corroboratedProviders = corroboratingProviders(item, aliases, sources);
  // Derived here rather than stored, so a card whose evidence was deleted or whose blocker
  // reopened stops claiming yesterday's confidence. See lib/trust/confidence.ts.
  const confidence = confidenceOf({
    item, events, corroboration: corroboratedProviders.length,
    evidenceCount: evidence.length,
    verifiedEvidenceCount: evidence.filter((entry) => entry.result === "verified").length,
    now: currentTime(),
  });
  const drawerAmbiguousFamilies = ambiguousFamiliesOf(sources);
  const waitingOn = unresolvedBlockers(item, dependencies, allItems);
  // Split by direction so "X blocks this" and "this blocks X" never render identically:
  // showing every edge as an undirected "blocks #N" line is what made an item and its own
  // prerequisite look like a cycle to a person reading the drawer.
  const blockedByEdges = dependencies.filter((edge) => edge.toWorkItemId === item.id);
  const blocksEdges = dependencies.filter((edge) => edge.fromWorkItemId === item.id);
  const linkableItemIds = new Set([item.id, ...dependencies.map((edge) => edge.fromWorkItemId === item.id ? edge.toWorkItemId : edge.fromWorkItemId)]);
  const anomaly = isStartedWhileBlocked(item);
  return <div className={`drawer-backdrop ${transparentBackdrop ? "plan-linked" : ""}`} onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><aside className="task-drawer" aria-label={`${item.itemKey} details`}><header className="drawer-header"><span className={`status-badge ${item.status}`}>{statusMeta[item.status].dot} {statusMeta[item.status].label}</span><button className="icon-button" onClick={close} aria-label="Close task">×</button></header><div className="drawer-title"><small>{item.itemKey} · v{item.version}</small><h2>{item.title}</h2><p>{item.description || "No description has been added yet."}</p>{corroboratedProviders.length > 1 && <p className="corroboration-banner">Proposed independently by {corroboratedProviders.map((account) => accountName(account, drawerAmbiguousFamilies)).join(" and ")}.</p>}{anomaly && <p className="anomaly-banner">⚠ In progress, but {waitingOn.length ? `${waitingOn.map((entry) => entry.itemKey).join(", ")} is still unresolved` : "a prerequisite is still unresolved"}.</p>}</div><div className="drawer-fields"><label>Status<select value={item.status} disabled={busy} onChange={(event) => transition(event.target.value as WorkStatus, event.target.value === "blocked" ? "Blocked from task detail" : undefined)}>{[item.status, ...ALLOWED_TRANSITIONS[item.status]].map((value) => <option value={value} key={value}>{statusMeta[value].label}</option>)}</select></label><label>Priority<strong className={`priority-value ${item.priority}`}>{item.priority}</strong></label><label>Owner<strong>{item.assignee ?? viewerName}</strong></label><label>Source<strong>{source ? <><ProviderIcon provider={source.provider} /> {sourceName(source, drawerAmbiguousFamilies)}</> : "Manual"}</strong></label></div><nav className="drawer-tabs"><button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Overview</button><button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Activity {events.length}</button><button className={tab === "evidence" ? "active" : ""} onClick={() => setTab("evidence")}>Evidence {evidence.length}</button></nav><div className="drawer-body">{tab === "overview" && <><section><h3>Standing</h3><div className="confidence"><span>{item.maturity}</span>{item.resolution && <span>{resolutionLabel[item.resolution] ?? item.resolution}</span>}</div>{item.resolutionReason && <p className="muted">{item.resolutionReason}</p>}{item.deferredUntil && <p className="muted">Deferred until {new Date(item.deferredUntil).toLocaleDateString()}.</p>}{whyNotDone && whyNotDone.cause !== "blocked_by_dependency" && <p className="why-not-done">{whyNotDone.summary}</p>}</section><section><h3>Confidence</h3><div className="confidence"><span className={`confidence-level ${confidence.level}`}>{confidence.level}</span><span>{item.completionConfidence}</span></div><ul className="confidence-reasons">{confidence.reasons.map((line) => <li key={line}>{line}</li>)}</ul>{confidence.lastConfirmedAt && <p className="muted">Last confirmed {relative(confidence.lastConfirmedAt)}{confidence.basis ? `, ${provenanceLabel[confidence.basis]}` : ""}.</p>}</section>{item.blockerReason && <section className="blocker-panel"><h3>Blocker</h3><p>{item.blockerReason}</p></section>}{waitingOn.length > 0 && <section className="blocker-panel"><h3>Waiting on</h3>{waitingOn.map((entry) => <p className="waiting-on-row" role="button" tabIndex={0} key={entry.id} onClick={() => onItem(entry.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onItem(entry.id); } }}><b>{entry.itemKey}</b> {entry.title} · {statusMeta[entry.status].label}</p>)}</section>}<section><h3>Dependencies <button type="button" className="add-dependency-button" onClick={() => setAddDependencyOpen(true)}>+ Add dependency</button></h3>{dependencies.length ? <>{blockedByEdges.map((edge) => { const linked = allItems.find((entry) => entry.id === edge.fromWorkItemId); const label = edge.type === "blocks" ? "blocked by" : edge.type === "requires" ? "required by" : edge.type === "supersedes" ? "superseded by" : edge.type; return <div className="dependency-row incoming" role={linked ? "button" : undefined} tabIndex={linked ? 0 : undefined} key={edge.id} onClick={linked ? () => onItem(linked.id) : undefined} onKeyDown={linked ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onItem(linked.id); } } : undefined}><span>{label}</span><b>{linked?.itemKey}</b><p>{linked?.title}</p></div>; })}{blocksEdges.map((edge) => { const linked = allItems.find((entry) => entry.id === edge.toWorkItemId); return <div className="dependency-row" role={linked ? "button" : undefined} tabIndex={linked ? 0 : undefined} key={edge.id} onClick={linked ? () => onItem(linked.id) : undefined} onKeyDown={linked ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onItem(linked.id); } } : undefined}><span>{edge.type}</span><b>{linked?.itemKey}</b><p>{linked?.title}</p></div>; })}</> : <p className="muted">No dependencies.</p>}</section>{aliases.length > 0 && <section><h3>Also proposed</h3>{aliases.map((alias) => { const aliasSource = sources.find((entry) => entry.id === alias.sourceId); return <div className="alias-row" key={alias.id}><ProviderIcon provider={(aliasSource?.provider ?? "system") as Provider} /><span><strong>{alias.title}</strong><small>{aliasSource ? sourceName(aliasSource, drawerAmbiguousFamilies) : "Another agent"} · {relative(alias.createdAt)} · {alias.matchReason}</small></span><button className="alias-split" disabled={busy} onClick={() => splitAlias(alias.id)}>Not the same, make separate task</button></div>; })}</section>}</>}{tab === "activity" && events.map((event) => { const eventSource = sources.find((entry) => entry.id === event.sourceId); return <div className="mini-event" key={event.id}><ProviderIcon provider={(eventSource?.provider ?? "system") as Provider}/><span><strong>{event.summary}</strong><small>{event.actorName} · {relative(event.createdAt)}</small></span></div>; })}{tab === "evidence" && (evidence.length ? evidence.map((entry) => { const evidenceSource = sources.find((entry2) => entry2.id === entry.sourceId); return <div className="evidence-row" key={entry.id}>{evidenceSource ? <ProviderIcon provider={evidenceSource.provider} /> : <span className="evidence-check">✓</span>}<span><strong>{entry.label}</strong><small>{entry.type} · {entry.result ?? "recorded"} · {evidenceSource ? `by ${sourceName(evidenceSource, drawerAmbiguousFamilies)}` : "Manual"} · {relative(entry.createdAt)}</small></span></div>; }) : <p className="muted">No evidence attached yet.</p>)}</div>{!hideNoteInput && <form className="drawer-note" onSubmit={(event) => { event.preventDefault(); if (!noteText.trim()) return; note(noteText.trim()); setNoteText(""); }}><input value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="Add a progress update…"/><button disabled={!noteText.trim() || busy}>Add</button></form>}</aside>{addDependencyOpen && <AddDependencyDialog item={item} allItems={allItems} excludeIds={linkableItemIds} busy={busy} close={() => setAddDependencyOpen(false)} onLink={(ids) => { linkDependencies(ids); setAddDependencyOpen(false); }} />}</div>;
}

/** Manual fix for exactly the gap that produces an item and its own prerequisite reading
 * as a cycle in the drawer: an agent proposed both without declaring the edge between
 * them. Planbraid never infers this from wording (see lib/planning/views.ts's own note on
 * why a hosted model stays off this critical path): a missing edge is a graph-authoring
 * gap, not something to guess at from titles, so this is the tool for a person to close it
 * directly instead. Selecting an item here always adds it as a *prerequisite* of the item
 * the drawer is open on; the server's own cycle check (add_dependency) is the backstop if
 * that would create one. */
function AddDependencyDialog({ item, allItems, excludeIds, busy, close, onLink }: { item: WorkItem; allItems: WorkItem[]; excludeIds: Set<string>; busy: boolean; close: () => void; onLink: (prerequisiteIds: string[]) => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const q = query.trim().toLowerCase();
  const candidates = allItems.filter((entry) => !excludeIds.has(entry.id) && (!q || `${entry.itemKey} ${entry.title} ${entry.description}`.toLowerCase().includes(q)));

  function toggle(id: string) {
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="add-dependency-dialog" role="dialog" aria-modal="true" aria-labelledby="add-dependency-title">
      <header><div><span className="eyebrow">DEPENDENCIES</span><h2 id="add-dependency-title">Add a dependency to {item.itemKey}</h2><p>Selected items become prerequisites: {item.itemKey} cannot start until they're done.</p></div><button className="icon-button" onClick={close} aria-label="Close">×</button></header>
      <label className="add-dependency-search"><span>⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search work items by key, title, or description" aria-label="Search work items" /></label>
      <div className="add-dependency-list">
        {candidates.length ? candidates.map((entry) => <label className="add-dependency-row" key={entry.id}>
          <input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggle(entry.id)} />
          <span><b>{entry.itemKey}</b><strong>{entry.title}</strong>{entry.description && <small>{entry.description}</small>}</span>
        </label>) : <p className="muted">{q ? "No matching work items." : "Nothing left to link - every other item is already connected."}</p>}
      </div>
      <footer className="add-dependency-footer">
        <span>{selected.size} selected</span>
        <button className="primary-wide" disabled={!selected.size || busy} onClick={() => onLink([...selected])}>{busy ? "Linking…" : `Add ${selected.size || ""} dependenc${selected.size === 1 ? "y" : "ies"}`}</button>
      </footer>
    </section>
  </div>;
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
            {projects.filter((project) => !search.trim() || `${project.name} ${project.description} ${project.directory}`.toLowerCase().includes(search.trim().toLowerCase())).map((project) => <a href={`/?project=${project.id}`} key={project.id} className={project.id === currentProject ? "current" : ""}><span className="project-glyph">{project.name.slice(0, 1).toUpperCase()}</span><b>Open {project.name}</b><small>{project.directory || project.description}</small></a>)}
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
  function copy(key: string, text: string) {
    void navigator.clipboard.writeText(text);
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
        <div className="endpoint-box"><small>Remote MCP server URL</small><code>{endpoint}</code><button onClick={() => copy("endpoint", endpoint)}>{copiedKey === "endpoint" ? "Copied" : "Copy URL"}</button></div>
        {markerField}<div className="config-box"><span><small>Common MCP JSON configuration</small><button onClick={() => copy("oauthConfig", oauthConfig)}>{copiedKey === "oauthConfig" ? "Copied" : "Copy config"}</button></span><pre>{oauthConfig}</pre></div>
        <p className="oauth-help">Planbraid uses standard MCP and OAuth discovery. The connected client identifies its own provider, session, and optional model when it begins reporting work.</p>
        <div className="connection-list"><h3>Connected apps <span>{oauthConnections.length}</span></h3>{oauthConnections.length ? oauthConnections.map((entry) => <div className="connection-row" key={entry.id}>{renamingId === entry.id
          ? <form className="connection-rename" onSubmit={(event) => { event.preventDefault(); void renameOAuth(entry.id, renameDraft); }}><input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} maxLength={60} aria-label={`Rename ${entry.name}`} /><button type="submit">Save</button><button type="button" onClick={() => setRenamingId(null)}>Cancel</button></form>
          : <><span><strong>{entry.name}</strong><small>{entry.lastUsedAt ? `Last used ${relative(entry.lastUsedAt)}` : "Not used yet"} · {entry.scopes.join(", ")}</small></span><button onClick={() => { setRenamingId(entry.id); setRenameDraft(entry.name); }}>Rename</button><button onClick={() => void revokeOAuth(entry.id)} disabled={revokingOAuthId === entry.id}>{revokingOAuthId === entry.id ? "Revoking…" : "Revoke"}</button></>}</div>) : <p className="oauth-help">No connected apps yet.</p>}</div>
      </section> : <section className="token-setup-card connection-panel" role="tabpanel">
        <header><span><span className="token-key">⌁</span><strong>Bearer token access</strong></span></header>
        <p>For clients without OAuth, create a personal token and send it in the <code>Authorization</code> header. The secret is shown only once.</p>
        {token ? <><div className="token-box"><small>New token - copy it now</small><code>{token}</code><button onClick={() => copy("token", token)}>{copiedKey === "token" ? "Copied" : "Copy"}</button></div><div className="config-box"><span><small>Common MCP JSON configuration</small><button onClick={() => copy("tokenConfig", tokenConfig)}>{copiedKey === "tokenConfig" ? "Copied" : "Copy config"}</button></span><pre>{tokenConfig}</pre></div></> : <><label className="agent-marker"><span>Name this connection <span className="label-optional">optional</span></span><input value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder={`${project?.name ?? "Project"} coding agents`} maxLength={60} /><small>This name is what Planbraid shows against everything the connection records.</small></label>{markerField}<button className="primary-wide" onClick={() => void generate()} disabled={busy}>{busy ? "Generating…" : `Generate access token for ${project?.name ?? "Planbraid"}`}</button></>}
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
/** react-hooks/purity flags Date.now() called directly in a component body; routed through
 * a plain function the same way `relative` already is. */
function currentTime() { return Date.now(); }
function relative(value: string) { const delta = Date.now() - new Date(value).getTime(); const minutes = Math.max(0, Math.floor(delta / 60000)); if (minutes < 1) return "now"; if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h`; return `${Math.floor(hours / 24)}d`; }
/** A lease's remaining time, the future-facing counterpart to relative()'s past-facing one. */
function expiresIn(value: string) { const delta = new Date(value).getTime() - Date.now(); if (delta <= 0) return "0m"; const minutes = Math.ceil(delta / 60000); if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h`; return `${Math.floor(hours / 24)}d`; }
function eventAction(event: string) { return ({ "work_item.created": "created work", "work_item.started": "started work", "work_item.blocked": "reported a blocker", "work_item.completion_reported": "requested review", "work_item.completion_verified": "completed work", "work_item.progress_reported": "shared progress", "interaction.completed": "completed a turn", "evidence.attached": "attached evidence" } as Record<string, string>)[event] ?? event.replaceAll("_", " ").replace("work item.", ""); }
function eventTone(event: WorkEvent) { if (event.eventType.includes("unblocked")) return "success"; if (event.eventType.includes("blocked") || event.eventType.includes("failed")) return "danger"; if (event.eventType.includes("verified") || event.toStatus === "done") return "success"; if (event.eventType.includes("review")) return "review"; return "normal"; }
async function showSystemNotification(title: string, body: string) { if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState === "visible") return; const registration = await navigator.serviceWorker.ready; await registration.showNotification(title, { body, icon: "/planbraid-mark.png", badge: "/planbraid-mark.png", tag: `planbraid-${title}`, data: { url: "/" } }); }
function base64UrlKey(value: string) { const padded = value + "=".repeat((4 - value.length % 4) % 4); const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/")); const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index); return bytes.buffer; }
