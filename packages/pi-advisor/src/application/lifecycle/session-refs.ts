/** Mutable session handles shared across lifecycle factories. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  summarizeAdvisorReview,
  type AdvisorDurableReviewSummary,
} from "../../checkpoint/ledger.ts";
import type { AdvisorReviewQueue } from "../../queue/review-queue.ts";
import type { LoadedAdvisorInstructions } from "../../review/instructions.ts";
import type { AdvisorRuntimeServiceContract } from "../../runtime/runtime.ts";
import type { AdvisorSessionInput } from "../../boundary/host-context.ts";
import type { CancellationLatch } from "../controller-helpers.ts";
import type { LastCandidate, ParentAnchor } from "../controller.ts";

export type ActiveTrajectoryResource = {
  readonly id: number;
  readonly ctx: ExtensionContext;
  cancelTimer?: () => void;
};

export interface SessionRefs {
  removeHostCancellation: (() => void) | undefined;
  checkpointId: number;
  queue: AdvisorReviewQueue | undefined;
  runtime: AdvisorRuntimeServiceContract | undefined;
  runtimeCursor: { anchor: ParentAnchor; fingerprint: string } | undefined;
  activeContext: ExtensionContext | undefined;
  activeSessionInput: AdvisorSessionInput | undefined;
  instructions: LoadedAdvisorInstructions;
  pendingExplicitStart: number | undefined;
  explicitStartSequence: number;
  lastCandidate: LastCandidate | undefined;
  trajectorySequence: number;
  activeTrajectoryResource: ActiveTrajectoryResource | undefined;
  activeToolCalls: Map<string, { toolName: string; args: unknown }>;
  latestStateSummary: string;
  latestDurableSummary: AdvisorDurableReviewSummary;
  activeChildStart: CancellationLatch | undefined;
}

export const createSessionRefs = (): SessionRefs => ({
  removeHostCancellation: undefined,
  checkpointId: 0,
  queue: undefined,
  runtime: undefined,
  runtimeCursor: undefined,
  activeContext: undefined,
  activeSessionInput: undefined,
  instructions: { paths: [] },
  pendingExplicitStart: undefined,
  explicitStartSequence: 0,
  lastCandidate: undefined,
  trajectorySequence: 0,
  activeTrajectoryResource: undefined,
  activeToolCalls: new Map(),
  latestStateSummary: "",
  latestDurableSummary: summarizeAdvisorReview(),
  activeChildStart: undefined,
});
