export interface HerdrPaneProcessInfo {
  readonly paneId: string;
  readonly shellPid?: number | undefined;
  readonly foregroundProcessGroupId?: number | undefined;
  readonly foregroundProcesses: ReadonlyArray<{
    readonly pid: number;
    readonly name: string;
  }>;
}

const HERDR_SHELL_PROCESS_NAMES = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "ksh",
  "mksh",
  "csh",
  "tcsh",
  "elvish",
  "xonsh",
  "nu",
  "pwsh",
  "powershell",
  "cmd",
]);

const normalizedProcessName = (name: string): string =>
  (name.split(/[\\/]/gu).at(-1) ?? name)
    .replace(/^-+/gu, "")
    .replace(/\.exe$/giu, "")
    .toLowerCase();

/** Herdr agent start requires the pane's interactive shell to own the foreground. */
export const hasAvailableHerdrShell = (processInfo: HerdrPaneProcessInfo): boolean => {
  const shellPid = processInfo.shellPid;
  const foregroundProcess = processInfo.foregroundProcesses[0];
  return (
    shellPid !== undefined &&
    processInfo.foregroundProcessGroupId === shellPid &&
    processInfo.foregroundProcesses.length === 1 &&
    foregroundProcess?.pid === shellPid &&
    HERDR_SHELL_PROCESS_NAMES.has(normalizedProcessName(foregroundProcess.name))
  );
};
