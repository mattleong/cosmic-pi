import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import type { CodePreviewSettingsService } from "../config/service";
import type { CodePreviewSyntaxService } from "../syntax/service";
import type { CodePreviewWriteService } from "../write/service";
import { publishCodePreviewSchedulerProjection } from "./projection";

type SessionRequirements =
  | CodePreviewSettingsService
  | CodePreviewSyntaxService
  | CodePreviewWriteService
  | Layer.Success<typeof nodeFilePlatformLayer>;

export class CodePreviewSessionUnavailable extends Schema.TaggedError<CodePreviewSessionUnavailable>()(
  "CodePreviewSessionUnavailable",
  { operation: Schema.String, message: Schema.String },
) {}

export interface CodePreviewSessionCapability {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, SessionRequirements>,
    signal?: AbortSignal,
  ) => Promise<A>;
  readonly defer: (task: () => void) => () => void;
  readonly schedule: (interval: number, task: () => void) => () => void;
}

let activeCapability: CodePreviewSessionCapability | undefined;

export function installCodePreviewSessionCapability(
  capability: CodePreviewSessionCapability | undefined,
): void {
  activeCapability = capability;
  publishCodePreviewSchedulerProjection(
    capability ? { defer: capability.defer, schedule: capability.schedule } : undefined,
  );
}

export function clearCodePreviewSessionCapability(): void {
  activeCapability = undefined;
  publishCodePreviewSchedulerProjection(undefined);
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
