/**
 * The artifact vocabulary: extraction, re-exported from where it's actually computed.
 *
 * Write-time indexing, backfill, and candidate retrieval moved to `lib/dedup/blocking.ts`
 * (E1), which combines this index with the rare-token one (`lib/dedup/tokens.ts`) and
 * fuses both by RRF — a single retrieval layer needs to own both tables' write path, or
 * a backfill of one can silently starve the other (see that module's own note on why).
 *
 * `classifyArtifact` itself now lives in `lib/dedup/signature.ts` (E2): subsystem
 * derivation needs it and signature.ts is what artifacts.ts already depends on, so
 * defining it there instead of here is what avoids a real import cycle. Re-exported for
 * every existing caller of this module rather than making them all switch imports for a
 * move that changes nothing about the function itself.
 */
import { buildSignature, classifyArtifact, type ArtifactKind } from "./signature.ts";

export { classifyArtifact, type ArtifactKind };

export function artifactsOf(title: string, description: string) {
  return buildSignature(title, description).artifacts;
}
