import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core";

export const HERDR_BTW_PARENT_FLAG = "herdr-btw-parent";
export const HERDR_BTW_PARENT_FILE_FLAG = "herdr-btw-parent-file";
export const HERDR_BTW_CHILD_SESSION_FLAG = "herdr-btw-child-session";

export type ExtensionFlagValue = string | boolean | undefined;

export const BoundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const BoundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));

export const HerdrBtwSessionIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u),
);

const HerdrBtwParentFileSchema = BoundedPath.check(Schema.isPattern(/^[^\0\r\n]+$/u));

export const parseHerdrBtwSessionId = (value: ExtensionFlagValue): string | undefined =>
  decodeUnknownOrUndefined(HerdrBtwSessionIdSchema)(value);

export const parseHerdrBtwParentFile = (value: ExtensionFlagValue): string | undefined =>
  decodeUnknownOrUndefined(HerdrBtwParentFileSchema)(value);

export const herdrBtwParentMarkerArguments = (
  parentSessionId: string,
  parentSessionFile: string,
  childSessionId: string,
): readonly [string, string, string] => [
  `--${HERDR_BTW_PARENT_FLAG}=${parentSessionId}`,
  `--${HERDR_BTW_PARENT_FILE_FLAG}=${parentSessionFile}`,
  `--${HERDR_BTW_CHILD_SESSION_FLAG}=${childSessionId}`,
];
