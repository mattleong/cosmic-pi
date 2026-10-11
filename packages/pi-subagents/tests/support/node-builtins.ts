import type { NodeChildProcess } from "../../src/boundary/node-builtins.ts";

export {
  nodeFsPromises,
  nodePath,
  nodeSpawn,
  type NodeChildProcess,
} from "../../src/boundary/node-builtins.ts";
export interface NodeChildProcessWithoutNullStreams extends NodeChildProcess {
  readonly stdin: NonNullable<NodeChildProcess["stdin"]>;
  readonly stdout: NonNullable<NodeChildProcess["stdout"]>;
  readonly stderr: NonNullable<NodeChildProcess["stderr"]>;
}
