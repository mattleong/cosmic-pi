const childProcessModule = process.getBuiltinModule("node:child_process");
const fsModule = process.getBuiltinModule("node:fs");
const osModule = process.getBuiltinModule("node:os");
const pathModule = process.getBuiltinModule("node:path");
const cryptoModule = process.getBuiltinModule("node:crypto");
if (!childProcessModule || !fsModule || !osModule || !pathModule || !cryptoModule) {
  throw new Error("Node child_process/fs/os/path/crypto builtins are unavailable.");
}

export const nodeSpawn = childProcessModule.spawn;
export type NodeChildProcess = InstanceType<typeof childProcessModule.ChildProcess>;
export const nodeFsConstants = fsModule.constants;
export const nodeFsPromises = fsModule.promises;
export const nodeMkdirSync = fsModule.mkdirSync;
export const nodeWriteFileSync = fsModule.writeFileSync;
export const nodeReadFileSync = fsModule.readFileSync;
export const nodeWriteSync = fsModule.writeSync;
export const nodeCreateHash = cryptoModule.createHash;
export const nodePath = pathModule;
export const nodeAvailableParallelism = osModule.availableParallelism;
export const nodeUptime = osModule.uptime;
