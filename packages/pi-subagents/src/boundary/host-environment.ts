/** Set only for nested Pi worktree writers; a tool-surface hint, not authority. */
export const SUBAGENT_WORKSPACE_PARENT_ENV = "PI_SUBAGENT_WORKSPACE_PARENT";

const hasWorkspaceParentMarker = (environment: Readonly<NodeJS.ProcessEnv>): boolean =>
  environment[SUBAGENT_WORKSPACE_PARENT_ENV] === "1";

export const isWorkspaceParentChildProcess = (): boolean => hasWorkspaceParentMarker(process.env);
