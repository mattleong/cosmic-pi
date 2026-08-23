// Raw Node builtin access for harnesses that exercise or guard native platform APIs
// whose contracts the Effect FileSystem and process services cannot express.
const childProcessModule = process.getBuiltinModule("node:child_process");
const fsModule = process.getBuiltinModule("node:fs");
const pathModule = process.getBuiltinModule("node:path");
if (!childProcessModule || !fsModule || !pathModule)
  throw new Error("Node child_process/fs/path builtins are unavailable.");

export const nodeChildProcess = childProcessModule;
export const nodeFsPromises = fsModule.promises;
export const nodePath = pathModule;
