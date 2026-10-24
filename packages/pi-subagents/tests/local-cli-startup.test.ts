import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { localClaudeBackendDriver } from "../src/backend/local-claude.ts";
import type { LocalCliHandle, LocalCliWireEvent } from "../src/boundary/local-cli-transport.ts";
import type { ProcessExit } from "../src/boundary/process-transport.ts";
import type { SupervisorEvent } from "../src/supervisor/protocol.ts";
import {
  backendLaunch,
  backendSupervisor,
  supervisorMetadata,
} from "./fixtures/backend-supervisor.ts";
import * as Str from "effect/String";
import * as Arr from "effect/Array";

// A CLI that rejects its launch: it prints to stderr and exits as soon as it is first written to.
const failedStartup = (exit: ProcessExit) =>
  Effect.gen(function* () {
    const childEvents = yield* Queue.unbounded<LocalCliWireEvent, Cause.Done>();
    const exited = yield* Deferred.make<ProcessExit>();
    const child: LocalCliHandle = {
      pid: 4242,
      events: childEvents,
      awaitExit: Deferred.await(exited),
      acknowledge: () => {},
      terminate: () => Effect.void,
      send: () =>
        Effect.sync(() => {
          Deferred.doneUnsafe(exited, Effect.succeed(exit));
          Queue.endUnsafe(childEvents);
        }),
    };
    const supervisorEvents = yield* Queue.unbounded<SupervisorEvent, Cause.Done>();
    const supervisor = backendSupervisor(supervisorMetadata(), supervisorEvents, {
      hasAcceptedReport: () => Effect.succeed(false),
      acceptedReportForEpoch: () => Effect.undefined,
    });
    const backend = yield* localClaudeBackendDriver(
      { preflight: () => Effect.void, spawn: () => Effect.succeed(child) },
      { open: () => Effect.succeed(supervisor) },
    ).spawn(backendLaunch());
    return yield* Effect.flip(backend.controls.initialize);
  });

describe("local CLI startup failure", () => {
  it.effect("keeps Claude's exit status and redacted stderr", () =>
    Effect.gen(function* () {
      const failure = yield* failedStartup({
        exitCode: 2,
        stderr:
          "\u001b[31merror: unknown option '--forward-subagent-text'\u001b[0m token=secret-credential\n",
      });
      const [summary, ...detail] = Str.split(failure.message, "\n");
      expect(summary).toContain("code 2");
      expect(summary).not.toContain("unknown option");
      expect(Arr.join(detail, "\n")).toContain("unknown option '--forward-subagent-text'");
      expect(failure.message).toContain("[REDACTED]");
      expect(failure.message).not.toContain("secret-credential");
      expect(failure.message).not.toContain("\u001b");
    }).pipe(Effect.scoped),
  );
});
