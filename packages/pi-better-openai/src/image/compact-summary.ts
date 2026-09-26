import * as Predicate from "effect/Predicate";
import { firstLineMessage, getTextContent, type CompactSummaryProvider } from "pi-code-previews";
import { isCodexImageDetails, type ToolParams } from "./types.ts";

const short = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 100);

/**
 * Projects display state only. Pi retains ownership of result images and execution.
 * Expanded content already shows prompts, the saved path, and the raw result, so issues
 * carry only facts that content does not state.
 */
export const imageCompactSummary: CompactSummaryProvider<ToolParams> = ({
  phase,
  args,
  result,
  context,
}) => {
  const action = args.action ?? "auto";
  if (!["auto", "generate", "edit"].includes(action) || !Predicate.isString(args.prompt))
    return undefined;
  const subject = short(args.prompt);
  if (phase !== "settled") return { action, subject };

  // Only text-only failures are classified; attachment-bearing errors keep the generic row.
  if (
    context.isError &&
    !(Predicate.isObject(result?.details) && result.details.status === "cancelled")
  ) {
    if (
      !result?.content.length ||
      result.details !== undefined ||
      result.content.some((part) => part.type !== "text")
    )
      return undefined;
    const text = getTextContent(result.content);
    if (!text.trim()) return undefined;
    return {
      action,
      subject,
      outcome: "error",
      issues: [
        {
          severity: "error",
          code: "image-error",
          message: firstLineMessage(text, "Image generation reported an error"),
        },
      ],
    };
  }

  const details = result?.details;
  if (
    !isCodexImageDetails(details) ||
    details.id.length === 0 ||
    details.id.length > 256 ||
    !["auto", "generate", "edit"].includes(details.action) ||
    !["png", "jpeg", "webp"].includes(details.outputFormat)
  )
    return undefined;
  const base = { action: details.action, subject: details.savedPath || short(details.prompt) };
  switch (details.status) {
    case "completed":
      // A completed record without an image is not evidence of a delivered image.
      if (!result?.content.some((part) => part.type === "image")) return undefined;
      return { ...base, outcome: "success" };
    case "failed":
      return {
        ...base,
        outcome: "error",
        issues: [{ severity: "error", code: "image-failed", message: "Image generation failed" }],
      };
    case "cancelled":
      return { ...base, outcome: "cancelled" };
    case "in_progress":
    case "incomplete":
      return {
        ...base,
        outcome: "uncertain",
        issues: [
          {
            severity: "warning",
            code: `image-${details.status}`,
            message:
              details.status === "in_progress"
                ? "Image generation may still be running"
                : "Image generation did not finish",
          },
        ],
      };
    default:
      return undefined;
  }
};
