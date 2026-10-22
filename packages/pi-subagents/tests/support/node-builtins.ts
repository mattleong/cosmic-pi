import type { NodeChildProcess } from "pi-cosmic-core";

export { nodeFs, nodeFsPromises, nodePath, nodeSpawn, type NodeChildProcess } from "pi-cosmic-core";
export interface NodeChildProcessWithoutNullStreams extends NodeChildProcess {
  readonly stdin: NonNullable<NodeChildProcess["stdin"]>;
  readonly stdout: NonNullable<NodeChildProcess["stdout"]>;
  readonly stderr: NonNullable<NodeChildProcess["stderr"]>;
}
