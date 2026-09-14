import * as Predicate from "effect/Predicate";
import type { CompactSummaryProvider } from "pi-code-previews";
import type { ToolParams } from "./types.ts";

const short = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 100);
const optionalString = <Value>(value: Value) => value === undefined || Predicate.isString(value);

/** Projects display state only. Pi retains ownership of result images and execution. */
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

  // Only text-only failures can replace the complete original presentation.
  if (context.isError) {
    if (
      !result?.content.length ||
      result.details !== undefined ||
      result.content.some((part) => part.type !== "text")
    )
      return undefined;
    const details = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (!details.trim()) return undefined;
    return { action, subject, outcome: "error", failure: { cause: details, details } };
  }

  const details = result?.details;
  if (
    !Predicate.isObject(details) ||
    !Predicate.isString(details.id) ||
    !Predicate.isString(details.status) ||
    !Predicate.isString(details.prompt) ||
    !Predicate.isString(details.mimeType) ||
    !Predicate.isString(details.model) ||
    !Predicate.isString(details.action) ||
    !Predicate.isString(details.outputFormat) ||
    !optionalString(details.savedPath) ||
    !optionalString(details.revisedPrompt) ||
    !optionalString(details.imageModel) ||
    !["auto", "generate", "edit"].includes(String(details.action)) ||
    !["png", "jpeg", "webp"].includes(String(details.outputFormat))
  )
    return undefined;
  const savedPath = Predicate.isString(details.savedPath) ? details.savedPath : undefined;
  const finalSubject = short(savedPath || String(details.prompt));
  const notices = savedPath ? [{ kind: "recovery" as const, text: `Saved: ${savedPath}` }] : [];
  switch (details.status) {
    case "completed":
      // A completed record without an image is not evidence of a delivered image.
      if (!result?.content.some((part) => part.type === "image")) return undefined;
      return { action: String(details.action), subject: finalSubject, outcome: "success" };
    case "failed":
      return { action: String(details.action), subject: finalSubject, outcome: "error", notices };
    case "cancelled":
      return {
        action: String(details.action),
        subject: finalSubject,
        outcome: "cancelled",
        notices,
      };
    case "in_progress":
    case "incomplete":
      return {
        action: String(details.action),
        subject: finalSubject,
        outcome: "uncertain",
        notices,
      };
    default:
      return undefined;
  }
};
