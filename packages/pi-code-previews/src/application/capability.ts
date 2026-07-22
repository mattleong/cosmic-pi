import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import type { CodePreviewRuntimeError } from "../layer";
import type { CodePreviewSession } from "./service";
import type { CodePreviewSettingsService } from "../config/service";
import type { CodePreviewSyntaxService } from "../syntax/service";
import type { CodePreviewWriteService } from "../write/service";
import {
  deferProjectedCodePreview,
  publishCodePreviewDefer,
  publishCodePreviewSchedule,
  publishCodePreviewSessionActive,
} from "./projection";

type SessionRequirements =
  | CodePreviewSession
  | CodePreviewSettingsService
  | CodePreviewSyntaxService
  | CodePreviewWriteService
  | Layer.Success<typeof nodeFilePlatformLayer>;

export type CodePreviewSessionFiber<A, E> = Fiber.Fiber<A, E | CodePreviewRuntimeError>;

export class CodePreviewSessionUnavailable extends Schema.TaggedErrorClass<CodePreviewSessionUnavailable>()(
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
}

let activeCapability: CodePreviewSessionCapability | undefined;

const invokeCodePreviewCallback = (task: () => void): Effect.Effect<void> =>
  Effect.try({ try: task, catch: () => undefined }).pipe(Effect.ignore);

function forkSessionEffect<A, E>(
  capability: CodePreviewSessionCapability,
  effect: Effect.Effect<A, E, SessionRequirements>,
): CodePreviewSessionFiber<A, E> | undefined {
  try {
    return capability.fork(effect);
  } catch {
    return undefined;
  }
}

function interruptSessionFiber<A, E>(
  capability: CodePreviewSessionCapability,
  fiber: Fiber.Fiber<A, E> | undefined,
): void {
  if (!fiber) return;
  forkSessionEffect(capability, Fiber.interrupt(fiber));
}

function scheduleWithCapability(
  capability: CodePreviewSessionCapability,
  interval: number,
  task: () => void,
): () => void {
  const fiber = forkSessionEffect(capability, previewScheduleEffect(interval, task));
  return () => interruptSessionFiber(capability, fiber);
}

export function installCodePreviewSessionCapability(
  capability: CodePreviewSessionCapability | undefined,
): void {
  activeCapability = capability;
  publishCodePreviewSessionActive(capability !== undefined);
  publishCodePreviewDefer(
    capability
      ? (task) => {
          const fiber = forkSessionEffect(
            capability,
            Effect.yieldNow.pipe(Effect.andThen(invokeCodePreviewCallback(task))),
          );
          return () => {
            interruptSessionFiber(capability, fiber);
          };
        }
      : undefined,
  );
  publishCodePreviewSchedule(
    capability ? (interval, task) => scheduleWithCapability(capability, interval, task) : undefined,
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

/** Queue only inside the active session; outside it the synchronous renderer remains unchanged. */
export function deferCodePreview(task: () => void): () => void {
  return deferProjectedCodePreview(task);
}

/** Fixed cadence avoids recursive-sleep drift while remaining TestClock driven. */
export const previewScheduleEffect = (interval: number, task: () => void) =>
  Effect.sleep(interval).pipe(
    Effect.andThen(Effect.repeat(invokeCodePreviewCallback(task), Schedule.fixed(interval))),
    Effect.asVoid,
  );

export function scheduleCodePreview(interval: number, task: () => void): () => void {
  const active = activeCapability;
  if (!active) return () => undefined;
  return scheduleWithCapability(active, interval, task);
}
