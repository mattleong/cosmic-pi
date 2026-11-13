import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import { localPiBackendDriver } from "../../src/backend/local-pi.ts";
import type { BackendHandle, BackendLaunchRequest } from "../../src/backend/model.ts";
import type { ChildProcessHandle } from "../../src/boundary/child-process.ts";

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

/** An inert Pi child process over `events`; a test overrides the members it observes. */
export const piChild = (
  events: ChildProcessHandle["events"],
  overrides: Partial<ChildProcessHandle> = {},
): ChildProcessHandle => ({
  pid: 4242,
  events,
  awaitExit: Effect.never,
  send: () => Effect.void,
  acknowledge: () => {},
  sendContactControl: () => Effect.void,
  terminate: () => Effect.void,
  ...overrides,
});

/** The local Pi backend's handle over a fixture child. */
export const spawnPi = (child: Effect.Effect<ChildProcessHandle, never, Scope.Scope>) =>
  localPiBackendDriver({ spawn: () => child, reclaimRunState: () => Effect.void }).spawn(
    backendLaunch(),
  );

export const takeBackendEvent = (
  backend: Pick<BackendHandle, "events" | "acknowledge">,
  options: { readonly acknowledge?: boolean } = {},
) =>
  Queue.take(backend.events).pipe(
    Effect.timeoutOption("5 seconds"),
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
