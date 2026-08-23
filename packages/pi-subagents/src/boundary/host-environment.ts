// Process-role detection is an explicit host boundary: the ambient child marker is
// snapshotted whole and inspected by a pure selector.
const hasSubagentChildMarker = (environment: Readonly<NodeJS.ProcessEnv>): boolean =>
  environment.PI_SUBAGENT_CHILD === "1";

export const isSubagentChildProcess = (): boolean => hasSubagentChildMarker(process.env);
