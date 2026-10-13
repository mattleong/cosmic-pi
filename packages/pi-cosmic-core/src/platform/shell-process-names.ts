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
]);

export const isInteractiveShellProcessName = (name: string): boolean =>
  INTERACTIVE_SHELL_PROCESS_NAMES.has(
    (name.split("/").at(-1) ?? name).replace(/^-+/gu, "").toLowerCase(),
  );
