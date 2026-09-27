// Raw Node builtin access for adapters whose contracts the Effect FileSystem and
// Path services cannot express: O_NOFOLLOW opens, inode identity checks, and
// native platform path semantics. Duplex processes use the child-process door
// for callback-backed stdin writes and detached process-group ownership, and the
// Windows process-tree terminator uses it for its synchronously cancellable taskkill.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");

export const nodeFsConstants = nodeFsModule.constants;
export const nodeFsPromises = nodeFsModule.promises;
export const nodePath = nodePathModule;
// Cross-process ownership needs short synchronous commits with no cancellation gap.
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
const nodeCryptoModule = process.getBuiltinModule("node:crypto");
const nodeOsModule = process.getBuiltinModule("node:os");
if (!nodeCryptoModule || !nodeOsModule) throw new Error("Node crypto/os builtins are unavailable.");
export const nodeLockRandomToken = () => nodeCryptoModule.randomBytes(32).toString("hex");
export const nodeLockHash = (value: string) =>
  nodeCryptoModule.createHash("sha256").update(value).digest("hex");
/** OS account lookup, deliberately independent of HOME and Pi's agent directory. */
export const nodeHomeDirectory = () => nodeOsModule.userInfo().homedir;
/** The home directory users see in paths, which follows HOME. Display only, never ownership. */
export const nodeDisplayHomeDirectory = () => nodeOsModule.homedir();
/** Test kits only: the OS temporary-directory root. */
export const nodeTemporaryRoot = () => nodeOsModule.tmpdir();

const nodeChildProcessModule = process.getBuiltinModule("node:child_process");
if (!nodeChildProcessModule) throw new Error("Node child-process builtin is unavailable.");
export const nodeSpawn = nodeChildProcessModule.spawn;
export type { ChildProcessWithoutNullStreams as DuplexProcessChild } from "node:child_process";

const nodeDnsModule = process.getBuiltinModule("node:dns");
const nodeHttpModule = process.getBuiltinModule("node:http");
if (!nodeDnsModule || !nodeHttpModule) throw new Error("Node DNS/HTTP builtins are unavailable.");
export const nodeLookup = nodeDnsModule.lookup;
export const nodeCreateHttpServer = nodeHttpModule.createServer;

/** Open lazily so native-context acquisition owns and redacts availability failures. */
export const nodeCreateAsyncLocalStorage = <A>() => {
  const module = process.getBuiltinModule("node:async_hooks");
  if (!module) throw new Error("Node async-context builtin is unavailable.");
  return new module.AsyncLocalStorage<A>();
};
