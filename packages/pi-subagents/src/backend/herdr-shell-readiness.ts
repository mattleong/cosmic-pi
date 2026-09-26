import { isInteractiveShellProcessName } from "pi-cosmic-core";

export interface HerdrPaneProcessInfo {
  readonly paneId: string;
  readonly shellPid?: number | undefined;
  readonly foregroundProcessGroupId?: number | undefined;
  readonly foregroundProcesses: ReadonlyArray<{
    readonly pid: number;
    readonly name: string;
  }>;
}

/** Herdr agent start requires the pane's interactive shell to own the foreground. */
export const hasAvailableHerdrShell = (processInfo: HerdrPaneProcessInfo): boolean => {
  const shellPid = processInfo.shellPid;
  const foregroundProcess = processInfo.foregroundProcesses[0];
  return (
    shellPid !== undefined &&
    processInfo.foregroundProcessGroupId === shellPid &&
    processInfo.foregroundProcesses.length === 1 &&
    foregroundProcess?.pid === shellPid &&
    isInteractiveShellProcessName(foregroundProcess.name)
  );
};
