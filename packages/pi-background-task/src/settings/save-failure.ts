import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { failureMessage } from "pi-cosmic-core/message-text";
import { formatDisplayPath } from "pi-cosmic-core/platform/paths";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { lastIndexOfFrom } from "pi-cosmic-core/text-scan";

const LEAD = "Couldn't save background tasks settings";

// What a failed write carries: a config error's file, or Node's code and path on a raw error.
const SaveFailureFacts = Schema.Struct({
  code: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
const decodeFacts = Schema.decodeUnknownOption(SaveFailureFacts);

// Node prints `EACCES: permission denied, open '…'` when the error has no code property.
const NODE_CODE = /^(?:[A-Za-z]*Error:\s*)?(E[A-Z]+):/u;

type CommonCode = "EACCES" | "EPERM" | "EROFS" | "ENOSPC" | "ENOENT";
const isCommonCode = Schema.is(Schema.Literals(["EACCES", "EPERM", "EROFS", "ENOSPC", "ENOENT"]));

const CAUSES = {
  EACCES: "permission denied",
  EPERM: "permission denied",
  EROFS: "the file system is read-only",
  ENOSPC: "the disk is full",
  ENOENT: "its folder is missing",
} as const satisfies Record<CommonCode, string>;

const folderOf = (shown: string) => {
  const slash = lastIndexOfFrom(shown, "/", shown.length - 1);
  return slash > 0 ? Fn.pipe(shown, Str.slice(0, slash + 1)) : shown;
};

const nextStep = (code: CommonCode | undefined, shown: string | undefined) => {
  if (code === "ENOSPC") return "Free some disk space, then try again";
  if (shown === undefined) return "Check that you can write to the settings file";
  return code === "ENOENT"
    ? `Check that ${folderOf(shown)} exists`
    : `Check that you can write to ${shown}`;
};

/**
 * A failed save in words: the cause when Node's code is a common one, the file as settings show
 * paths, and what to do next. Node's raw text, such as `EACCES: …`, never reaches the notice.
 */
export const saveFailureMessage = (cause: unknown, cwd: string): string => {
  const fields: typeof SaveFailureFacts.Type = Option.getOrElse(decodeFacts(cause), () => ({}));
  const rawCode = fields.code ?? NODE_CODE.exec(Str.trim(fields.message ?? ""))?.[1];
  const code = isCommonCode(rawCode) ? rawCode : undefined;
  const shown =
    fields.path === undefined || Str.isEmpty(Str.trim(fields.path))
      ? undefined
      : sanitizeTerminalLine(formatDisplayPath(fields.path, cwd));
  if (code === undefined && shown === undefined)
    return `${LEAD}: ${failureMessage(fields.message ?? "", "unknown error")}`;
  return `${LEAD}${code === undefined ? "" : `: ${CAUSES[code]}`}\n${nextStep(code, shown)}`;
};
