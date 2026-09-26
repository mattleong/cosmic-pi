// Real temporary directories for Promise-shaped tests; Effect tests use core `temporaryDirectory`.
import { tmpdir } from "node:os";
import { nodeFsPromises as fs, nodePath } from "./node-builtins.ts";

const directories: string[] = [];

/** Creates a directory under the OS temporary root that `removeTemporaryDirectories` removes. */
export const makeTemporaryDirectory = (prefix: string): Promise<string> =>
  fs.mkdtemp(nodePath.join(tmpdir(), prefix)).then((directory) => {
    directories.push(directory);
    return directory;
  });

/** Removes every directory made since the last call; register it with `afterEach`. */
export const removeTemporaryDirectories = (): Promise<void> =>
  Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  ).then(() => undefined);
