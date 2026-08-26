import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Fixed extension CLI marker scoping parent-reference behavior to
 * Herdr-created child Pi processes launched by /herdr-fork.
 */
export const HERDR_FORK_PARENT_FLAG = "herdr-fork-parent";
export const HERDR_FORK_PARENT_FILE_FLAG = "herdr-fork-parent-file";
export const HERDR_FORK_CHILD_SESSION_FLAG = "herdr-fork-child-session";

/** The value shape Pi's `getFlag` reports for a registered extension flag. */
export type ExtensionFlagValue = string | boolean | undefined;

// Mirrors Pi's session-id grammar so a hostile marker can never smuggle
// separators, flags, or path fragments into argv or the system prompt.
export const HerdrForkSessionIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u),
);

const HerdrForkParentFileSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^[^\0\r\n]+$/u),
);

export const parseHerdrForkSessionId = (value: ExtensionFlagValue): string | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(HerdrForkSessionIdSchema)(value));

export const parseHerdrForkParentFile = (value: ExtensionFlagValue): string | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(HerdrForkParentFileSchema)(value));

/** Fixed `--flag=value` argv tokens; the `=` form cannot be re-split. */
export const herdrForkParentMarkerArguments = (
  parentSessionId: string,
  parentSessionFile: string,
  childSessionId: string,
): readonly [string, string, string] => [
  `--${HERDR_FORK_PARENT_FLAG}=${parentSessionId}`,
  `--${HERDR_FORK_PARENT_FILE_FLAG}=${parentSessionFile}`,
  `--${HERDR_FORK_CHILD_SESSION_FLAG}=${childSessionId}`,
];
