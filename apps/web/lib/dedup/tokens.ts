/**
 * E1's rare-token retriever — the second half of §5's blocking rebuild, alongside the
 * artifact index (`lib/dedup/artifacts.ts`).
 *
 * Deliberately reuses `buildSignature`'s `objectTokens` rather than a second tokenizer:
 * those are already stemmed and stopword-free, and `extractArtifacts` has already pulled
 * concrete references out of the residue before object tokens are computed — so an
 * artifact and a token can never be the same string, and the two indices stay disjoint
 * signals rather than double-counting one piece of evidence.
 */
import { buildSignature } from "./signature.ts";

export function tokensOf(title: string, description: string) {
  return buildSignature(title, description).objectTokens;
}
