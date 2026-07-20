// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/globalConsole:off
// @effect-diagnostics effect/globalDate:off
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testTempDirectories = new Set<string>();

export async function createTestTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  testTempDirectories.add(directory);
  return directory;
}

export async function cleanupTestTempDirectories(): Promise<void> {
  const directories = [...testTempDirectories];
  await Promise.all(
    directories.map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      testTempDirectories.delete(directory);
    }),
  );
}
