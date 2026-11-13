import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";

export const BTW_COMMAND = "btw";
/** Marks every BTW side session, including one that can't see its parent. */
export const REX_BTW_CHILD_FLAG = "rex-btw";
export const REX_BTW_PARENT_FLAG = "rex-btw-parent";
export const REX_BTW_PARENT_FILE_FLAG = "rex-btw-parent-file";

export const REX_UNAVAILABLE_MESSAGE = "/btw only works in a Pi session inside a Rex pane";

const RIGHT_SPLIT_MINIMUM_COLUMNS = 100;
// Command-line arguments share the OS argument limit; larger prompts belong in a file.
const MAX_PROMPT_BYTES = 64 * 1024;
// Shells that accept `-i -c script name args...` with POSIX positional parameters.
const POSIX_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "dash", "zsh", "ksh", "mksh"]);

const BoundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const SessionIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u),
);
const SessionFileSchema = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^\/[^\0\r\n]*$/u),
);
const ParentReferenceSchema = Schema.Struct({ id: SessionIdSchema, path: SessionFileSchema });
const decodeParentReference = decodeUnknownOrUndefined(ParentReferenceSchema);
const RexLocationSchema = Schema.Struct({ sessionId: BoundedId, blockId: BoundedId });
const decodeRexLocation = decodeUnknownOrUndefined(RexLocationSchema);

export type RexLocation = typeof RexLocationSchema.Type;
export type ParentReference = typeof ParentReferenceSchema.Type;

export interface ChildModel {
  readonly provider: string;
  readonly id: string;
}

export interface ChildLaunch {
  /** This package, loaded explicitly so the child understands the parent markers. */
  readonly extensionPath: string;
  readonly shell: string | undefined;
  readonly prompt: string | undefined;
  readonly model: ChildModel | undefined;
  readonly thinkingLevel: string | undefined;
  readonly parent: ParentReference;
}

export interface ChildCommand {
  /** True when argv starts its own shell, so Rex must not wrap it in another. */
  readonly startsShell: boolean;
  readonly argv: ReadonlyArray<string>;
}

export const rexLocation = (environment: Readonly<NodeJS.ProcessEnv>): RexLocation | undefined =>
  decodeRexLocation({ sessionId: environment.REX_SESSION, blockId: environment.REX_BLOCK });

/** Flag values and host session fields; anything other than valid strings is rejected. */
type MarkerValue = string | boolean | undefined;

export const parseParentReference = (
  id: MarkerValue,
  path: MarkerValue,
): ParentReference | undefined => decodeParentReference({ id, path });

export const splitDirection = (columns: number): "right" | "below" =>
  columns >= RIGHT_SPLIT_MINIMUM_COLUMNS ? "right" : "below";

export const promptProblem = (prompt: string): string | undefined =>
  Fn.pipe(prompt, Str.includes("\0"))
    ? "The prompt contains a null character"
    : Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES
      ? "The prompt is too long to pass to a new pane; save it to a file and mention the file instead"
      : undefined;

/**
 * The side session's name. Pi's terminal title already ends with the directory, and the footer
 * shows the branch, so the name only marks the pane as a side conversation.
 */
export const BTW_SESSION_NAME = "[BTW]";

// Pi reads a message beginning with "@" as a file to attach, even after "--".
const promptArgument = (prompt: string): string =>
  Fn.pipe(prompt, Str.startsWith("@")) ? ` ${prompt}` : prompt;

const piArguments = (launch: ChildLaunch): ReadonlyArray<string> => [
  "pi",
  "--no-session",
  // Pi rejects unregistered flags, and the child may not load this package from settings (for
  // example when the parent used `pi -e`). Pi skips the duplicate when settings also load it.
  "-e",
  launch.extensionPath,
  "--name",
  BTW_SESSION_NAME,
  `--${REX_BTW_CHILD_FLAG}`,
  ...(launch.model === undefined
    ? []
    : ["--provider", launch.model.provider, "--model", launch.model.id]),
  ...(launch.thinkingLevel === undefined ? [] : ["--thinking", launch.thinkingLevel]),
  `--${REX_BTW_PARENT_FLAG}=${launch.parent.id}`,
  `--${REX_BTW_PARENT_FILE_FLAG}=${launch.parent.path}`,
  ...(launch.prompt === undefined ? [] : ["--", promptArgument(launch.prompt)]),
];

/**
 * Rex starts commands with the login environment but skips interactive shell configuration, where
 * users often export API keys. A POSIX shell runs Pi through `-i` so that configuration loads;
 * arguments stay positional, so nothing is reparsed by the shell.
 */
export const childCommand = (launch: ChildLaunch): ChildCommand => {
  const pi = piArguments(launch);
  const shell = launch.shell;
  const shellName = shell === undefined ? "" : Arr.lastNonEmpty(Str.split(shell, "/")) || "";
  return shell !== undefined && Fn.pipe(shell, Str.startsWith("/")) && POSIX_SHELLS.has(shellName)
    ? { startsShell: true, argv: [shell, "-i", "-c", 'exec "$0" "$@"', ...pi] }
    : { startsShell: false, argv: pi };
};

export const parentReferenceInstruction = (parent: ParentReference): string =>
  Arr.join(
    [
      "## Parent Pi session (BTW side session)",
      "",
      "You are a BTW side session: a separate Pi conversation the user opened from a parent Pi session that keeps running in another Rex pane. This conversation started blank; nothing from the parent was copied in.",
      "",
      "The parent may be working right now. Whenever a request depends on what the parent is doing or has done, call parent_conversation first to read its latest messages, even if you read them earlier in this conversation.",
      `Only when you need history older than parent_conversation returns, search the parent's session file with read-only tools: ${JSON.stringify(parent.path)} (session ID ${parent.id}). It is a live JSONL transcript; never edit, resume, or compact it.`,
    ],
    "\n",
  );
