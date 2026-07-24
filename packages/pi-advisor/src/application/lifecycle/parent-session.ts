/** Pure-ish parent session reads used by lifecycle delivery and checkpoints. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  readAdvisorParentIdleAtHostBoundary,
  readAdvisorPendingMessagesAtHostBoundary,
  readAdvisorSessionBranchAtHostBoundary,
  readAdvisorSessionIdAtHostBoundary,
  readAdvisorSessionLeafIdAtHostBoundary,
  readAdvisorSignalAbortedAtHostBoundary,
  type AdvisorAbortInput,
} from "../../boundary/host-context.ts";
import { ADVISOR_CHECKPOINT_ENTRY_TYPE } from "../../checkpoint/ledger.ts";
import { UNREADABLE_PARENT_ANCHOR, type ParentAnchor } from "../controller-types.ts";

export const readParentAnchor = (ctx: ExtensionContext): ParentAnchor => {
  const branchResult = readAdvisorSessionBranchAtHostBoundary(ctx);
  if (!branchResult.ok) {
    const leafResult = readAdvisorSessionLeafIdAtHostBoundary(ctx);
    return leafResult.ok ? leafResult.value : UNREADABLE_PARENT_ANCHOR;
  }
  const branch = branchResult.value;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry && !(entry.type === "custom" && entry.customType === ADVISOR_CHECKPOINT_ENTRY_TYPE))
      return entry.id;
  }
  return null;
};

export const readLifecycleScope = (ctx: ExtensionContext): string => {
  const sessionIdResult = readAdvisorSessionIdAtHostBoundary(ctx);
  const sessionId = sessionIdResult.ok ? sessionIdResult.value : undefined;
  if (sessionId) return `session:${sessionId}`;
  const branchResult = readAdvisorSessionBranchAtHostBoundary(ctx);
  const branch = branchResult.ok ? branchResult.value : [];
  const root = branch.find(
    (entry) => !(entry.type === "custom" && entry.customType === ADVISOR_CHECKPOINT_ENTRY_TYPE),
  );
  const fallback = readParentAnchor(ctx);
  return `branch:${root?.id ?? (typeof fallback === "string" ? fallback : "root")}`;
};

export const branchContainsAnchor = (ctx: ExtensionContext, anchor: ParentAnchor): boolean => {
  if (anchor === UNREADABLE_PARENT_ANCHOR) return false;
  if (!anchor) return true;
  const branchResult = readAdvisorSessionBranchAtHostBoundary(ctx);
  return branchResult.ok && branchResult.value.some((entry) => entry.id === anchor);
};

export const parentIsIdle = (ctx: ExtensionContext): boolean => {
  const result = readAdvisorParentIdleAtHostBoundary(ctx);
  return result.ok && result.value;
};

export const parentHasPendingMessages = (ctx: ExtensionContext): boolean => {
  const result = readAdvisorPendingMessagesAtHostBoundary(ctx);
  return !result.ok || result.value;
};

export const parentSignalAborted = (input: AdvisorAbortInput): boolean => {
  const result = readAdvisorSignalAbortedAtHostBoundary(input);
  return !result.ok || result.value;
};
