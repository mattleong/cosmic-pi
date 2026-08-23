// Raw Node builtin access for adapters whose contracts the Effect FileSystem and
// Path services cannot express: O_NOFOLLOW opens, inode identity checks, and
// native platform path semantics.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");

export const nodeFsConstants = nodeFsModule.constants;
export const nodeFsPromises = nodeFsModule.promises;
export const nodePath = nodePathModule;
