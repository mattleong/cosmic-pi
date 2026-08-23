// Synchronous, pure path arithmetic is confined to this explicit boundary; native
// platform path semantics are not expressible through the Effect Path service here.
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodePathModule) throw new Error("Node path builtin is unavailable.");

export const nodeDirname = nodePathModule.dirname;
export const nodeJoin = nodePathModule.join;
