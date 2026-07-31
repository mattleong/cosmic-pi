// Claude's scoped Edit permission grammar is a foreign CLI boundary policy.
// @effect-diagnostics effect/nodeBuiltinImport:off
import { isAbsolute } from "node:path";

const MAX_CLAUDE_WRITER_CWD_CHARS = 4_096;
const UNSUPPORTED_CLAUDE_RULE_CHARACTERS = [
  "*",
  "?",
  "[",
  "]",
  "{",
  "}",
  "(",
  ")",
  "!",
  ",",
] as const;

export interface ClaudeWriterCwdPolicy {
  readonly cwd: string;
  readonly scopedEditRule: string;
}

/** Build one cwd/rule pair only when both sandbox and comma-delimited tool grammar can represent it. */
export const claudeWriterCwdPolicy = (
  cwd: string | undefined,
): ClaudeWriterCwdPolicy | undefined => {
  if (
    typeof cwd !== "string" ||
    !isAbsolute(cwd) ||
    cwd.length === 0 ||
    cwd.length > MAX_CLAUDE_WRITER_CWD_CHARS ||
    cwd.includes("\0") ||
    cwd.includes("\r") ||
    cwd.includes("\n") ||
    UNSUPPORTED_CLAUDE_RULE_CHARACTERS.some((character) => cwd.includes(character))
  )
    return undefined;
  return { cwd, scopedEditRule: `Edit(/${cwd}/**)` };
};
