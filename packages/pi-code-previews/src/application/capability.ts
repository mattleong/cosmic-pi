import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import type { CodePreviewSettingsService } from "../config/service";
import type { CodePreviewSyntaxService } from "../syntax/service";
import type { CodePreviewWriteService } from "../write/service";
import type { CodePreviewSchedulerServiceContract } from "./scheduler";

type SessionRequirements =
  | CodePreviewSettingsService
  | CodePreviewSyntaxService
  | CodePreviewWriteService
  | Layer.Success<typeof nodeFilePlatformLayer>;

export class CodePreviewSessionUnavailable extends Schema.TaggedError<CodePreviewSessionUnavailable>()(
  "CodePreviewSessionUnavailable",
  { operation: Schema.String, message: Schema.String },
) {}

export interface CodePreviewSessionCapability extends CodePreviewSchedulerServiceContract {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, SessionRequirements>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

let activeCapability: CodePreviewSessionCapability | undefined;

export function installCodePreviewSessionCapability(
  capability: CodePreviewSessionCapability | undefined,
): void {
  activeCapability = capability;
}

export function clearCodePreviewSessionCapability(): void {
  activeCapability = undefined;
}

export function hasCodePreviewSessionCapability(): boolean {
  return activeCapability !== undefined;
}

const inactiveCancellation = (): void => undefined;

export function deferCodePreview(task: () => void): () => void {
  return activeCapability?.defer(task) ?? inactiveCancellation;
}

export function scheduleCodePreview(interval: number, task: () => void): () => void {
  return activeCapability?.schedule(interval, task) ?? inactiveCancellation;
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
