// Raw Node builtin access for adapters whose contracts the Effect FileSystem and
// Path services cannot express: O_NOFOLLOW opens, inode identity checks, and
// native platform path semantics. Duplex processes use the child-process door
// for callback-backed stdin writes and detached process-group ownership.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");

export const nodeFsConstants = nodeFsModule.constants;
export const nodeFsPromises = nodeFsModule.promises;
export const nodePath = nodePathModule;

const nodeChildProcessModule = process.getBuiltinModule("node:child_process");
if (!nodeChildProcessModule) throw new Error("Node child-process builtin is unavailable.");
export const nodeSpawn = nodeChildProcessModule.spawn;
export type { ChildProcessWithoutNullStreams as DuplexProcessChild } from "node:child_process";

const nodeDnsModule = process.getBuiltinModule("node:dns");
const nodeHttpModule = process.getBuiltinModule("node:http");
if (!nodeDnsModule || !nodeHttpModule) throw new Error("Node DNS/HTTP builtins are unavailable.");
export const nodeLookup = nodeDnsModule.lookup;
export const nodeCreateHttpServer = nodeHttpModule.createServer;
