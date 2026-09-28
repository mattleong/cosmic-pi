// Runs every package's tests the way CI does. Every package runs even when an earlier one fails,
// and Pi's agent directory points at an empty temporary directory, so personal settings such
// as ~/.pi/agent/code-previews.json cannot change results.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDirectory = mkdtempSync(join(tmpdir(), "cosmic-pi-test-agent-"));
try {
  const run = spawnSync(
    "pnpm",
    ["--workspace-concurrency=2", "-r", "--no-bail", "exec", "vitest", "run", "--maxWorkers=4"],
    { stdio: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory } },
  );
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(agentDirectory, { recursive: true, force: true });
}
