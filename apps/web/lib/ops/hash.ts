/**
 * Content addressing for the plan operation log.
 *
 * `PLAN_VERSION_CONTROL.md §3`: `hash = sha256(type ‖ canonical(payload) ‖ sorted(parents))`.
 * The identity of an operation is a pure function of what it says and what it depends on —
 * never of when it was written or who wrote it — so the same logical change submitted
 * twice (a retried hook, two agents independently proposing the identical edge) hashes
 * identically and collapses to one row via `ON CONFLICT (hash) DO NOTHING`, with no
 * caller-supplied idempotency key required at this layer.
 *
 * Kept deliberately tiny and dependency-free: no database, no clock, directly testable.
 */

/**
 * Deterministic JSON: object keys sorted recursively, so two payloads built with the same
 * data in different key order hash identically. Arrays keep their order — order is
 * meaningful there (e.g. `depends_on` refs) — only object key order is normalized.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
    return sorted;
  }
  return value;
}

/**
 * The hash itself. `parents` is sorted before hashing so the identity of an operation
 * never depends on the order its dependencies happened to be listed in — only on the set.
 */
export async function hashOp(type: string, canonicalPayload: unknown, parents: readonly string[]): Promise<string> {
  const material = JSON.stringify({ type, payload: canonicalPayload, parents: [...parents].sort() });
  const bytes = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Strips fields that are about *delivery*, not about *what happened* — an idempotency
 * key exists so a retried request doesn't re-execute; it says nothing about the change
 * itself, and including it would make one logical operation hash differently depending on
 * which request happened to submit it. */
export function opPayloadFrom(command: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...command };
  delete rest.idempotencyKey;
  return rest;
}
