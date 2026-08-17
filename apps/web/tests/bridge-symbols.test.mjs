/**
 * E7 — direct unit tests for the bridge's optional symbol extraction
 * (`integrations/bridge/symbols.mjs`), covering the declaration kinds
 * `tests/bridge-hook.test.mjs`'s single subprocess test doesn't exercise on its own:
 * classes, methods, interfaces, types, enums, arrow-function consts, and the graceful
 * degradation paths (missing file, oversized file, unsupported extension).
 *
 * Runs against real tree-sitter parsing, not a mock, whenever `integrations/bridge`'s
 * optional dependencies happen to be installed (that directory's own package.json,
 * gitignored `node_modules` like every other in this repo — a fresh clone doesn't have
 * it until someone opts in with `npm install` there). `symbols.mjs` itself is built to
 * degrade to reporting no symbols when they're absent (the same contract a real
 * production bridge run gets); these tests degrade the same way — skipped, not failed —
 * rather than asserting a capability that was never installed for them to test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { extractSymbols } = await import(fileURLToPath(new URL("../../../integrations/bridge/symbols.mjs", import.meta.url)));

const parsingAvailable = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), "planbraid-symbols-probe-"));
  try {
    await writeFile(join(dir, "probe.ts"), "export function probeFn() {}\n");
    const symbols = await extractSymbols(dir, ["probe.ts"]);
    return symbols.some((s) => s.name === "probeFn");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();
const skip = parsingAvailable ? false : "integrations/bridge's optional tree-sitter dependencies aren't installed in this environment (run `npm install` in integrations/bridge to enable E7 symbol extraction)";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "planbraid-symbols-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("extracts a class and its method", { skip }, () => withTempDir(async (dir) => {
  await writeFile(join(dir, "widget.ts"), "export class Widget {\n  render() {\n    return null;\n  }\n}\n");
  const symbols = await extractSymbols(dir, ["widget.ts"]);
  assert.ok(symbols.some((s) => s.name === "Widget" && s.kind === "class"));
  assert.ok(symbols.some((s) => s.name === "render" && s.kind === "method"));
}));

test("extracts an interface, a type alias, and an enum", { skip }, () => withTempDir(async (dir) => {
  await writeFile(join(dir, "types.ts"), "export interface Widget { id: string }\nexport type Kind = \"a\" | \"b\";\nexport enum Status { Open, Closed }\n");
  const symbols = await extractSymbols(dir, ["types.ts"]);
  assert.ok(symbols.some((s) => s.name === "Widget" && s.kind === "interface"));
  assert.ok(symbols.some((s) => s.name === "Kind" && s.kind === "type"));
  assert.ok(symbols.some((s) => s.name === "Status" && s.kind === "enum"));
}));

test("extracts an arrow-function const as a function, but not a plain value const", { skip }, () => withTempDir(async (dir) => {
  await writeFile(join(dir, "helpers.ts"), "export const double = (x) => x * 2;\nexport const PI = 3.14;\n");
  const symbols = await extractSymbols(dir, ["helpers.ts"]);
  assert.ok(symbols.some((s) => s.name === "double" && s.kind === "function"));
  assert.ok(!symbols.some((s) => s.name === "PI"), "a plain value binding is not a symbol worth indexing");
}));

test("parses .tsx files (JSX) without crashing and extracts a component function", { skip }, () => withTempDir(async (dir) => {
  await writeFile(join(dir, "Widget.tsx"), "export function Widget({ id }) {\n  return <div>{id}</div>;\n}\n");
  const symbols = await extractSymbols(dir, ["Widget.tsx"]);
  assert.ok(symbols.some((s) => s.name === "Widget" && s.kind === "function" && s.file === "Widget.tsx"));
}));

test("a file with an unsupported extension is skipped without attempting to parse it", { skip }, () => withTempDir(async (dir) => {
  await writeFile(join(dir, "script.py"), "def widget():\n    pass\n");
  const symbols = await extractSymbols(dir, ["script.py"]);
  assert.deepEqual(symbols, []);
}));

test("a path that doesn't exist on disk is skipped, not thrown", { skip }, () => withTempDir(async (dir) => {
  const symbols = await extractSymbols(dir, ["does/not/exist.ts"]);
  assert.deepEqual(symbols, []);
}));

test("one bad file among several does not prevent the others from being parsed", { skip }, () => withTempDir(async (dir) => {
  await writeFile(join(dir, "good.ts"), "export function realFunction() {}\n");
  const symbols = await extractSymbols(dir, ["missing.ts", "good.ts"]);
  assert.ok(symbols.some((s) => s.name === "realFunction"));
}));

test("an oversized file is skipped rather than partially parsed", { skip }, () => withTempDir(async (dir) => {
  const huge = "export function realFunction() {}\n" + "// padding\n".repeat(50000);
  await writeFile(join(dir, "huge.ts"), huge);
  const symbols = await extractSymbols(dir, ["huge.ts"]);
  assert.deepEqual(symbols, [], "a file over the byte cap should be skipped entirely");
}));

test("an empty changed-paths list returns no symbols without loading any parser work", { skip }, () => withTempDir(async (dir) => {
  const symbols = await extractSymbols(dir, []);
  assert.deepEqual(symbols, []);
}));
