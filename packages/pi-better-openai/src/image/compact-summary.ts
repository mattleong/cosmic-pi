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

export const imagePromptSubject = (prompt: string): string =>
  prompt.replace(/\s+/g, " ").trim().slice(0, 100);

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
  readonly hasImage: boolean;
  readonly expanded: boolean;
  readonly prompt?: string | undefined;
}

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

const SIGN_IN =
  /\/login openai-codex\b|\bopenai-codex OAuth credentials\b|\bcredentials are malformed\b/iu;

export const isSignInFailure = (text: string): boolean =>
  SIGN_IN.test(text.split(/\r?\n/u).find((line) => line.trim()) ?? "");

export function imageFailureIssue(text: string): CompactIssue {
  return isSignInFailure(text)
    ? { severity: "error", code: "image-sign-in", message: "Sign-in required: /login openai-codex" }
    : {
        severity: "error",
        code: "image-error",
        message: failureMessage(text, "Image generation reported an error"),
      };
}

const hasNoDetails = <Value>(details: Value): boolean =>
  details === undefined || (Predicate.isObject(details) && Object.keys(details).length === 0);

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
