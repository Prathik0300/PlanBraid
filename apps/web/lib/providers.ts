/**
 * Provider identity: turning the free-form string an agent registers itself under
 * ("codex-desktop", "claude-code", "gemini-cli") into a stable model family.
 *
 * Shared by the UI (which picks a logo and a label) and lib/store.ts's getReadyWork
 * (which counts how many *independent models* proposed a task). Those two have to agree:
 * if the ranking deduped by raw string while the UI deduped by family, two accounts of
 * one model would count as independent agreement in the ranking while displaying as a
 * single logo — the exact mismatch this module exists to prevent. No React, no DB.
 */

export const providerLabel: Record<string, string> = {
  codex: "Codex", openai: "OpenAI", chatgpt: "ChatGPT", claude: "Claude", anthropic: "Anthropic",
  gemini: "Gemini", google: "Google", copilot: "GitHub Copilot", github_copilot: "GitHub Copilot", cursor: "Cursor",
  windsurf: "Windsurf", human: "You", system: "Planbraid",
};

// An exact match against providerLabel almost never hits in practice, because agents
// register under whatever name they choose. Matched by family instead of equality.
const providerFamilies: Array<[RegExp, string]> = [
  [/codex/, "codex"], [/claude|anthropic/, "claude"], [/gemini/, "gemini"], [/google/, "google"],
  [/copilot/, "copilot"], [/cursor/, "cursor"], [/windsurf/, "windsurf"], [/openai|chatgpt|gpt/, "openai"],
  [/^human$|^you$/, "human"], [/^system$|^planbraid$/, "system"],
];

export function providerFamily(provider: string) {
  const normalized = provider.toLowerCase();
  return providerFamilies.find(([pattern]) => pattern.test(normalized))?.[1] ?? normalized.replace(/[^a-z0-9_-]/g, "_");
}

/** Title-cases a raw, unrecognized provider string ("codex-desktop" -> "Codex desktop")
 * so an agent nobody has special-cased yet still gets a real name instead of blank text. */
export function prettifyProvider(provider: string) {
  const spaced = provider.replace(/[-_]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function labelFor(provider: string) {
  return providerLabel[providerFamily(provider)] ?? prettifyProvider(provider);
}

/**
 * Names one agent account: the model, qualified by which login it is.
 *
 * A credential named "Claude work" already says which model it is, so prefixing the
 * model again reads "Claude · Claude work". A bare marker like "work" says nothing on
 * its own and needs the model in front of it. Shared by the event log and the UI so a
 * task's card and its history call the same account by the same name.
 */
export function accountDisplayName(provider: string, accountLabel?: string | null) {
  const model = labelFor(provider);
  if (!accountLabel) return model;
  return accountLabel.toLowerCase().includes(providerFamily(provider)) ? accountLabel : `${model} · ${accountLabel}`;
}

/**
 * The stable grouping key for "which of my agent logins is this". The credential id
 * alone is not enough: two CLI aliases can share one token and separate themselves with
 * a ?agent= marker, and those must not collapse. The marker alone is not enough either,
 * since it is caller-supplied text — pairing it with the credential keeps one account's
 * marker from colliding with another's, and keeps a later rename from re-identifying
 * work already attributed.
 */
export function agentAccountKey(credentialId: string | null | undefined, marker: string | null | undefined) {
  const parts = [credentialId, marker].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length ? parts.map((part) => part.trim()).join("#") : null;
}

/** Caller-supplied identity markers land in URLs, event text, and the sidebar, so strip
 * control characters and cap the length rather than trusting the query string. */
export function normalizeAccountLabel(value: string | null | undefined) {
  // Filtered by code point rather than by regex: a control-character class is exactly
  // what no-control-regex exists to flag, and slicing code points keeps the cap from
  // splitting a surrogate pair.
  const kept = [...(value ?? "")].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f;
  });
  const cleaned = [...kept.join("").trim()].slice(0, 60).join("").trim();
  return cleaned || null;
}
