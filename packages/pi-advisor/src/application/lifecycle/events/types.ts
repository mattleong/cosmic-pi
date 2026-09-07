import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import type { ResolvedAdvisorConfig } from "../../../config/options.ts";
import type { ConfigStoreContract } from "../../../config/store.ts";
import type { AdvisorCheckpointHandle } from "../../controller.ts";
import type { AdvisorActiveTrajectoryState } from "../../state.ts";
import type {
  CheckpointOrchestration,
  CheckpointRequestOptions,
  HostApi,
  InterventionIngress,
  LedgerPersistence,
  RuntimeControls,
  StateRead,
  StateWrite,
} from "../deps.ts";
import type { SessionRefs } from "../session-refs.ts";

export interface EventsDeps
  extends
    HostApi,
    StateRead,
    StateWrite,
    LedgerPersistence,
    RuntimeControls,
    CheckpointOrchestration,
    InterventionIngress {
  readonly refs: SessionRefs;
  readonly advanceDomainCounter: (key: "epoch" | "parentTurnId") => number;
  readonly clearPersistentTrajectory: () => void;
  readonly clearPersistentTrajectoryResources: () => void;
  readonly clearPendingRecovery: () => void;
  readonly clearPendingReceipt: () => void;
  readonly initializeSession: (config: ResolvedAdvisorConfig) => void;
  readonly beginUserRequest: () => void;
  readonly resetSessionTreeDomain: () => void;
  readonly mutateTrajectory: (
    id: number,
    mutate: (next: AdvisorActiveTrajectoryState) => AdvisorActiveTrajectoryState,
  ) => AdvisorActiveTrajectoryState | undefined;
  readonly scheduleDelay: (milliseconds: number, task: () => void) => () => void;
  readonly stopRuntimeUnlockedEffect: () => Effect.Effect<void>;
  readonly runWithExplicitRuntimeEffect: <T>(
    ctx: ExtensionContext,
    action: () => T,
  ) => Effect.Effect<T | undefined>;
  readonly requestCheckpoint: (
    options: CheckpointRequestOptions,
  ) => AdvisorCheckpointHandle | undefined;
  readonly awaitCatchUpEffectOwned: (
    handle: AdvisorCheckpointHandle,
    ctx: ExtensionContext,
  ) => Effect.Effect<void>;
  readonly configStore: ConfigStoreContract;
  readonly persistCommandConfig: (
    patch: Parameters<ConfigStoreContract["patch"]>[0],
    path: string,
  ) => ReturnType<ConfigStoreContract["patch"]>;
}
