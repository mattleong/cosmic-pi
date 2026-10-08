// Raw Node builtins for harnesses that exercise or guard native platform APIs, shared with the
// boundary adapters whose contracts the Effect FileSystem and process services cannot express.
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
