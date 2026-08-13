/**
 * M15 — the bridge hook's own repo-state reporting.
 *
 * A real subprocess integration test, not a unit test: it git-inits a temp directory,
 * spawns the actual `integrations/bridge/planbraid-hook.mjs` script (not a reimplementation
 * of its logic) against a stub HTTP server standing in for the Planbraid MCP endpoint, and
 * asserts on the exact JSON-RPC body the hook sent. This is the only layer that can catch
 * a real bug in how the script shells out to `git` — lib/evidence/ingest.ts's own tests
 * already cover everything on the server side of that boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const execFileAsync = promisify(execFile);
const hookPath = fileURLToPath(new URL("../../../integrations/bridge/planbraid-hook.mjs", import.meta.url));

async function initGitRepo() {
  const dir = await mkdtemp(join(tmpdir(), "planbraid-bridge-"));
  const git = (...args) => execFileAsync("git", args, { cwd: dir });
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
  await git("add", "a.ts");
  await git("commit", "-q", "-m", "initial");
  return dir;
}

/** A stub MCP endpoint that records every tools/call body it receives and replies with a
 * minimal, structurally valid result so the hook's own response handling doesn't throw. */
function startStubServer() {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      calls.push(parsed);
      const name = parsed.params?.name;
      const structuredContent = name === "register_agent_session" ? { sourceId: "src_test" } : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { structuredContent } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

async function runHook(payload, env) {
  await execFileAsync("node", [hookPath, JSON.stringify(payload)], { env: { ...process.env, ...env } });
}

test("a Stop event reports real git state: head sha, branch, and the changed file", async () => {
  const dir = await initGitRepo();
  const { server, calls, url } = await startStubServer();
  try {
    await writeFile(join(dir, "a.ts"), "export const a = 2;\n");
    const { stdout: headSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
    const { stdout: branchName } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });

    await runHook(
      { hook_event_name: "Stop", session_id: "sess-1", last_assistant_message: "done" },
      { PLANBRAID_MCP_URL: url, PLANBRAID_PROJECT_ID: "prj_test", PLANBRAID_PROVIDER: "claude", PLANBRAID_REPO_DIR: dir, PLANBRAID_STATE_DIR: dir },
    );

    const reported = calls.find((call) => call.params?.name === "report_repo_state");
    assert.ok(reported, "expected a report_repo_state call");
    assert.equal(reported.params.arguments.head_sha, headSha.trim());
    assert.equal(reported.params.arguments.branch, branchName.trim());
    assert.ok(reported.params.arguments.changed_paths.includes("a.ts"), `expected a.ts among ${JSON.stringify(reported.params.arguments.changed_paths)}`);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("PLANBRAID_DISABLE_REPO_STATE=1 skips reporting entirely", async () => {
  const dir = await initGitRepo();
  const { server, calls, url } = await startStubServer();
  try {
    await runHook(
      { hook_event_name: "Stop", session_id: "sess-2", last_assistant_message: "done" },
      { PLANBRAID_MCP_URL: url, PLANBRAID_PROJECT_ID: "prj_test", PLANBRAID_PROVIDER: "claude", PLANBRAID_REPO_DIR: dir, PLANBRAID_STATE_DIR: dir, PLANBRAID_DISABLE_REPO_STATE: "1" },
    );

    assert.ok(!calls.some((call) => call.params?.name === "report_repo_state"), "reporting must be fully skipped when disabled");
    assert.ok(calls.some((call) => call.params?.name === "sync_interaction"), "disabling repo state must not disable the rest of the turn-end sync");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("PLANBRAID_VERIFY_COMMAND's exit code is reported, never its output", async () => {
  const dir = await initGitRepo();
  const { server, calls, url } = await startStubServer();
  try {
    // The command text itself is legitimately reported ("the record of what ran"); what
    // must never appear is its *output*. Reversing a string produces output distinct from
    // the command's own literal text, so a leak of stdout is distinguishable from the
    // expected, harmless presence of the command string.
    await runHook(
      { hook_event_name: "Stop", session_id: "sess-3", last_assistant_message: "done" },
      { PLANBRAID_MCP_URL: url, PLANBRAID_PROJECT_ID: "prj_test", PLANBRAID_PROVIDER: "claude", PLANBRAID_REPO_DIR: dir, PLANBRAID_STATE_DIR: dir, PLANBRAID_VERIFY_COMMAND: "echo top-secret-output | rev" },
    );

    const reported = calls.find((call) => call.params?.name === "report_repo_state");
    assert.ok(reported);
    assert.equal(reported.params.arguments.verification_command, "echo top-secret-output | rev");
    assert.equal(reported.params.arguments.verification_exit_code, 0);
    assert.ok(!JSON.stringify(calls).includes("tuptuo-terces-pot"), "the command's stdout must never reach Planbraid");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("M17: a deleted file is reported in deleted_paths, and also still in changed_paths", async () => {
  const dir = await initGitRepo();
  const { server, calls, url } = await startStubServer();
  try {
    const { rm: rmFile } = await import("node:fs/promises");
    await rmFile(join(dir, "a.ts"));

    await runHook(
      { hook_event_name: "Stop", session_id: "sess-5", last_assistant_message: "done" },
      { PLANBRAID_MCP_URL: url, PLANBRAID_PROJECT_ID: "prj_test", PLANBRAID_PROVIDER: "claude", PLANBRAID_REPO_DIR: dir, PLANBRAID_STATE_DIR: dir },
    );

    const reported = calls.find((call) => call.params?.name === "report_repo_state");
    assert.ok(reported);
    assert.ok(reported.params.arguments.changed_paths.includes("a.ts"));
    assert.ok(reported.params.arguments.deleted_paths.includes("a.ts"), `expected a.ts in deleted_paths, got ${JSON.stringify(reported.params.arguments.deleted_paths)}`);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("M17: a modified (not deleted) file never appears in deleted_paths", async () => {
  const dir = await initGitRepo();
  const { server, calls, url } = await startStubServer();
  try {
    await writeFile(join(dir, "a.ts"), "export const a = 3;\n");

    await runHook(
      { hook_event_name: "Stop", session_id: "sess-6", last_assistant_message: "done" },
      { PLANBRAID_MCP_URL: url, PLANBRAID_PROJECT_ID: "prj_test", PLANBRAID_PROVIDER: "claude", PLANBRAID_REPO_DIR: dir, PLANBRAID_STATE_DIR: dir },
    );

    const reported = calls.find((call) => call.params?.name === "report_repo_state");
    assert.ok(reported);
    assert.ok(reported.params.arguments.changed_paths.includes("a.ts"));
    assert.deepEqual(reported.params.arguments.deleted_paths, []);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a non-zero PLANBRAID_VERIFY_COMMAND exit code is reported as a failure, not silently dropped", async () => {
  const dir = await initGitRepo();
  const { server, calls, url } = await startStubServer();
  try {
    await runHook(
      { hook_event_name: "Stop", session_id: "sess-4", last_assistant_message: "done" },
      { PLANBRAID_MCP_URL: url, PLANBRAID_PROJECT_ID: "prj_test", PLANBRAID_PROVIDER: "claude", PLANBRAID_REPO_DIR: dir, PLANBRAID_STATE_DIR: dir, PLANBRAID_VERIFY_COMMAND: "exit 1" },
    );

    const reported = calls.find((call) => call.params?.name === "report_repo_state");
    assert.ok(reported);
    assert.equal(reported.params.arguments.verification_exit_code, 1);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
