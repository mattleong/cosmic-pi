import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  endElide,
  getTextContent,
  type CompactIssue,
  type CompactSummary,
  type CompactSummaryProvider,
  type ToolCallCollapsedStyle,
} from "pi-code-previews";
import { failureMessage, restatesText } from "pi-cosmic-core/message-text";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import {
  CodexImageDetailsSchema,
  IMAGE_ACTIONS,
  GENERATION_FAILED,
  type CodexImageDetails,
  type ToolParams,
} from "./types.ts";

const ACTIONS: ReadonlySet<string> = new Set(IMAGE_ACTIONS);

/** The most of a prompt a heading names; expansion shows a longer prompt whole. */
const IMAGE_PROMPT_SUBJECT_LIMIT = 100;

const onOneLine = (prompt: string): string => Fn.pipe(prompt, Str.replace(/\s+/g, " "), Str.trim);

/** The prompt as headings name it: on one line and, past the limit, cut at a word with `…`. */
export const imagePromptSubject = (prompt: string): string =>
  endElide(onOneLine(prompt), IMAGE_PROMPT_SUBJECT_LIMIT);

/** The subject as a preview heading draws it; preview headings wrap, so it shows whole. */
export const imageHeadingPrompt = (prompt: string): string =>
  sanitizeTerminalLine(imagePromptSubject(prompt));

/**
 * Whether a heading that showed its whole subject showed the prompt exactly, in either collapsed
 * style, so an expanded body can leave the prompt out. A prompt with line breaks never qualifies.
 */
export const imageHeadingsShowPrompt = (prompt: string): boolean =>
  imagePromptSubject(prompt) === prompt && imageHeadingPrompt(prompt) === prompt;

const ImageRecordSchema = Schema.Struct({
  ...CodexImageDetailsSchema.fields,
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

export const imageRecord = Fn.flow(
  Schema.decodeUnknownOption(ImageRecordSchema),
  Option.getOrUndefined,
);

type StatusSummary = Pick<CompactSummary, "outcome" | "issues">;
const uncertain = (code: string, message: string): StatusSummary => ({
  outcome: "uncertain",
  issues: [{ severity: "warning", code, message }],
});
const UNCONFIRMED_COMPLETION = uncertain(
  "image-missing",
  "Image generation finished, but no image is attached",
);
/** What to do after OpenAI failed a request: shown expanded under the failure. */
const RETRY_HINT =
  "Try again. If it fails the same way, rephrase the prompt or wait a few minutes.";
const STATUS_SUMMARIES = new Map<string, StatusSummary>([
  [
    "failed",
    {
      outcome: "error",
      issues: [
        {
          severity: "error",
          code: "image-failed",
          message: "OpenAI gave no reason",
          detail: RETRY_HINT,
        },
      ],
    },
  ],
  ["cancelled", { outcome: "cancelled" }],
  ["in_progress", uncertain("image-in_progress", "Image generation may still be running")],
  ["incomplete", uncertain("image-incomplete", "Image generation did not finish")],
]);

export interface ImageSummaryOptions {
  readonly hasImage: boolean;
  readonly prompt?: string | undefined;
}

export function imageRecordSummary(
  record: CodexImageDetails,
  options: ImageSummaryOptions,
): CompactSummary | undefined {
  // The prompt names the image; where it was saved shows expanded.
  const base: CompactSummary = {
    action: record.action,
    subject: imagePromptSubject(options.prompt ?? record.prompt),
    ...(record.note !== undefined && {
      issues: [{ severity: "info", code: "image-note", message: record.note }],
    }),
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
  SIGN_IN.test(
    Option.getOrElse(
      Arr.findFirst(Str.split(text, /\r?\n/u), (line) => Str.isNonEmpty(Str.trim(line))),
      () => "",
    ),
  );

// Collapsed, a cause stays one short line; the full text shows expanded.
const CAUSE_LIMIT = 90;
const GENERATION_CAUSE = new RegExp(
  `^\\s*(?:[A-Za-z]*Error: )?${GENERATION_FAILED}: ([^\\n]*)`,
  "u",
);

/** The cause of a failed OpenAI request, without its lead-in, or undefined for other failures. */
export const imageGenerationCause = (text: string): string | undefined => {
  const cause = GENERATION_CAUSE.exec(text)?.[1];
  return cause === undefined
    ? undefined
    : failureMessage(cause, "OpenAI gave no reason", CAUSE_LIMIT);
};

/**
 * A failure's issue. Under the row's `✗`, a failed request's issue states OpenAI's cause alone,
 * not `Image generation failed:` before it.
 */
export function imageFailureIssue(text: string): CompactIssue {
  if (isSignInFailure(text))
    return {
      severity: "error",
      code: "image-sign-in",
      message: "Sign-in required: /login openai-codex",
    };
  const cause = imageGenerationCause(text);
  return cause === undefined
    ? {
        severity: "error",
        code: "image-error",
        message: failureMessage(text, "Image generation reported an error"),
      }
    : {
        severity: "error",
        code: "image-failed",
        message: cause,
        detail: RETRY_HINT,
      };
}

/** Whether a failure's raw text says only what its issue does, give or take the lead-in. */
export const restatesImageFailure = (text: string): boolean => {
  const { message } = imageFailureIssue(text);
  return restatesText(text, message) || restatesText(text, `${GENERATION_FAILED}: ${message}`);
};

const textOnlyFailure = (result: AgentToolResult<unknown> | undefined): string | undefined => {
  if (!result?.content.length || Arr.some(result.content, (part) => part.type !== "text"))
    return undefined;
  const details = result.details;
  if (details !== undefined && !(Predicate.isObject(details) && Rec.keys(details).length === 0))
    return undefined;
  const text = getTextContent(result.content);
  return Str.trim(text) ? text : undefined;
};

/**
 * Expanded, a row always shows the complete prompt and its options; once settled, also the
 * image's facts or the failure's recovery step. The streamed progress text never shows.
 */
const PROMPT_LABEL = "prompt";
const DETAILS_LABEL = "details";
const OPTIONS_LABEL = "options";

/** Whether the request names anything besides its prompt and action, which expansion lists. */
const hasOptions = (args: Partial<ToolParams>): boolean =>
  Arr.some(
    Rec.toEntries<string, unknown>(args),
    ([key, value]) => key !== "prompt" && key !== "action" && value !== undefined,
  );

/**
 * What expanding a pending request reveals: its options, and the prompt wherever the collapsed
 * heading may cut it. A preview heading wraps, so it hides only a prompt it can't name exactly. A
 * compact heading may cut it at any width, so a request without options declares that its `prompt`
 * reveals only the subject, which the shell drops where the row shows the prompt whole.
 */
const requestExpansion = (
  args: Partial<ToolParams>,
  prompt: string,
  style: ToolCallCollapsedStyle,
): Pick<CompactSummary, "expandLabel" | "expandsSubjectOnly"> => {
  const options = hasOptions(args);
  const exact = imageHeadingsShowPrompt(prompt);
  if (options)
    return { expandLabel: style === "compact" || !exact ? DETAILS_LABEL : OPTIONS_LABEL };
  if (style === "preview") return { expandLabel: !exact && PROMPT_LABEL };
  return { expandLabel: PROMPT_LABEL, ...(exact && { expandsSubjectOnly: true }) };
};

/** The image tool's summary for rows drawn in `style`, read when the shell wraps the tool. */
export const imageCompactSummaryFor =
  (style: ToolCallCollapsedStyle): CompactSummaryProvider<ToolParams> =>
  ({ phase, args, result, context }) => {
    const action = args.action ?? "auto";
    if (!ACTIONS.has(action) || !Predicate.isString(args.prompt)) return undefined;
    const subject = imagePromptSubject(args.prompt);
    if (phase !== "settled")
      return { action, subject, ...requestExpansion(args, args.prompt, style) };
    const record = imageRecord(result?.details);
    // A heading that can't name the prompt exactly leaves it for expansion to reveal.
    const settledLabel = imageHeadingsShowPrompt(args.prompt) ? DETAILS_LABEL : PROMPT_LABEL;

    if (context.isError && record?.status !== "cancelled") {
      const text = textOnlyFailure(result);
      return text === undefined
        ? undefined
        : {
            action,
            subject,
            outcome: "error",
            issues: [imageFailureIssue(text)],
            expandLabel: settledLabel,
          };
    }

    if (!record) return undefined;
    const summary = imageRecordSummary(record, {
      hasImage: result !== undefined && Arr.some(result.content, (part) => part.type === "image"),
      prompt: args.prompt,
    });
    return summary && { ...summary, expandLabel: settledLabel };
  };
