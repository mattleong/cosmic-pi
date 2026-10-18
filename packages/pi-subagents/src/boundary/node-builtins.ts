const childProcessModule = process.getBuiltinModule("node:child_process");
const fsModule = process.getBuiltinModule("node:fs");
const pathModule = process.getBuiltinModule("node:path");
const cryptoModule = process.getBuiltinModule("node:crypto");
if (!childProcessModule || !fsModule || !pathModule || !cryptoModule) {
  throw new Error("Node child_process/fs/path/crypto builtins are unavailable.");
}

export const nodeSpawn = childProcessModule.spawn;
export type NodeChildProcess = InstanceType<typeof childProcessModule.ChildProcess>;
export const nodeFsConstants = fsModule.constants;
export const nodeFsPromises = fsModule.promises;
export const nodeMkdirSync = fsModule.mkdirSync;
export const nodeWriteFileSync = fsModule.writeFileSync;
export const nodeCreateHash = cryptoModule.createHash;
export const nodePath = pathModule;
