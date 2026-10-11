const INTERACTIVE_SHELL_PROCESS_NAMES = new Set([
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

export const isInteractiveShellProcessName = (name: string): boolean =>
  INTERACTIVE_SHELL_PROCESS_NAMES.has(
    (name.split(/[\\/]/gu).at(-1) ?? name)
      .replace(/^-+/gu, "")
      .replace(/\.exe$/giu, "")
      .toLowerCase(),
  );
