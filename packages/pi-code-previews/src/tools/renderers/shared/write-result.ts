import * as Predicate from "effect/Predicate";
import { ownField, type HostObject } from "../../../shared/untrusted-value";
import {
  getWriteDiffGuard,
  getWriteDiffSkipReason,
  hasWriteDiffSizeEvidence,
} from "../../../write/diff";
import { getCodePreviewBeforeWrite } from "../../../write/preview-execution";
import type { RendererState } from "./types";

const BEFORE_SNAPSHOT = "codePreviewWriteBeforeSnapshot";

export function writeBeforeSnapshot(
  state: RendererState,
  toolCallId: string | undefined,
  details: HostObject | undefined,
): HostObject | undefined {
  if (Object.hasOwn(state, BEFORE_SNAPSHOT)) return state[BEFORE_SNAPSHOT];
  const before = getCodePreviewBeforeWrite(toolCallId, details);
  state[BEFORE_SNAPSHOT] = before;
  return before;
}

type WriteDiffPlan =
  | { readonly kind: "skipped"; readonly reason: string; readonly measured: boolean }
  | { readonly kind: "unknown" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "guarded"; readonly guard: "size" | "complexity" }
  | { readonly kind: "diff"; readonly previous: string; readonly content: string };

export function writeDiffPlan(
  before: HostObject | undefined,
  content: string | undefined,
): WriteDiffPlan {
  if (content === undefined) return { kind: "unknown" };
  const reason = getWriteDiffSkipReason(before, content);
  if (reason !== undefined)
    return { kind: "skipped", reason, measured: hasWriteDiffSizeEvidence(before) };
  const previous = ownField(before, "content");
  if (!Predicate.isString(previous)) return { kind: "unknown" };
  if (previous === content) return { kind: "unchanged" };
  const guard = getWriteDiffGuard(previous, content);
  return guard ? { kind: "guarded", guard } : { kind: "diff", previous, content };
}
