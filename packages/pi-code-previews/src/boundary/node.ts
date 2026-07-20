const nodePath = process.getBuiltinModule("node:path");
const nodeOs = process.getBuiltinModule("node:os");
if (!nodePath || !nodeOs) throw new Error("Node path APIs are unavailable.");

export const nodeBasename = nodePath.basename;
export const nodeExtname = nodePath.extname;
export const nodeIsAbsolute = nodePath.isAbsolute;
export const nodeJoin = nodePath.join;
export const nodeRelative = nodePath.relative;
export const nodeResolve = nodePath.resolve;
export const nodeHomeDirectory = nodeOs.homedir;
