/**
 * Structural task identity.
 *
 * Task titles authored by coding agents are short, imperative, and share heavy
 * vocabulary inside a project, so overall wording similarity conflates tasks that
 * differ only in the tokens that matter most ("/api/login" vs "/api/signup").
 * A signature separates the three parts that actually determine identity —
 * the action, the object, and the concrete artifacts — so those can be compared
 * independently and the discriminating parts can veto a match outright.
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
  objectTokens: string[];   // sorted, stemmed, stopword-free
  artifacts: string[];      // sorted, normalized
  normalized: string;       // canonical string form, the fingerprint input
  raw: string;
};

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
  const objectTokens = [...new Set(
    rest.split(/[\s-]+/).map((word) => word.replace(/[^a-z0-9]/g, "")).filter((word) => word.length > 1 && !STOPWORDS.has(word)).map(stem),
  )].sort();
  const artifacts = [...new Set([...titleArtifacts, ...bodyArtifacts])].sort();
  return { action, objectTokens, artifacts, normalized: `${action}|${objectTokens.join(" ")}|${artifacts.join(" ")}`, raw };
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
