import * as Predicate from "effect/Predicate";
import {
  getTextContent,
  type CompactIssue,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { failureMessage } from "pi-cosmic-core";
import { IMAGE_OUTPUT_FORMATS } from "../config/schema.ts";
import {
  IMAGE_ACTIONS,
  isCodexImageDetails,
  type CodexImageDetails,
  type ToolParams,
} from "./types.ts";

const ACTIONS: ReadonlySet<string> = new Set(IMAGE_ACTIONS);
const OUTPUT_FORMATS: ReadonlySet<string> = new Set(IMAGE_OUTPUT_FORMATS);

/** The prompt as a compact heading subject: one line, bounded. */
export const imagePromptSubject = (prompt: string): string =>
  prompt.replace(/\s+/g, " ").trim().slice(0, 100);

/** Validated image details from a tool result or command message; undefined otherwise. */
export const imageRecord = <Value>(value: Value): CodexImageDetails | undefined =>
  isCodexImageDetails(value) &&
  value.id.length > 0 &&
  value.id.length <= 256 &&
  ACTIONS.has(value.action) &&
  OUTPUT_FORMATS.has(value.outputFormat)
    ? value
    : undefined;

const savedFileName = (path: string | undefined): string =>
  path?.split(/[\\/]/u).pop()?.trim() ?? "";

type StatusSummary = Pick<CompactSummary, "outcome" | "issues">;
const uncertain = (code: string, message: string): StatusSummary => ({
  outcome: "uncertain",
  issues: [{ severity: "warning", code, message }],
});
const UNCONFIRMED_COMPLETION = uncertain(
  "image-missing",
  "Image generation finished, but no image is attached",
);
// A Map, so an arbitrary provider status can never match an inherited object key.
const STATUS_SUMMARIES = new Map<string, StatusSummary>([
  [
    "failed",
    {
      outcome: "error",
      issues: [{ severity: "error", code: "image-failed", message: "Image generation failed" }],
    },
  ],
  ["cancelled", { outcome: "cancelled" }],
  ["in_progress", uncertain("image-in_progress", "Image generation may still be running")],
  ["incomplete", uncertain("image-incomplete", "Image generation did not finish")],
]);

export interface ImageSummaryOptions {
  /** Only an attached image confirms a completed generation. */
  readonly hasImage: boolean;
  /** The saved file name is collapsed-row metadata; expanded content shows the whole path. */
  readonly expanded: boolean;
  /** The requested prompt, when it is at hand; otherwise the one recorded in the details. */
  readonly prompt?: string | undefined;
}

/**
 * One classification for tool results and command messages. The prompt stays the subject; the
 * saved file name is routine metadata shown when the row has room for it. Unknown statuses
 * decline to the generic row.
 */
export function imageRecordSummary(
  record: CodexImageDetails,
  options: ImageSummaryOptions,
): CompactSummary | undefined {
  const fileName = options.expanded ? "" : savedFileName(record.savedPath);
  const base: CompactSummary = {
    action: record.action,
    subject: imagePromptSubject(options.prompt ?? record.prompt),
    ...(fileName !== "" && { metadata: [fileName] }),
  };
  if (record.status === "completed")
    return options.hasImage
      ? { ...base, outcome: "success" }
      : { ...base, ...UNCONFIRMED_COMPLETION };
  const known = STATUS_SUMMARIES.get(record.status);
  return known && { ...base, ...known };
}

// Credential failures the user fixes by signing in; read from the first line only.
const SIGN_IN =
  /\/login openai-codex\b|\bopenai-codex OAuth credentials\b|\bcredentials are malformed\b/iu;

/** Whether a failure's remedy is signing in to openai-codex. */
export const isSignInFailure = (text: string): boolean =>
  SIGN_IN.test(text.split(/\r?\n/u).find((line) => line.trim()) ?? "");

/** A text-only failure: sign-in problems name the command, others say what failed. */
export function imageFailureIssue(text: string): CompactIssue {
  return isSignInFailure(text)
    ? { severity: "error", code: "image-sign-in", message: "Sign-in required: /login openai-codex" }
    : {
        severity: "error",
        code: "image-error",
        message: failureMessage(text, "Image generation reported an error"),
      };
}

/** Pi's error results carry no details or an empty details object. */
const hasNoDetails = <Value>(details: Value): boolean =>
  details === undefined || (Predicate.isObject(details) && Object.keys(details).length === 0);

/**
 * Projects display state only. Pi retains ownership of result images and execution. Expanded
 * content shows the prompts, saved path and any raw text, so issues carry only what happened.
 */
export const imageCompactSummary: CompactSummaryProvider<ToolParams> = ({
  phase,
  args,
  result,
  context,
}) => {
  const action = args.action ?? "auto";
  if (!ACTIONS.has(action) || !Predicate.isString(args.prompt)) return undefined;
  const subject = imagePromptSubject(args.prompt);
  if (phase !== "settled") return { action, subject };
  const record = imageRecord(result?.details);

  // A validated cancellation stays a cancellation even when Pi reports an error. Only text-only
  // failures are classified; attachment-bearing errors keep the generic row.
  if (context.isError && record?.status !== "cancelled") {
    if (
      !result?.content.length ||
      !hasNoDetails(result.details) ||
      result.content.some((part) => part.type !== "text")
    )
      return undefined;
    const text = getTextContent(result.content);
    if (!text.trim()) return undefined;
    return { action, subject, outcome: "error", issues: [imageFailureIssue(text)] };
  }

  if (!record) return undefined;
  return imageRecordSummary(record, {
    hasImage: result?.content.some((part) => part.type === "image") ?? false,
    expanded: context.expanded,
    prompt: args.prompt,
  });
};
