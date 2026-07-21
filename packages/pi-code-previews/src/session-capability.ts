import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Layer from "effect/Layer";
import { nodeFilePlatformLayer, type PiSessionRuntimeSlot } from "pi-cosmic-core";
import type { CodePreviewSession } from "./session-service";
import type { CodePreviewSettingsService } from "./settings/service";
import type { CodePreviewSyntaxService } from "./syntax/service";
import type { CodePreviewWriteService } from "./write/service";
import {
  deferProjectedCodePreview,
  publishCodePreviewDefer,
  publishCodePreviewSessionActive,
} from "./session-projection";

type SessionRequirements =
  | CodePreviewSession
  | CodePreviewSettingsService
  | CodePreviewSyntaxService
  | CodePreviewWriteService
  | Layer.Success<typeof nodeFilePlatformLayer>;

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
  ) => Fiber.Fiber<A, unknown> | undefined;
}

let activeCapability: CodePreviewSessionCapability | undefined;

export function installCodePreviewSessionCapability(
  capability: CodePreviewSessionCapability | undefined,
): void {
  activeCapability = capability;
  publishCodePreviewSessionActive(capability !== undefined);
  publishCodePreviewDefer(
    capability
      ? (task) => {
          const fiber = capability.fork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(task))));
          return () => {
            if (fiber) capability.fork(Fiber.interrupt(fiber));
          };
        }
      : undefined,
  );
}

export function installCodePreviewSessionSlot<R, E>(
  slot: PiSessionRuntimeSlot<unknown, SessionRequirements | R, E>,
  token: number,
): void {
  installCodePreviewSessionCapability({
    token,
    run: (effect, signal) => slot.run(effect, signal),
    fork: (effect, signal) => slot.fork(effect, signal),
  });
}

export function clearCodePreviewSessionCapability(token?: number): void {
  if (token === undefined || activeCapability?.token === token) {
    activeCapability = undefined;
    publishCodePreviewSessionActive(false);
    publishCodePreviewDefer(undefined);
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

export function forkCodePreviewSessionEffect<A, E>(
  effect: Effect.Effect<A, E, SessionRequirements>,
  signal?: AbortSignal,
): Fiber.Fiber<A, unknown> | undefined {
  return activeCapability?.fork(effect, signal);
}

/** Queue only inside the active session; outside it the synchronous renderer remains unchanged. */
export function deferCodePreview(task: () => void): () => void {
  return deferProjectedCodePreview(task);
}

/** Fixed cadence avoids recursive-sleep drift while remaining TestClock driven. */
export const previewScheduleEffect = (interval: number, task: () => void) =>
  Effect.sleep(interval).pipe(
    Effect.andThen(Effect.repeat(Effect.sync(task), Schedule.fixed(interval))),
    Effect.asVoid,
  );

export function scheduleCodePreview(interval: number, task: () => void): () => void {
  const active = activeCapability;
  if (!active) return () => undefined;
  const fiber = active.fork(previewScheduleEffect(interval, task));
  return () => {
    if (fiber) active.fork(Fiber.interrupt(fiber));
  };
}
