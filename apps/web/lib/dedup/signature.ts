/**
 * Structural task identity.
 *
 * Task titles authored by coding agents are short, imperative, and share heavy
 * vocabulary inside a project, so overall wording similarity conflates tasks that
 * differ only in the tokens that matter most ("/api/login" vs "/api/signup").
 * A signature separates the three parts that actually determine identity —
 * the action, the object, and the concrete artifacts — so those can be compared
 * independently and the discriminating parts can veto a match outright.
 *
 * E2 (RECONCILIATION_ARCHITECTURE.md §4, "signature v2") extends this with three more
 * comparison dimensions — subsystem, acceptance criteria, and scope qualifiers — plus a
 * synonym lexicon over object tokens. Fingerprint safety note: `fingerprint()` is always
 * computed fresh from an item's current title/description on both sides of every live
 * comparison (`lib/dedup/resolve.ts`'s `toCandidate`, called at match time, never reads
 * the `content_fingerprint` column back out) — so widening `normalized` here changes
 * nothing about matching correctness for existing items, only what future comparisons can
 * distinguish.
 *
 * Deliberately not yet wired into `match.ts`'s adjudication cascade as a new veto or
 * score input. §4.1 lists "both subsystems known and non-adjacent" as veto 4, but a hard
 * veto based on this milestone's own subsystem heuristic (nearest shared directory prefix
 * among an item's own mentioned file paths, not yet the real repository tree from E7's
 * tree-sitter grounding) would risk exactly the false-split-from-imprecision the vetoes
 * document warns a hand-tuned cascade is prone to. These fields are real, tested, and
 * ready — E3's Fellegi-Sunter scorer is where a signal like this belongs: a *learned*
 * weight, calibrated against real labels, is what §4.2 exists to provide instead of one
 * more guessed threshold.
 */

export type ActionClass =
  | "add" | "remove" | "fix" | "refactor" | "test" | "document"
  | "investigate" | "optimize" | "configure" | "deploy" | "update" | "unknown";

/** Leading imperative verbs, grouped by the action they denote. Longest phrase wins. */
const ACTION_LEXICON: Record<Exclude<ActionClass, "unknown">, string[]> = {
  add: ["add", "implement", "create", "build", "introduce", "support", "enable", "write", "set up", "setup", "integrate", "wire up", "wire", "expose", "allow", "handle"],
  remove: ["remove", "delete", "drop", "strip", "disable", "deprecate", "purge", "revoke", "tear down"],
  fix: ["fix", "repair", "resolve", "patch", "correct", "address", "debug", "unbreak", "prevent"],
  refactor: ["refactor", "rewrite", "restructure", "simplify", "extract", "rename", "migrate", "port", "consolidate", "modernize", "clean up", "move"],
  test: ["test", "cover", "assert", "verify", "validate", "spec"],
  document: ["document", "describe", "explain", "annotate", "docs"],
  investigate: ["investigate", "research", "explore", "evaluate", "assess", "audit", "review", "analyze", "analyse", "spike", "determine", "diagnose", "figure out"],
  optimize: ["optimize", "optimise", "improve", "speed up", "reduce", "tune", "accelerate", "parallelize"],
  configure: ["configure", "config", "adjust", "tweak", "tighten"],
  deploy: ["deploy", "release", "ship", "publish", "roll out", "rollout"],
  update: ["update", "upgrade", "bump", "modify", "revise", "change", "extend"],
};

/** Action pairs that describe opposite intent. Never the same task, at any similarity. */
const ANTONYMS: Array<[ActionClass, ActionClass]> = [["add", "remove"]];

const VERB_LOOKUP = new Map<string, ActionClass>();
for (const [action, verbs] of Object.entries(ACTION_LEXICON)) {
  for (const verb of verbs) VERB_LOOKUP.set(verb, action as ActionClass);
}
const MAX_VERB_WORDS = Math.max(...[...VERB_LOOKUP.keys()].map((verb) => verb.split(" ").length));

const STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "in", "on", "of", "and", "or", "with", "from", "at", "by",
  "into", "that", "this", "it", "is", "be", "are", "was", "should", "must", "will", "can",
  "we", "our", "us", "all", "any", "as", "so", "then", "when", "if", "not", "no", "new",
  "use", "using", "used", "via", "per", "up", "out", "over", "its", "their", "there",
]);

/**
 * E2's synonym lexicon: abbreviation and full-form pairs common in software work that
 * crude suffix-stripping stemming can't unify on its own (`stem()` handles morphology —
 * plurals, "-ing", "-ed" — not vocabulary substitution). Keyed by the raw lowercased word,
 * valued by its canonical form; applied before stemming so "authentication" and "auth"
 * land on one token regardless of which one gets typed. Deliberately modest rather than
 * exhaustive: each pair here is a genuine, common abbreviation seen in this domain, not a
 * general-purpose thesaurus — a wrong synonym pair silently merges two tokens that were
 * never supposed to be the same word, which is exactly the kind of mistake this module's
 * whole design (favor splitting over merging) argues against making casually.
 */
const SYNONYMS: Record<string, string> = {
  authentication: "auth", authn: "auth", authorization: "authz",
  database: "db", databases: "db",
  configuration: "config", configurations: "config",
  documentation: "docs", environment: "env", environments: "env",
  repository: "repo", repositories: "repo",
  application: "app", applications: "app",
  performance: "perf", administrator: "admin", administrators: "admin",
  dependency: "dep", dependencies: "dep",
  notification: "notif", notifications: "notif",
  identifier: "id", identifiers: "id",
  parameter: "param", parameters: "param",
  argument: "arg", arguments: "arg",
  initialize: "init", initialization: "init",
};

/** Scope-narrowing terms (§4's f-list, feature "qualifiers"): the same underlying work
 * read very differently depending on which of these appears. "Add dark mode" and "Add
 * dark mode on mobile" are not the same scope, even sharing every other word — pulled out
 * of the object-token bag for the same reason artifacts and the action verb are, so
 * lexical similarity doesn't quietly ignore a genuine scope difference. */
const QUALIFIER_LEXICON = [
  "mobile", "desktop", "tablet", "ios", "android", "web",
  "production", "prod", "staging", "stage", "development", "dev", "local", "sandbox",
  "v1", "v2", "v3", "v4", "beta", "alpha", "legacy", "deprecated",
  "internal", "external", "public", "private", "admin",
  "windows", "macos", "linux",
];
const QUALIFIER_SET = new Set(QUALIFIER_LEXICON);

/**
 * Concrete references. These are the highest-precision identity signal available and
 * cost nothing to extract, because agents write them in a predictable style.
 */
const ARTIFACT_PATTERNS: RegExp[] = [
  /`([^`\n]{2,80})`/g,                                          // backticked code spans
  /\b[\w@.-]*\/[\w@./-]+\.[a-z]{1,5}\b/gi,                      // qualified file paths
  /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|sql|md|css|scss|ya?ml|toml|py|go|rs|java|rb|php|sh|env)\b/gi,
  /(?<![\w.])\/[a-z0-9_-]+(?:\/[a-z0-9_:{}-]+)*/gi,             // url paths
  /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/g,                      // ENV_VARS
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,                         // snake_case
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g,                               // camelCase
  /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g,                       // PascalCase
  /#\d+\b/g,                                                    // work item keys
];

export type TaskSignature = {
  action: ActionClass;
  objectTokens: string[];   // sorted, stemmed, stopword-free, synonym-canonicalized
  artifacts: string[];      // sorted, normalized
  subsystem: string | null; // ★ E2 — see deriveSubsystem
  criteria: string[];       // ★ E2 — acceptance criteria parsed from the description
  qualifiers: string[];     // ★ E2 — scope-narrowing terms (mobile, production, v2, ...)
  normalized: string;       // canonical string form, the fingerprint input
  raw: string;
};

export type ArtifactKind = "file" | "endpoint" | "symbol" | "env" | "key" | "other";

/** Coarse classification, shared by the blocking index (`lib/dedup/blocking.ts`, which
 * needs it for indexing) and subsystem derivation below (which needs it to tell a real
 * file path apart from a symbol name or an endpoint). Lives here rather than in
 * artifacts.ts because signature.ts is where every other piece of artifact-string
 * classification already lives, and artifacts.ts already depends on this module —
 * putting it there instead would be a real import cycle, not just an inconvenient one. */
export function classifyArtifact(artifact: string): ArtifactKind {
  if (/^#\d+$/.test(artifact)) return "key";
  if (/^\//.test(artifact) && !/\.[a-z0-9]{1,5}$/i.test(artifact)) return "endpoint";
  if (/[/\\]/.test(artifact) || /\.[a-z0-9]{1,5}$/i.test(artifact)) return "file";
  if (/^[A-Z][A-Z0-9_]+$/.test(artifact)) return "env";
  if (/[a-z]/.test(artifact)) return "symbol";
  return "other";
}

/**
 * Deliberately crude stemming. Consistency matters far more than linguistic accuracy
 * here: both sides of a comparison get identical treatment, so a word this stems badly
 * is stemmed the same way on both sides. Morphology it genuinely misses ends in a
 * split, which is the safe direction to be wrong in.
 */
function stem(word: string) {
  let out = word;
  if (out.length > 4 && out.endsWith("ies")) out = `${out.slice(0, -3)}y`;
  else if (out.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(out)) out = out.slice(0, -2);
  else if (out.length > 3 && out.endsWith("s") && !out.endsWith("ss")) out = out.slice(0, -1);
  if (out.length > 5 && out.endsWith("ing")) out = out.slice(0, -3);
  else if (out.length > 4 && out.endsWith("ed")) out = out.slice(0, -2);
  if (out.length > 4 && out.endsWith("e")) out = out.slice(0, -1);
  return out;
}

/** Synonym canonicalization runs before stemming, on the raw lowercased word: stemming's
 * crude suffix rules would never turn "authentication" into "auth" on their own, so the
 * lexicon has to intercept it first. A word with no listed synonym passes through
 * unchanged and stemming proceeds exactly as it did before this milestone. */
function canonicalize(word: string) {
  return SYNONYMS[word] ?? word;
}

/** Pulls qualifier words out of a residue, the same "extract and remove" shape artifacts
 * and the action verb already use — a qualifier is scope information, not a word that
 * should count toward ordinary lexical overlap. Matched on canonicalized/stemmed form so
 * "mobiles" or any near-variant still matches the fixed lexicon. */
function extractQualifiers(text: string): { qualifiers: string[]; rest: string } {
  const words = text.split(/[\s-]+/).filter(Boolean);
  const qualifiers: string[] = [];
  const kept: string[] = [];
  for (const word of words) {
    const cleaned = word.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (QUALIFIER_SET.has(cleaned)) qualifiers.push(cleaned);
    else kept.push(word);
  }
  return { qualifiers: [...new Set(qualifiers)].sort(), rest: kept.join(" ") };
}

const CRITERIA_SECTION_HEADER = /^\s*(acceptance criteria|criteria|requirements|ac)\s*:?\s*$/i;
const CRITERIA_CHECKLIST = /^\s*[-*]\s*\[[ xX]\]\s*(.+)$/;
const CRITERIA_BDD = /^\s*(given|when|then|and)\s+(.+)$/i;
const CRITERIA_BULLET = /^\s*[-*]\s+(.+)$/;
const CRITERIA_NUMBERED = /^\s*\d+[.)]\s+(.+)$/;

function normalizeCriterion(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

/**
 * Acceptance criteria parsed from a description (§4's feature f9). Three shapes an agent
 * or a person actually writes: a markdown checklist (`- [ ] the token is rejected after
 * expiry`), Given/When/Then lines anywhere in the text, and a plain bullet or numbered
 * list following a recognizable heading like "Acceptance criteria:". Deliberately not a
 * general-purpose outline parser — most descriptions have none of these, and f9's own
 * spec note ("absent for most items — FS handles missing features properly") says that is
 * expected, not a gap to force-fill.
 */
export function extractCriteria(description: string): string[] {
  const criteria: string[] = [];
  let inSection = false;
  for (const rawLine of description.split("\n")) {
    const line = rawLine.trimEnd();
    if (CRITERIA_SECTION_HEADER.test(line)) { inSection = true; continue; }
    const checklist = CRITERIA_CHECKLIST.exec(line);
    if (checklist) { criteria.push(normalizeCriterion(checklist[1])); continue; }
    const bdd = CRITERIA_BDD.exec(line);
    if (bdd) { criteria.push(normalizeCriterion(line.trim())); continue; }
    if (inSection) {
      if (!line.trim()) { inSection = false; continue; }
      const bullet = CRITERIA_BULLET.exec(line) ?? CRITERIA_NUMBERED.exec(line);
      if (bullet) { criteria.push(normalizeCriterion(bullet[1])); continue; }
    }
  }
  return [...new Set(criteria)].filter((entry) => entry.length > 0).slice(0, 20).map((entry) => entry.slice(0, 200));
}

/**
 * Subsystem derivation (§4's f5, §7's forward reference), scoped to what this milestone
 * can actually ground: the item's *own* mentioned file paths, not yet the real repository
 * tree. Takes the directory portion of every file-kind artifact, capped to two path
 * segments, and returns whichever one recurs most among this item's own artifacts —
 * "apps/web/lib/dedup/blocking.ts" contributes "apps/web", so two items both naming files
 * under `apps/web` read as the same subsystem even if the exact file differs.
 *
 * E7's repo grounding is where this gets sharper: a real prefix tree over the actual
 * repository structure, cut where branching factor peaks (§7), rather than a fixed
 * two-segment guess. That needs the bridge's tree-sitter symbol table, which does not
 * exist yet; this is the honest version buildable from data the product already has.
 */
export function deriveSubsystem(artifacts: string[]): string | null {
  const directories = artifacts
    .filter((artifact) => artifact.includes("/") && classifyArtifact(artifact) === "file")
    .map((artifact) => artifact.split("/").slice(0, -1).slice(0, 2).join("/"))
    .filter(Boolean);
  if (!directories.length) return null;
  const counts = new Map<string, number>();
  for (const directory of directories) counts.set(directory, (counts.get(directory) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

export type SubsystemRelation = "same" | "adjacent" | "different" | "unknown";

/** "unknown" when either side has no derivable subsystem at all — absence of evidence,
 * not evidence of difference, matching how a missing feature is handled everywhere else
 * in this design (§4.2). "adjacent" when one subsystem is a path-prefix of the other:
 * "apps/web" and "apps/web/lib" are the same area of the codebase at different depths,
 * not two different ones. */
export function compareSubsystems(a: string | null, b: string | null): SubsystemRelation {
  if (!a || !b) return "unknown";
  if (a === b) return "same";
  if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return "adjacent";
  return "different";
}

function normalizeArtifact(value: string) {
  return value.trim().toLowerCase().replace(/^\.\//, "").replace(/[.,;:!?)\]}]+$/, "").replace(/^[([{]+/, "");
}

export function extractArtifacts(text: string) {
  const found = new Set<string>();
  let residue = text;
  for (const pattern of ARTIFACT_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const value = normalizeArtifact(match[1] ?? match[0]);
      // Single short lowercase words are ordinary prose, not references.
      if (value.length < 3 || (!/[/._#@-]/.test(value) && !/[A-Z]/.test(match[1] ?? match[0]))) continue;
      found.add(value);
      residue = residue.replace(match[0], " ");
    }
  }
  return { artifacts: [...found].sort(), residue };
}

/** Finds the action verb, preferring the imperative at the start of the title. */
export function extractAction(text: string): { action: ActionClass; rest: string } {
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  for (let start = 0; start < Math.min(words.length, 3); start++) {
    for (let span = Math.min(MAX_VERB_WORDS, words.length - start); span >= 1; span--) {
      const phrase = words.slice(start, start + span).join(" ");
      const action = VERB_LOOKUP.get(phrase);
      if (action) return { action, rest: [...words.slice(0, start), ...words.slice(start + span)].join(" ") };
    }
  }
  return { action: "unknown", rest: words.join(" ") };
}

export function buildSignature(title: string, description = ""): TaskSignature {
  const raw = title.trim();
  // Descriptions contribute artifacts but not object tokens; they are too noisy to
  // compare as bags of words, and their artifact references are what disambiguate.
  const { artifacts: titleArtifacts, residue } = extractArtifacts(raw);
  const { artifacts: bodyArtifacts } = extractArtifacts(description.slice(0, 2000));
  const { action, rest } = extractAction(residue);
  // Qualifiers come out of the residue the same way the action verb and artifacts
  // already do, before what's left becomes the plain lexical-overlap bag — a qualifier
  // is scope information (§4.1's own comparison feature), not ordinary vocabulary.
  const { qualifiers, rest: withoutQualifiers } = extractQualifiers(rest);
  const objectTokens = [...new Set(
    withoutQualifiers.split(/[\s-]+/).map((word) => word.replace(/[^a-z0-9]/g, "")).filter((word) => word.length > 1 && !STOPWORDS.has(word)).map((word) => stem(canonicalize(word))),
  )].sort();
  const artifacts = [...new Set([...titleArtifacts, ...bodyArtifacts])].sort();
  const criteria = extractCriteria(description);
  const subsystem = deriveSubsystem(artifacts);
  return {
    action, objectTokens, artifacts, subsystem, criteria, qualifiers,
    normalized: `${action}|${objectTokens.join(" ")}|${artifacts.join(" ")}|${subsystem ?? ""}|${qualifiers.join(" ")}|${criteria.join(";")}`,
    raw,
  };
}

export function actionsAreAntonyms(a: ActionClass, b: ActionClass) {
  return ANTONYMS.some(([left, right]) => (a === left && b === right) || (a === right && b === left));
}

/** `unknown` is a wildcard: an unclassifiable verb must not veto an otherwise good match. */
export function actionsCompatible(a: ActionClass, b: ActionClass) {
  if (a === "unknown" || b === "unknown") return true;
  return a === b;
}

export function jaccard(a: string[], b: string[]) {
  if (!a.length && !b.length) return 1;
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export async function fingerprint(signature: TaskSignature) {
  const bytes = new TextEncoder().encode(signature.normalized);
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
