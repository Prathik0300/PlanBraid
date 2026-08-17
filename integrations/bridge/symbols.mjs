/**
 * E7 — optional tree-sitter symbol extraction (RECONCILIATION_ARCHITECTURE.md §7, "Level
 * 1: symbol table via tree-sitter"), scoped to TypeScript/JavaScript only — the honest
 * subset of the doc's general multi-language claim that's actually built and tested here.
 *
 * Entirely best-effort, matching every other optional piece of this bridge: if
 * `web-tree-sitter`/`tree-sitter-wasms` aren't installed (`npm install` was never run in
 * this directory — see package.json, and the bridge itself needs neither package to do
 * its own core job), `extractSymbols` returns `[]` silently rather than throwing. A
 * missing optional dependency must never be what blocks a turn.
 *
 * `web-tree-sitter` is pinned to the exact version `0.25.10`, not a caret range: newer
 * `0.26.x` builds fail to load `tree-sitter-wasms`' prebuilt `.wasm` grammars entirely
 * (an emscripten/dylink metadata mismatch between the two packages' independent release
 * cadences, confirmed directly before writing this file — 0.26.12 throws on
 * `Language.load`, 0.25.10 parses correctly). `tree-sitter-wasms` is pinned exactly for
 * the same reason: this specific pairing is the one actually verified to work, and a
 * silent minor-version bump on either side could silently reintroduce that mismatch.
 *
 * Extracts identifier NAMES, KINDS, and FILE:LINE only — never source text. This is the
 * same class of information `report_repo_state` already sends (file paths), one level
 * more granular (identifiers within those paths), not a new category of data leaving the
 * machine. The bridge's own capture guarantee ("never file contents or diffs") is about
 * not leaking prose, business logic, or transcript content; a symbol name and its
 * location carries materially less than that, comparable to a changed-file path itself.
 */
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const GRAMMAR_BY_EXTENSION = {
  ".ts": "tree-sitter-typescript.wasm",
  ".mts": "tree-sitter-typescript.wasm",
  ".cts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript.wasm",
};

/** Declaration node types tree-sitter's TS/JS/TSX grammars use, mapped to the coarse
 * kind vocabulary `repo_symbols` stores. `variable_declarator` is handled separately
 * below — only when its value is a function — since most variable declarations aren't
 * symbols worth indexing at all (a plain `const x = 1` is noise, not a resolvable
 * artifact a proposal would ever reference). */
const KIND_BY_NODE_TYPE = {
  function_declaration: "function",
  class_declaration: "class",
  method_definition: "method",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
};

const MAX_FILES_PER_TURN = 40;
const MAX_SYMBOLS = 2000;
/** Files above this size are skipped, not truncated-and-parsed — a partial parse of a
 * huge generated file is more likely to produce garbage than a useful symbol. */
const MAX_FILE_BYTES = 400_000;

let cachedParsers = null; // Map<wasmFileName, Parser> once loaded, or `false` if unavailable

async function loadParsers() {
  if (cachedParsers !== null) return cachedParsers;
  try {
    const { Parser, Language } = await import("web-tree-sitter");
    const here = dirname(fileURLToPath(import.meta.url));
    await Parser.init();
    const wasmDir = join(here, "node_modules", "tree-sitter-wasms", "out");
    const parsers = new Map();
    for (const wasmFile of new Set(Object.values(GRAMMAR_BY_EXTENSION))) {
      const language = await Language.load(join(wasmDir, wasmFile));
      const parser = new Parser();
      parser.setLanguage(language);
      parsers.set(wasmFile, parser);
    }
    cachedParsers = parsers;
  } catch {
    cachedParsers = false;
  }
  return cachedParsers;
}

function walk(node, path, out) {
  const kind = KIND_BY_NODE_TYPE[node.type];
  if (kind) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) out.push({ name: nameNode.text.slice(0, 200), kind, file: path, line: node.startPosition.row + 1 });
  } else if (node.type === "variable_declarator") {
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (nameNode && valueNode && (valueNode.type === "arrow_function" || valueNode.type === "function_expression")) {
      out.push({ name: nameNode.text.slice(0, 200), kind: "function", file: path, line: node.startPosition.row + 1 });
    }
  }
  for (let i = 0; i < node.childCount; i += 1) walk(node.child(i), path, out);
}

/**
 * Extracts symbols from `changedPaths` (relative to `repoDir`). Every failure mode —
 * the optional dependency missing, a file deleted since the diff was computed, a parse
 * error on malformed input — skips that file (or every file) rather than throwing, the
 * same "degraded capture, not a turn-blocking failure" rule `planbraid-hook.mjs`
 * already applies to `report_repo_state` itself.
 */
export async function extractSymbols(repoDir, changedPaths) {
  const parsers = await loadParsers();
  if (!parsers) return [];

  const candidates = changedPaths.filter((path) => GRAMMAR_BY_EXTENSION[extname(path)]).slice(0, MAX_FILES_PER_TURN);
  const symbols = [];
  for (const path of candidates) {
    if (symbols.length >= MAX_SYMBOLS) break;
    const parser = parsers.get(GRAMMAR_BY_EXTENSION[extname(path)]);
    if (!parser) continue;
    try {
      const absolute = join(repoDir, path);
      const stats = await stat(absolute);
      if (stats.size > MAX_FILE_BYTES) continue;
      const code = await readFile(absolute, "utf8");
      const tree = parser.parse(code);
      const fileSymbols = [];
      walk(tree.rootNode, path, fileSymbols);
      symbols.push(...fileSymbols.slice(0, MAX_SYMBOLS - symbols.length));
    } catch {
      continue;
    }
  }
  return symbols;
}
