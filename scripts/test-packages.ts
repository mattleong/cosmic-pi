import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

const cpus = availableParallelism();
const packages = cpus >= 4 ? 2 : 1;
const workers = Math.max(1, Math.min(4, Math.floor(cpus / packages)));
const timeout = cpus >= 4 ? [] : ["--testTimeout=20000"];

const agentDirectory = mkdtempSync(join(tmpdir(), "cosmic-pi-test-agent-"));
try {
  const run = spawnSync(
    "pnpm",
    [
      `--workspace-concurrency=${packages}`,
      "-r",
      "--no-bail",
      "exec",
      "vitest",
      "run",
      "--allowOnly=false",
      `--maxWorkers=${workers}`,
      ...timeout,
    ],
    { stdio: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory } },
  );
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(agentDirectory, { recursive: true, force: true });
}
