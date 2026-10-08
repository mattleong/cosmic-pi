const nodePath = process.getBuiltinModule("node:path");
if (!nodePath) throw new Error("Node path APIs are unavailable.");

export const nodeBasename = nodePath.basename;
export const nodeJoin = nodePath.join;
export const nodeExtname = nodePath.extname;
