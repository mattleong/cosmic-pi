import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";

/**
 * Human wording for operating-system diagnostics. Raw text stays in expanded detail; these
 * helpers only choose the short collapsed message.
 */

const ERRNO_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["ENOENT", "File not found"],
  ["EACCES", "Permission denied"],
  ["EPERM", "This operation is not permitted"],
  ["EISDIR", "The target is a folder"],
  ["ENOTDIR", "The target is not a folder"],
  ["EEXIST", "The file already exists"],
  ["ENOTEMPTY", "The folder is not empty"],
  ["ENOSPC", "The disk is full"],
  ["EROFS", "The file system is read-only"],
  ["EMFILE", "Too many open files"],
  ["ENAMETOOLONG", "The path is too long"],
]);

// Node prints `ENOENT: no such file or directory, open '…'`, optionally behind an `Error:` prefix.
const NODE_ERRNO = /^(?:[A-Za-z]*Error(?: \[[A-Z0-9_]+\])?:\s*)?(E[A-Z]+):(?:\s|$)/u;

/** `File not found` for Node filesystem errors such as `ENOENT: no such file or directory, …`. */
export function errnoMessage(text: string): string | undefined {
  const line = Option.getOrUndefined(
    Arr.findFirst(Str.split(text, "\n"), (candidate) => Str.isNonEmpty(Str.trim(candidate))),
  );
  const code = line === undefined ? undefined : NODE_ERRNO.exec(Str.trim(line))?.[1];
  return code === undefined ? undefined : ERRNO_MESSAGES.get(code);
}

type ShellDiagnostic = readonly [
  phrase: RegExp,
  withSubject: (subject: string) => string,
  alone: string,
];

const SHELL_DIAGNOSTICS: ReadonlyArray<ShellDiagnostic> = [
  [/^No such file or directory$/iu, (subject) => `${subject} not found`, "file not found"],
  [/^(?:command )?not found$/iu, (subject) => `command ${subject} not found`, "command not found"],
  [/^Permission denied$/iu, (subject) => `permission denied for ${subject}`, "permission denied"],
  [/^Is a directory$/iu, (subject) => `${subject} is a folder`, "the target is a folder"],
  [/^Not a directory$/iu, (subject) => `${subject} is not a folder`, "the target is not a folder"],
  [/^File exists$/iu, (subject) => `${subject} already exists`, "the file already exists"],
  [/^Directory not empty$/iu, (subject) => `${subject} is not empty`, "the folder is not empty"],
  [
    /^Operation not permitted$/iu,
    (subject) => `operation not permitted on ${subject}`,
    "operation not permitted",
  ],
  [/^Read-only file system$/iu, () => "read-only file system", "read-only file system"],
  [/^No space left on device$/iu, () => "the disk is full", "the disk is full"],
];

// zsh reports `zsh: command not found: name`; other shells end with the phrase.
const ZSH_COMMAND = /(?:^|:\s)command not found:\s*(\S+)$/iu;
const SUBJECT_PREFIX =
  /^(?:cannot (?:access|open|stat|remove|create directory)|can't open file)\s+/iu;
// Python prefixes the phrase: `can't open file 'x': [Errno 2] No such file or directory`.
const ERRNO_TAG = /^\[Errno \d+\]\s*/u;
const QUOTES = /^['"‘’`](.*)['"‘’`]$/u;
const LINE_REFERENCE = /^(?:line )?\d+$/iu;

const subjectName = (raw: string): string | undefined => {
  const unprefixed = Fn.pipe(Str.trim(raw), Str.replace(SUBJECT_PREFIX, ""));
  const unquoted = Str.trim(QUOTES.exec(unprefixed)?.[1] ?? unprefixed);
  if (!unquoted || LINE_REFERENCE.test(unquoted)) return undefined;
  const trimmed = Fn.pipe(unquoted, Str.replace(/\/+$/u, ""));
  const name = Option.match(Fn.pipe(trimmed, Str.lastIndexOf("/")), {
    onNone: () => trimmed,
    onSome: (slash) => Fn.pipe(trimmed, Str.slice(slash + 1)),
  });
  return name || undefined;
};

/**
 * A short lowercase cause for a common Unix diagnostic line, such as
 * `cat: notes.txt: No such file or directory` → `notes.txt not found`.
 */
export function shellDiagnosticCause(line: string): string | undefined {
  const text = Str.trim(line);
  const zsh = ZSH_COMMAND.exec(text)?.[1];
  if (zsh) return `command ${subjectName(zsh) ?? zsh} not found`;
  const segments = Arr.map(Str.split(text, ": "), Str.trim);
  const phrase = Fn.pipe(segments.at(-1) ?? "", Str.replace(ERRNO_TAG, ""));
  const prefix = segments.at(-2);
  for (const [pattern, withSubject, alone] of SHELL_DIAGNOSTICS) {
    // A lone phrase without a program prefix is too ambiguous to classify, except as the whole line.
    if (!pattern.test(phrase)) continue;
    if (prefix === undefined) return segments.length === 1 ? alone : undefined;
    const subject = subjectName(prefix);
    // A prefix that is only the program name (`rm: Permission denied`) names no subject.
    return subject && segments.length > 2 ? withSubject(subject) : alone;
  }
  return undefined;
}
