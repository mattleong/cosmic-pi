import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type { BackendHandle, BackendLaunchRequest } from "../../src/backend/model.ts";

export const backendLaunch = (
  overrides: Partial<BackendLaunchRequest> = {},
): BackendLaunchRequest => ({
  runId: "agent-fixture",
  name: "fixture",
  cwd: process.cwd(),
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  model: "fixture",
  effort: "high",
  activeTools: [],
  projectTrusted: false,
  parentSessionId: "parent-session",
  systemPrompt: "Complete the fixture task.",
  ...overrides,
});

export const takeBackendEvent = (
  backend: Pick<BackendHandle, "events" | "acknowledge">,
  options: { readonly timeout?: Duration.Input; readonly acknowledge?: boolean } = {},
) =>
  Queue.take(backend.events).pipe(
    Effect.timeoutOption(options.timeout ?? "5 seconds"),
    Effect.flatMap((event) =>
      Option.isSome(event) ? Effect.succeed(event.value) : Effect.die("fixture event timeout"),
    ),
    Effect.tap((event) =>
      Effect.sync(() => {
        if (options.acknowledge) backend.acknowledge(event);
      }),
    ),
    Effect.orDie,
  );
