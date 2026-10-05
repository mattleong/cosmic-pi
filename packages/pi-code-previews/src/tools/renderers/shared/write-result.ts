import * as Predicate from "effect/Predicate";
import { getObjectValue } from "../../../shared/helpers";
import {
  getWriteDiffGuard,
  getWriteDiffSkipReason,
  hasWriteDiffSizeEvidence,
} from "../../../write/diff";
import { getCodePreviewBeforeWrite } from "../../../write/preview-execution";
import type { RendererState } from "./types";

const BEFORE_SNAPSHOT = "codePreviewWriteBeforeSnapshot";

/**
 * The before-write snapshot a finished write compares against. The first lookup stays in row
 * state, so every later redraw presents the same evidence.
 */
export function writeBeforeSnapshot<Details>(
  state: RendererState,
  toolCallId: string | undefined,
  details: Details,
) {
  if (Object.hasOwn(state, BEFORE_SNAPSHOT)) return state[BEFORE_SNAPSHOT];
  const before = getCodePreviewBeforeWrite(toolCallId, details);
  state[BEFORE_SNAPSHOT] = before;
  return before;
}

type WriteDiffPlan =
  /** Only a measured size overrun earns a note; the "Diff unavailable" issue explains the rest. */
  | { readonly kind: "skipped"; readonly reason: string; readonly measured: boolean }
  /** No previous content, or no written content, to compare. */
  | { readonly kind: "unknown" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "guarded"; readonly guard: "size" | "complexity" }
  | { readonly kind: "diff"; readonly previous: string; readonly content: string };

/** How a finished write presents its change, for both the preview and the expanded content. */
export function writeDiffPlan<Before, Content>(before: Before, content: Content): WriteDiffPlan {
  if (!Predicate.isString(content)) return { kind: "unknown" };
  const reason = getWriteDiffSkipReason(before, content);
  if (reason !== undefined)
    return { kind: "skipped", reason, measured: hasWriteDiffSizeEvidence(before) };
  const previous = getObjectValue(before, "content");
  if (!Predicate.isString(previous)) return { kind: "unknown" };
  if (previous === content) return { kind: "unchanged" };
  const guard = getWriteDiffGuard(previous, content);
  return guard ? { kind: "guarded", guard } : { kind: "diff", previous, content };
}
