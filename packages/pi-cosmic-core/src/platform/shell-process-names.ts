import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

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
    Fn.pipe(Arr.lastNonEmpty(Str.split(name, "/")), Str.replace(/^-+/gu, ""), Str.toLowerCase),
  );
