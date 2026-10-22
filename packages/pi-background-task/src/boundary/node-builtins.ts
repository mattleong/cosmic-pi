const childProcessModule = process.getBuiltinModule("node:child_process");
if (!childProcessModule) throw new Error("Node child-process builtin is unavailable.");

export const nodeSpawn = childProcessModule.spawn;
export type NodeChildProcess = InstanceType<typeof childProcessModule.ChildProcess>;
