const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");

export const nodeFsConstants = nodeFsModule.constants;
export const nodeFsPromises = nodeFsModule.promises;
export const nodePath = nodePathModule;
export const nodeLockFs = {
  mkdirSync: nodeFsModule.mkdirSync,
  lstatSync: nodeFsModule.lstatSync,
  openSync: nodeFsModule.openSync,
  fstatSync: nodeFsModule.fstatSync,
  readFileSync: nodeFsModule.readFileSync,
  readdirSync: nodeFsModule.readdirSync,
  writeFileSync: nodeFsModule.writeFileSync,
  fsyncSync: nodeFsModule.fsyncSync,
  closeSync: nodeFsModule.closeSync,
  renameSync: nodeFsModule.renameSync,
  unlinkSync: nodeFsModule.unlinkSync,
  rmdirSync: nodeFsModule.rmdirSync,
};
const nodeOsModule = process.getBuiltinModule("node:os");
if (!nodeOsModule) throw new Error("Node OS builtins are unavailable.");
export const nodeDisplayHomeDirectory = () => nodeOsModule.homedir();
export const nodeTemporaryRoot = () => nodeOsModule.tmpdir();

const nodeChildProcessModule = process.getBuiltinModule("node:child_process");
if (!nodeChildProcessModule) throw new Error("Node child-process builtin is unavailable.");
export const nodeSpawn = nodeChildProcessModule.spawn;
export const nodeSpawnSync = nodeChildProcessModule.spawnSync;
