import * as Predicate from "effect/Predicate";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { codePreviewSettings } from "../../../config/state";
import { getObjectValue } from "../../../shared/helpers";
import { getReadStartLine } from "../../data/args";
import { getTextContent, isTruncated, splitReadContinuationNotice } from "../../data/results";
import { oversizedReadNotice } from "./output-notice";

type ReadResultBody =
  /** Pi renders image parts itself; the text beside them is only a note. */
  | { readonly kind: "image"; readonly text: string }
  /** An oversized first line returns only the agent's recovery instruction, never content. */
  | { readonly kind: "oversized"; readonly notice: string }
  | { readonly kind: "content"; readonly content: string; readonly firstLine: number | undefined };

/** What a successful read's body shows, for both the preview and the expanded content. */
export function readResultBody<Args>(result: AgentToolResult<unknown>, args: Args): ReadResultBody {
  const text = getTextContent(result.content);
  if (result.content?.some((part) => part.type === "image")) return { kind: "image", text };
  const notice = oversizedReadNotice(result.details, text);
  if (notice !== undefined) return { kind: "oversized", notice };
  // A host continuation notice is an issue above the body, not a numbered file line. Only
  // truncated or limited reads carry one; otherwise a matching line is file content.
  const paged = isTruncated(result.details) || Predicate.isNumber(getObjectValue(args, "limit"));
  return {
    kind: "content",
    content: paged ? splitReadContinuationNotice(text).content : text,
    firstLine: codePreviewSettings.readLineNumbers ? getReadStartLine(args) : undefined,
  };
}
