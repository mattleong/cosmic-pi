import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  getTextContent,
  type CompactIssue,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { failureMessage } from "pi-cosmic-core/message-text";
import {
  CodexImageDetailsSchema,
  IMAGE_ACTIONS,
  GENERATION_FAILED,
  type CodexImageDetails,
  type ToolParams,
} from "./types.ts";

const ACTIONS: ReadonlySet<string> = new Set(IMAGE_ACTIONS);

export const imagePromptSubject = (prompt: string): string =>
  Fn.pipe(prompt, Str.replace(/\s+/g, " "), Str.trim, Str.slice(0, 100));

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
          message: `${GENERATION_FAILED}: OpenAI gave no reason`,
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
        message: `${GENERATION_FAILED}: ${cause}`,
        detail: RETRY_HINT,
      };
}

const textOnlyFailure = (result: AgentToolResult<unknown> | undefined): string | undefined => {
  if (!result?.content.length || Arr.some(result.content, (part) => part.type !== "text"))
    return undefined;
  const details = result.details;
  if (details !== undefined && !(Predicate.isObject(details) && Rec.keys(details).length === 0))
    return undefined;
  const text = getTextContent(result.content);
  return Str.trim(text) ? text : undefined;
};

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
    const text = textOnlyFailure(result);
    return text === undefined
      ? undefined
      : { action, subject, outcome: "error", issues: [imageFailureIssue(text)] };
  }

  if (!record) return undefined;
  return imageRecordSummary(record, {
    hasImage: result !== undefined && Arr.some(result.content, (part) => part.type === "image"),
    prompt: args.prompt,
  });
};
