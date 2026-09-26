import * as Predicate from "effect/Predicate";
import {
  claimCompactIssue,
  getTextContent,
  summaryCompactIssues,
  withCompactIssues,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { isCodexImageDetails, type ToolParams } from "./types.ts";

const short = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 100);

/** Projects display state only. Pi retains ownership of result images and execution. */
const projectImageSummary: CompactSummaryProvider<ToolParams> = ({
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
    const details = getTextContent(result.content);
    if (!details.trim()) return undefined;
    return {
      action,
      subject,
      outcome: "error",
      failure: { cause: details, description: "Image generation reported an error.", details },
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
  const savedPath = details.savedPath;
  const base = { action: details.action, subject: savedPath || short(details.prompt) };
  const notices = savedPath
    ? [
        {
          code: "saved-path",
          kind: "recovery" as const,
          text: `Saved: ${savedPath}`,
          expandedOnly: true as const,
        },
      ]
    : [];
  switch (details.status) {
    case "completed":
      // A completed record without an image is not evidence of a delivered image.
      if (!result?.content.some((part) => part.type === "image")) return undefined;
      return { ...base, outcome: "success" };
    case "failed":
      // Status alone cannot account for remote diagnostic text or recovery.
      return {
        ...base,
        outcome: "error",
        notices,
        issues: {
          coverage: "unknown",
          entries: [
            {
              operation: `image:${details.id}`,
              code: "image-failed",
              severity: "error",
              cause: "Image generation failed.",
              description: "Image generation failed.",
              recovery: [],
            },
          ],
        },
      };
    case "cancelled":
      return { ...base, outcome: "cancelled", notices };
    case "in_progress":
    case "incomplete":
      return {
        ...base,
        outcome: "uncertain",
        notices: [
          ...notices,
          {
            code: `image-${details.status}`,
            kind: "warning",
            text: `Image generation is ${details.status}.`,
            description:
              details.status === "in_progress"
                ? "Image generation may still be running."
                : "Image generation did not finish.",
          },
        ],
      };
    default:
      return undefined;
  }
};

export const imageCompactSummary: CompactSummaryProvider<ToolParams> = (input) => {
  const summary = projectImageSummary(input);
  if (!summary) return undefined;
  const projected = summary.issues ? summary : withCompactIssues(summary, "openai-image");
  // Structured savedPath is already rendered by renderImageContent. Only that exact
  // producer-owned recovery is claimed; unrelated notices remain shell-owned.
  const savedClaims = summaryCompactIssues(projected, true)
    .entries.filter((issue) => issue.code === "saved-path")
    .map((issue) => claimCompactIssue(issue, { cause: true }));
  if (!projected.failure)
    return savedClaims.length ? { ...projected, expandedResultOwnsIssues: savedClaims } : projected;
  // This producer copies the complete text-only error into both the cause and raw body.
  // Claim that root alone; independently merged recovery remains shell-owned.
  const claims = (projected.issues?.entries ?? [])
    .filter((issue) => issue.operation === "openai-image" && issue.code === "failure")
    .map((issue) => claimCompactIssue(issue, { cause: true }));
  return {
    ...projected,
    failure: { ...projected.failure, ownedIssues: claims },
    expandedResultOwnsIssues: [...claims, ...savedClaims],
  };
};
