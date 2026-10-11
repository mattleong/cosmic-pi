import * as Predicate from "effect/Predicate";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { codePreviewSettings } from "../../../config/state";
import { getObjectValue } from "../../../shared/helpers";
import { getReadStartLine } from "../../data/args";
import { getTextContent, isTruncated, splitReadContinuationNotice } from "../../data/results";
import { oversizedReadNotice } from "./output-notice";

type ReadResultBody =
  | { readonly kind: "image"; readonly text: string }
  | { readonly kind: "oversized"; readonly notice: string }
  | { readonly kind: "content"; readonly content: string; readonly firstLine: number | undefined };

export function readResultBody<Args>(result: AgentToolResult<unknown>, args: Args): ReadResultBody {
  const text = getTextContent(result.content);
  if (result.content?.some((part) => part.type === "image")) return { kind: "image", text };
  const notice = oversizedReadNotice(result.details, text);
  if (notice !== undefined) return { kind: "oversized", notice };
  const paged = isTruncated(result.details) || Predicate.isNumber(getObjectValue(args, "limit"));
  return {
    kind: "content",
    content: paged ? splitReadContinuationNotice(text).content : text,
    firstLine: codePreviewSettings.readLineNumbers ? getReadStartLine(args) : undefined,
  };
}
