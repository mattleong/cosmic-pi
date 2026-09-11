// Opt-in upstream wire checks, not part of validate or the unit suite. No auth scenarios.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Conformance check interrupted."));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

function killGroup(pid, signal) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function runScenario(executable, scenario, scratch, environment) {
  abort.signal.throwIfAborted();
  const child = spawn(
    process.execPath,
    [
      executable,
      "client",
      "--command",
      // Upstream splits on spaces and uses shell:true. Keep this fixed and relative to root.
      "node scripts/mcp-conformance-driver.mjs",
      "--scenario",
      scenario,
      "--timeout",
      "90000",
      "--output-dir",
      join(scratch, "output"),
    ],
    { cwd: root, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = Buffer.alloc(0);
  let failure;
  let escalation;
  const capture = (chunk) => {
    output = Buffer.concat([output, chunk]).subarray(-32 * 1024);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("error", (error) => {
    failure ??= error;
  });
  const stop = (error) => {
    failure ??= error;
    killGroup(child.pid, "SIGTERM");
    escalation ??= setTimeout(() => killGroup(child.pid, "SIGKILL"), 2000);
  };
  const onAbort = () => stop(abort.signal.reason);
  abort.signal.addEventListener("abort", onAbort, { once: true });
  if (abort.signal.aborted) onAbort();
  // Own the CLI, shell, and driver together. The upstream shell timeout is not tree cleanup.
  const deadline = setTimeout(
    () => stop(new Error("Conformance process group timed out.")),
    105_000,
  );
  try {
    const code = await new Promise((done) => child.once("close", done));
    if (failure || code !== 0) {
      throw new Error(`${failure?.message ?? `Upstream exited ${code}`}\n${output.toString()}`);
    }
    return output.toString();
  } finally {
    clearTimeout(deadline);
    clearTimeout(escalation);
    abort.signal.removeEventListener("abort", onAbort);
    // Also kill descendants that outlived the CLI and closed their inherited pipes.
    killGroup(child.pid, "SIGKILL");
  }
}

let temporary;
try {
  assert.notEqual(process.platform, "win32", "Conformance requires POSIX process groups.");
  const manifestPath = require.resolve("@modelcontextprotocol/conformance/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.version, "0.1.16", "Expected the pinned upstream grader.");
  const executable = join(dirname(manifestPath), "dist/index.js");
  temporary = await realpath(await mkdtemp(join(tmpdir(), "cosmic-mcp-conformance-")));
  const failures = [];
  for (const scenario of ["initialize", "tools_call"]) {
    abort.signal.throwIfAborted();
    const scratch = join(temporary, scenario);
    await mkdir(scratch);
    for (const name of ["home", "tmp", "output"]) await mkdir(join(scratch, name));
    const workspace = join(scratch, "workspace");
    const receipt = join(scratch, "receipt.json");
    const token = randomUUID();
    const environment = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: join(scratch, "home"),
      TMPDIR: join(scratch, "tmp"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_MCP_CONFORMANCE_ROOT: temporary,
      PI_MCP_CONFORMANCE_WORKDIR: workspace,
      PI_MCP_CONFORMANCE_RECEIPT: receipt,
      PI_MCP_CONFORMANCE_TOKEN: token,
    };
    try {
      const output = await runScenario(executable, scenario, scratch, environment);
      const metadata = await lstat(receipt);
      assert.ok(metadata.isFile() && metadata.size <= 1024, "Invalid cleanup receipt file.");
      assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), {
        scenario,
        token,
        cleanup: "confirmed",
      });
      await assert.rejects(lstat(workspace), { code: "ENOENT" }, "Driver workspace remains.");
      console.log(`${scenario}: passed with confirmed application cleanup.\n${output}`);
    } catch (error) {
      failures.push(scenario);
      console.error(`${scenario}: failed\n${String(error).slice(0, 36 * 1024)}`);
    }
  }
  assert.deepEqual(failures, [], `Conformance failed: ${failures.join(", ")}`);
} catch (error) {
  console.error(String(error).slice(0, 4096));
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
}
