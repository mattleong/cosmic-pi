import * as NodeChildProcessModule from "node:child_process";
import { EventEmitter } from "node:events";
import * as NodeFs from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

/**
 * Node builtins for boundaries whose protocol Effect's platform modules cannot express, such as
 * no-follow opens, handle-level ownership checks, or synchronous host callbacks. This is the single
 * module exempt from `nodeBuiltinImport`; everything else reaches Node through these exports.
 */
export const nodeFs = NodeFs;
export const nodeFsConstants = NodeFs.constants;
export const nodeFsPromises = NodeFs.promises;
export const nodePath = NodePath;
export const nodeLockFs = {
  mkdirSync: NodeFs.mkdirSync,
  lstatSync: NodeFs.lstatSync,
  openSync: NodeFs.openSync,
  fstatSync: NodeFs.fstatSync,
  readFileSync: NodeFs.readFileSync,
  readdirSync: NodeFs.readdirSync,
  writeFileSync: NodeFs.writeFileSync,
  fsyncSync: NodeFs.fsyncSync,
  fsync: NodeFs.fsync,
  closeSync: NodeFs.closeSync,
  renameSync: NodeFs.renameSync,
  unlinkSync: NodeFs.unlinkSync,
  rmdirSync: NodeFs.rmdirSync,
};
export const nodeIsProxy = NodeUtil.types.isProxy;
export const nodeDisplayHomeDirectory = () => NodeOs.homedir();
export const nodeTemporaryRoot = () => NodeOs.tmpdir();

/** Unix-socket ends for a boundary that speaks from Pi's synchronous callbacks, outside Effect. */
export const nodeCreateConnection = NodeNet.createConnection;
export const nodeCreateServer = NodeNet.createServer;
export const NodeEventEmitter = EventEmitter;

export const nodeSpawn = NodeChildProcessModule.spawn;
export const nodeSpawnSync = NodeChildProcessModule.spawnSync;
export const NodeChildProcess = NodeChildProcessModule.ChildProcess;
export type NodeChildProcess = NodeChildProcessModule.ChildProcess;
