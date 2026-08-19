/**
 * Server-side source presence policy.
 *
 * Clients do not agree on lifecycle events: some send an explicit session end, while
 * others disappear without one. Presence therefore cannot be the last client-supplied
 * status forever. Readers derive it from heartbeat freshness, while the two deliberate
 * terminal states remain authoritative until register_agent_session reconnects them.
 */
export const SOURCE_ACTIVE_WINDOW_MS = 2 * 60 * 1000;

/** Keep automatic session expiry aligned with work-claim expiry. */
export const SOURCE_ENDED_AFTER_MS = 45 * 60 * 1000;

export function normalizeSourcePresence(storedStatus: string, lastSeenAt: string, now = Date.now()): string {
  if (storedStatus === "removed" || storedStatus === "ended") return storedStatus;

  const lastSeen = Date.parse(lastSeenAt);
  if (!Number.isFinite(lastSeen)) return "unknown";

  const age = Math.max(0, now - lastSeen);
  if (age >= SOURCE_ENDED_AFTER_MS) return "ended";
  if (storedStatus === "idle" || age >= SOURCE_ACTIVE_WINDOW_MS) return "idle";
  return "active";
}
