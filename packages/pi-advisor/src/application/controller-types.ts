// The Context key intentionally retains its pre-move public identity.
// @effect-diagnostics effect/deterministicKeys:off
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AdvisorEffectExecutor } from "../boundary/executor.ts";
import type { AdvisorAbortInput, AdvisorSessionInput } from "../boundary/host-context.ts";
import type { ResolvedAdvisorConfig } from "../config/resolve.ts";
import type { AdvisorFailureDetails } from "../logging/log.ts";
import type { AdvisorRuntimeDriver } from "../runtime/runtime.ts";
import type { AdvisorControllerSnapshot } from "../ui/projection.ts";
import type { AdvisorHostBindings } from "./host-bindings.ts";

export class AdvisorExtensionError extends Schema.TaggedErrorClass<AdvisorExtensionError>()(
  "AdvisorExtensionError",
  { operation: Schema.String, message: Schema.String },
) {}
export const extensionError = (operation: string) => () =>
  new AdvisorExtensionError({ operation, message: `Advisor ${operation} failed.` });

export const STATUS_KEY = "pi-advisor";
export const STATUS_SPINNER_DELAY_MS = 200;
export const STATUS_SPINNER_INTERVAL_MS = 120;
export const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const UNREADABLE_PARENT_ANCHOR = Symbol("pi-advisor/unreadable-parent-anchor");
export type ParentAnchor = string | null | typeof UNREADABLE_PARENT_ANCHOR;
export const ADVISOR_CATCH_UP_TIMEOUT_MS = 30_000;
export type ReviewPhase = "final" | "progress";
export type CheckpointSettlement = "completed" | "discarded" | "failed";
export type AdvisorCatchUpOutcome = CheckpointSettlement | "timeout" | "cancelled";
export const awaitAdvisorCatchUpEffect = (
  settlement: Effect.Effect<CheckpointSettlement>,
  timeoutMs: number,
  cancellation: Effect.Effect<"cancelled"> = Effect.never,
  onTimeout: Effect.Effect<void> = Effect.void,
): Effect.Effect<AdvisorCatchUpOutcome> =>
  settlement.pipe(
    Effect.raceFirst(Effect.sleep(timeoutMs).pipe(Effect.as("timeout" as const))),
    Effect.raceFirst(cancellation),
    Effect.flatMap((outcome) =>
      outcome === "timeout" ? onTimeout.pipe(Effect.as(outcome)) : Effect.succeed(outcome),
    ),
    Effect.withSpan("pi-advisor.catch-up"),
  );

export interface AdvisorCheckpointHandle {
  readonly abortInput: AdvisorAbortInput;
  invalidate(): void;
  cancelEffect: Effect.Effect<void>;
  settlement: Effect.Effect<CheckpointSettlement>;
}
export type ReviewSource =
  | "automatic-final"
  | "automatic-progress"
  | "automatic-perspective"
  | "automatic-catch-up"
  | "next"
  | "last"
  | "verify";

export type AdvisorSkipReason =
  | "disabled"
  | "empty"
  | "incomplete"
  | "session-paused"
  | "unconfigured";

export interface LastCandidate {
  candidate: string;
}

export type {
  AdvisorHostBindings,
  AdvisorHostCommandDefinition,
  AdvisorHostCommandHandler,
  AdvisorHostEventHandler,
} from "./host-bindings.ts";

export interface AdvisorControllerShape {
  /** Synchronous Pi/TUI boundary; returns a deeply frozen projection only. */
  readonly getSnapshot: () => AdvisorControllerSnapshot;
  readonly publish: (snapshot: AdvisorControllerSnapshot) => Effect.Effect<void>;
  readonly refreshProjection: Effect.Effect<void>;
  readonly replaceChild: <A, E, R>(
    acquire: Effect.Effect<A, E, R>,
    release: (child: A) => Effect.Effect<void>,
  ) => Effect.Effect<A, E, R>;
  readonly stopChild: () => Effect.Effect<void>;
  readonly sessionInitialize: (
    event: never,
    input: AdvisorSessionInput,
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
  readonly sessionShutdown: (
    event: never,
    ctx: ExtensionContext,
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
  readonly event: (
    name: string,
    event: never,
    ctx: ExtensionContext,
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
  readonly compact: (
    event: never,
    ctx: ExtensionContext,
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
  readonly tree: (
    event: never,
    ctx: ExtensionContext,
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
  readonly cancel: (
    ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>>[1],
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
  readonly command: (
    name: string,
    args: string,
    ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>>[1],
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
}

export class AdvisorController extends Context.Service<AdvisorController, AdvisorControllerShape>()(
  "pi-advisor/advisor-controller/AdvisorController",
) {}

export interface AdvisorExtensionDependencies {
  loadConfig?: (path?: string) => ResolvedAdvisorConfig | Promise<ResolvedAdvisorConfig>;
  logFailure?: (
    configPath: string,
    details: AdvisorFailureDetails,
  ) => string | undefined | Promise<string | undefined>;
  createRuntime?: (executor: AdvisorEffectExecutor) => AdvisorRuntimeDriver;
  /** Test seam only. Production always uses the hard exported cap. */
  catchUpTimeoutMs?: number | undefined;
}

export interface AdvisorControllerApplicationOptions {
  readonly pi: ExtensionAPI;
  readonly executor: AdvisorEffectExecutor;
  readonly dependencies: AdvisorExtensionDependencies;
  readonly hostBindings: AdvisorHostBindings;
}
