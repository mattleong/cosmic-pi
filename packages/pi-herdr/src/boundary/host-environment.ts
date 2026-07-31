// Process-role detection is an explicit host boundary.
// @effect-diagnostics effect/processEnv:off

export const isSubagentChildProcess = (): boolean => process.env.PI_SUBAGENT_CHILD === "1";
