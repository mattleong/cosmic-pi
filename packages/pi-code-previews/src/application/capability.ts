import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import type * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import type { CodePreviewRuntimeError } from "../layer";
import type { CodePreviewSession } from "./service";
import type { CodePreviewSettingsService } from "../config/service";
import type { CodePreviewSyntaxService } from "../syntax/service";
import type { CodePreviewWriteService } from "../write/service";
import {
  publishCodePreviewDefer,
  publishCodePreviewSchedule,
  publishCodePreviewSessionActive,
} from "./projection";
import { previewScheduleEffect } from "./scheduler";

type SessionRequirements =
  | CodePreviewSession
  | CodePreviewSettingsService
  | CodePreviewSyntaxService
  | CodePreviewWriteService
  | Layer.Success<typeof nodeFilePlatformLayer>;

export type CodePreviewSessionFiber<A, E> = Fiber.Fiber<A, E | CodePreviewRuntimeError>;

export class CodePreviewSessionUnavailable extends Schema.TaggedError<CodePreviewSessionUnavailable>()(
  "CodePreviewSessionUnavailable",
  { operation: Schema.String, message: Schema.String },
) {}

export interface CodePreviewSessionCapability {
  readonly token: number;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, SessionRequirements>,
    signal?: AbortSignal,
  ) => Promise<A>;
  readonly fork: <A, E>(
    effect: Effect.Effect<A, E, SessionRequirements>,
    signal?: AbortSignal,
  ) => CodePreviewSessionFiber<A, E> | undefined;
  readonly defer?: ((task: () => void) => () => void) | undefined;
  readonly schedule?: ((interval: number, task: () => void) => () => void) | undefined;
}

let activeCapability: CodePreviewSessionCapability | undefined;

const invokeCodePreviewCallback = (task: () => void): Effect.Effect<void> =>
  Effect.try({ try: task, catch: () => undefined }).pipe(Effect.ignore);

const forkWithAbort = (
  capability: CodePreviewSessionCapability,
  effect: Effect.Effect<void, never, SessionRequirements>,
): (() => void) => {
  const controller = new AbortController();
  try {
    if (!capability.fork(effect, controller.signal)) return () => undefined;
  } catch {
    return () => undefined;
  }
  return () => controller.abort();
};

export function installCodePreviewSessionCapability(
  capability: CodePreviewSessionCapability | undefined,
): void {
  activeCapability = capability;
  publishCodePreviewSessionActive(capability !== undefined);
  publishCodePreviewDefer(
    capability
      ? (capability.defer ??
          ((task) =>
            forkWithAbort(
              capability,
              Effect.yieldNow.pipe(Effect.andThen(invokeCodePreviewCallback(task))),
            )))
      : undefined,
  );
  publishCodePreviewSchedule(
    capability
      ? (capability.schedule ??
          ((interval, task) => forkWithAbort(capability, previewScheduleEffect(interval, task))))
      : undefined,
  );
}

export function clearCodePreviewSessionCapability(token?: number): void {
  if (token === undefined || activeCapability?.token === token) {
    activeCapability = undefined;
    publishCodePreviewSessionActive(false);
    publishCodePreviewDefer(undefined);
    publishCodePreviewSchedule(undefined);
  }
}

export function hasCodePreviewSessionCapability(): boolean {
  return activeCapability !== undefined;
}

export function runCodePreviewSessionEffect<A, E>(
  effect: Effect.Effect<A, E, SessionRequirements>,
  signal?: AbortSignal,
): Promise<A> {
  const active = activeCapability;
  if (active) return active.run(effect, signal);
  return Promise.reject(
    new CodePreviewSessionUnavailable({
      operation: "run",
      message: "Code preview session is not active.",
    }),
  );
}

export { previewScheduleEffect };
