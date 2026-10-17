const hasSubagentChildMarker = (environment: Readonly<NodeJS.ProcessEnv>): boolean =>
  environment.PI_SUBAGENT_CHILD === "1";

export const isSubagentChildProcess = (): boolean => hasSubagentChildMarker(process.env);

const childRunIdFromEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
): string | undefined => {
  const value = environment.PI_SUBAGENT_RUN_ID;
  return value && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value) ? value : undefined;
};

export const subagentChildRunId = (): string | undefined => childRunIdFromEnvironment(process.env);

/** Set only for nested Pi worktree writers; a tool-surface hint, not authority. */
export const SUBAGENT_WORKSPACE_PARENT_ENV = "PI_SUBAGENT_WORKSPACE_PARENT";

const hasWorkspaceParentMarker = (environment: Readonly<NodeJS.ProcessEnv>): boolean =>
  environment[SUBAGENT_WORKSPACE_PARENT_ENV] === "1";

export const isWorkspaceParentChildProcess = (): boolean => hasWorkspaceParentMarker(process.env);
