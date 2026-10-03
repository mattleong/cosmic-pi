// Raw Node builtin access for boundary adapters whose contracts the Effect FileSystem,
// Path, and ChildProcess services cannot express: detached process-group spawns with
// caller-owned stdio, permission- and flag-constrained private harness files, native
// platform path semantics, and the CPU count.
const childProcessModule = process.getBuiltinModule("node:child_process");
const fsModule = process.getBuiltinModule("node:fs");
const osModule = process.getBuiltinModule("node:os");
const pathModule = process.getBuiltinModule("node:path");
if (!childProcessModule || !fsModule || !osModule || !pathModule) {
  throw new Error("Node child_process/fs/os/path builtins are unavailable.");
}

export const nodeSpawn = childProcessModule.spawn;
export type NodeChildProcess = InstanceType<typeof childProcessModule.ChildProcess>;
export const nodeFsConstants = fsModule.constants;
export const nodeFsPromises = fsModule.promises;
export const nodePath = pathModule;
/** Logical CPUs available to this process, which bounds workflow agent concurrency. */
export const nodeAvailableParallelism = osModule.availableParallelism;
