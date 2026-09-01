// Raw Node builtin access for shared test fixture scaffolding, mirroring
// pi-cosmic-core's platform boundary; these Promise-shaped fixture lifetimes
// intentionally stay outside the Effect FileSystem service.
import { tmpdir } from "node:os";

const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { mkdtemp, rm } = nodeFsModule.promises;
const { join } = nodePathModule;

const testTempDirectories = new Set<string>();

export function createTestTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix)).then((directory) => {
    testTempDirectories.add(directory);
    return directory;
  });
}

export function cleanupTestTempDirectories(): Promise<void> {
  const directories = [...testTempDirectories];
  return Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }).then(() => {
        testTempDirectories.delete(directory);
      }),
    ),
  ).then(() => undefined);
}
