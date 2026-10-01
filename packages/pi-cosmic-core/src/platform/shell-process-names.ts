// Pure classification of interactive shell process names.

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

/**
 * Whether a foreground process name is a known interactive shell. The name is reduced to its
 * basename, a login shell's leading dashes and a Windows `.exe` suffix are dropped, and the
 * comparison is case-insensitive.
 */
export const isInteractiveShellProcessName = (name: string): boolean =>
  INTERACTIVE_SHELL_PROCESS_NAMES.has(
    (name.split(/[\\/]/gu).at(-1) ?? name)
      .replace(/^-+/gu, "")
      .replace(/\.exe$/giu, "")
      .toLowerCase(),
  );
