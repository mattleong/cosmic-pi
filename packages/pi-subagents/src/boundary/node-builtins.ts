// Raw Node builtin access for boundary adapters whose contracts the Effect FileSystem,
// Path, and ChildProcess services cannot express: detached process-group spawns with
// caller-owned stdio, permission- and flag-constrained private harness files, and native
// platform path semantics.
const childProcessModule = process.getBuiltinModule("node:child_process");
const fsModule = process.getBuiltinModule("node:fs");
const pathModule = process.getBuiltinModule("node:path");
if (!childProcessModule || !fsModule || !pathModule) {
  throw new Error("Node child_process/fs/path builtins are unavailable.");
}

export const nodeSpawn = childProcessModule.spawn;
export type NodeChildProcess = InstanceType<typeof childProcessModule.ChildProcess>;
export const nodeFsConstants = fsModule.constants;
export const nodeFsPromises = fsModule.promises;
export const nodePath = pathModule;
