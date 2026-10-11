const nodePath = process.getBuiltinModule("node:path");
if (!nodePath) throw new Error("Node path APIs are unavailable.");

export const nodeBasename = nodePath.basename.bind(nodePath);
export const nodeJoin = nodePath.join.bind(nodePath);
export const nodeExtname = nodePath.extname.bind(nodePath);
