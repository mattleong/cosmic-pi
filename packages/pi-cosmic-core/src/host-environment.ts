const hasSubagentChildMarker = (environment: Readonly<NodeJS.ProcessEnv>): boolean =>
  environment.PI_SUBAGENT_CHILD === "1";

/** Whether this process is a Pi subagent child, which pi-subagents marks in its environment. */
export const isSubagentChildProcess = (): boolean => hasSubagentChildMarker(process.env);
