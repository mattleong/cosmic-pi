import * as Predicate from "effect/Predicate";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { codePreviewSettings } from "../../../config/state";
import { hostObject, ownField, type HostObject } from "../../../shared/untrusted-value";
import { getReadStartLine } from "../../data/args";
import { getTextContent, isTruncated, splitReadContinuationNotice } from "../../data/results";
import { oversizedReadNotice } from "./output-notice";

type ReadResultBody =
  | { readonly kind: "image"; readonly text: string }
  | { readonly kind: "oversized"; readonly notice: string }
  | { readonly kind: "content"; readonly content: string; readonly firstLine: number | undefined };

export function readResultBody(
  result: AgentToolResult<unknown>,
  args: HostObject | undefined,
): ReadResultBody {
  const text = getTextContent(result.content);
  if (result.content?.some((part) => part.type === "image")) return { kind: "image", text };
  const details = hostObject(result.details);
  const notice = oversizedReadNotice(details, text);
  if (notice !== undefined) return { kind: "oversized", notice };
  const paged = isTruncated(details) || Predicate.isNumber(ownField(args, "limit"));
  return {
    kind: "content",
    content: paged ? splitReadContinuationNotice(text).content : text,
    firstLine: codePreviewSettings.readLineNumbers ? getReadStartLine(args) : undefined,
  };
}
