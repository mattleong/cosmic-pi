// Local CLI fixture processes intentionally exercise adapter-to-service lifecycle ordering.
// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import { makeLocalClaudeBackendDriver } from "../src/backend/local-claude.ts";
import { makeLocalCodexBackendDriver } from "../src/backend/local-codex.ts";
import type { BackendEvent, BackendDriver } from "../src/backend/model.ts";
import { makeSubagentBackendRegistry, SubagentBackendRegistry } from "../src/backend/service.ts";
import { makeLocalCliProcess } from "../src/boundary/local-cli-process.ts";
import type {
  SupervisorChannelHandle,
  SupervisorChannelShape,
} from "../src/boundary/supervisor-channel.ts";
import { WriterLeaseService } from "../src/boundary/writer-lease.ts";
import type { SubagentError } from "../src/run/errors.ts";
import type { StartSubagentRequest } from "../src/run/model.ts";
import { SubagentService, type SubagentServiceShape } from "../src/run/service.ts";

const fixture = fileURLToPath(new URL("./fixtures/local-cli-fixture.mjs", import.meta.url));

type LocalRuntime = "claude" | "codex";

const request = (runtime: LocalRuntime, model: string): StartSubagentRequest => ({
  host: "local",
  runtime,
  closeOnReport: true,
  backend: "pi",
  task: "Exercise interrupt ordering.",
  cwd: process.cwd(),
  execution: "background",
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
  model,
  effort: "xhigh",
  effortWasExplicit: true,
  activeTools: [],
  projectTrusted: true,
  parentSessionId: "parent-session",
});

const supervisorFixture = (
  options: { readonly reportOnEpoch?: boolean; readonly progressBeforeReport?: number } = {},
): SupervisorChannelShape => ({
  open: (openRequest) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<
        Extract<BackendEvent, { readonly type: "supervisor_contact" | "report" }>,
        Cause.Done
      >();
      const acceptedReports = new Set<number>();
      return {
        runId: openRequest.runId,
        metadata: {
          runId: openRequest.runId,
          host: "127.0.0.1",
          port: 1,
          stateDirectory: "/private/fixture",
          connectionConfigPath: "/private/fixture/connection.json",
          helperPath: "/private/helper.mjs",
          claudeMcp: {
            mcpServers: {
              pi_subagents_supervisor: {
                type: "stdio",
                command: process.execPath,
                args: ["/private/helper.mjs"],
                env: {},
              },
            },
          },
          codexMcp: {
            serverName: "pi_subagents_supervisor",
            command: process.execPath,
            args: ["/private/helper.mjs"],
            enabledTools: [
              "supervisor_progress",
              "supervisor_warning",
              "supervisor_question",
              "supervisor_submit_report",
            ],
            tomlFragment: "[mcp_servers.pi_subagents_supervisor]\nrequired = true",
          },
        },
        events,
        awaitReady: Effect.void,
        setAssignmentEpoch: (epoch) =>
          Effect.sync(() => {
            if (!options.reportOnEpoch) return;
            acceptedReports.add(epoch);
            for (let index = 0; index < (options.progressBeforeReport ?? 0); index += 1)
              Queue.offerUnsafe(events, {
                type: "supervisor_contact",
                assignmentEpoch: epoch,
                requestId: `progress-${index}`,
                kind: "progress",
                message: `Backpressured progress ${index}`,
              });
            Queue.offerUnsafe(events, {
              type: "report",
              runId: openRequest.runId,
              assignmentEpoch: epoch,
              sequence: 1,
              deliveryId: "service-report",
              text: "Service-owned accepted report.",
            });
          }),
        hasAcceptedReport: (epoch) => Effect.succeed(acceptedReports.has(epoch)),
        acceptedReportForEpoch: (epoch) =>
          Effect.succeed(
            acceptedReports.has(epoch)
              ? {
                  runId: openRequest.runId,
                  assignmentEpoch: epoch,
                  sequence: 1,
                  deliveryId: "service-report",
                  text: "Service-owned accepted report.",
                }
              : undefined,
          ),
        reply: () => Effect.void,
        cancelPending: () => {},
        close: Effect.sync(() => Queue.endUnsafe(events)),
      } satisfies SupervisorChannelHandle;
    }),
});

const writerLeaseLayer = Layer.succeed(WriterLeaseService, {
  platform: "linux" as const,
  canonicalize: () => Effect.die("read-only fixture must not canonicalize writer cwd"),
  acquire: () => Effect.die("read-only fixture must not acquire writer lease"),
  markSpawnStarted: () => Effect.die("read-only fixture must not mark writer lease"),
  release: () => Effect.die("read-only fixture must not release writer lease"),
});

const withService = async <A>(
  runtime: LocalRuntime,
  use: (service: SubagentServiceShape) => Effect.Effect<A, SubagentError, Scope.Scope>,
  supervisorOptions: {
    readonly reportOnEpoch?: boolean;
    readonly progressBeforeReport?: number;
  } = {},
): Promise<A> => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-local-service-"));
  const home = join(directory, "home");
  await fs.mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    join(home, ".codex", "auth.json"),
    `${JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture" } })}\n`,
    { mode: 0o600 },
  );
  const processes = makeLocalCliProcess({
    agentDirectory: directory,
    executables: { claude: fixture, codex: fixture },
    environment: { HOME: home, PATH: process.env.PATH },
  });
  const supervisors = supervisorFixture(supervisorOptions);
  const driver: BackendDriver =
    runtime === "claude"
      ? makeLocalClaudeBackendDriver(processes, supervisors)
      : makeLocalCodexBackendDriver(processes, supervisors);
  const registry = Layer.succeed(SubagentBackendRegistry, makeSubagentBackendRegistry([driver]));
  const layer = SubagentService.layer().pipe(
    Layer.provide(Layer.merge(registry, writerLeaseLayer)),
  );
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* SubagentService;
          return yield* use(service);
        }).pipe(Effect.provide(layer)),
      ),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
};

describe("SubagentService local CLI interrupt integration", () => {
  for (const [runtime, models] of [
    ["claude", ["claude-fixture", "interrupt-terminal-first", "interrupt-result-first"]],
    ["codex", ["codex-fixture", "interrupt-notification-first"]],
  ] as const)
    for (const model of models)
      it(`${runtime} pauses exactly once for interrupt ordering ${model}`, async () => {
        const result = await withService(runtime, (service) =>
          Effect.gen(function* () {
            const run = yield* service.start(request(runtime, model));
            const paused = yield* service.interrupt(run.id);
            yield* Effect.sleep("25 millis");
            const current = yield* service.status(run.id);
            const guidanceFailure = yield* service.send(run.id, "Continue").pipe(
              Effect.match({
                onFailure: (error) => error.message,
                onSuccess: () => "",
              }),
            );
            return { paused, current, guidanceFailure };
          }),
        );
        expect(result.paused.state).toBe("paused");
        expect(result.current.state).toBe("paused");
        expect(result.current.reportGeneration).toBe(0);
        expect(result.guidanceFailure).toContain("cannot resume it; stop it");
        expect(result.guidanceFailure).toContain("start a replacement");
      });

  it("settles Claude success only through an accepted causal supervisor report", async () => {
    const completed = await withService(
      "claude",
      (service) =>
        Effect.gen(function* () {
          const run = yield* service.start(request("claude", "completed-with-report"));
          let current = yield* service.status(run.id);
          for (let attempt = 0; attempt < 100 && current.state !== "completed"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            current = yield* service.status(run.id);
          }
          return current;
        }),
      { reportOnEpoch: true },
    );
    expect(completed.state).toBe("completed");
    expect(completed.finalText).toBe("Service-owned accepted report.");

    const missing = await withService("claude", (service) =>
      Effect.gen(function* () {
        const run = yield* service.start(request("claude", "completed-without-report"));
        let current = yield* service.status(run.id);
        for (let attempt = 0; attempt < 100 && current.state !== "failed"; attempt += 1) {
          yield* Effect.sleep("10 millis");
          current = yield* service.status(run.id);
        }
        return current;
      }),
    );
    expect(missing.state).toBe("failed");
    expect(missing.error).toContain("without an accepted supervisor report");
  });

  it("lets an accepted Codex report win behind progress backpressure", async () => {
    const current = await withService(
      "codex",
      (service) =>
        Effect.gen(function* () {
          const run = yield* service.start(request("codex", "completed-with-report"));
          let current = yield* service.status(run.id);
          for (let attempt = 0; attempt < 100 && current.state !== "completed"; attempt += 1) {
            yield* Effect.sleep("10 millis");
            current = yield* service.status(run.id);
          }
          return current;
        }),
      { reportOnEpoch: true, progressBeforeReport: 100 },
    );
    expect(current.state).toBe("completed");
    expect(current.finalText).toBe("Service-owned accepted report.");
  });

  it("fails a Codex turn without a report by causal protocol evidence", async () => {
    const current = await withService("codex", (service) =>
      Effect.gen(function* () {
        const run = yield* service.start(request("codex", "completed-without-report"));
        let current = yield* service.status(run.id);
        for (let attempt = 0; attempt < 100 && current.state !== "failed"; attempt += 1) {
          yield* Effect.sleep("10 millis");
          current = yield* service.status(run.id);
        }
        return current;
      }),
    );
    expect(current.state).toBe("failed");
    expect(current.error).toContain("without an accepted supervisor report");
  });

  it("preserves a genuine Claude result failure during an interrupt lifecycle", async () => {
    const current = await withService("claude", (service) =>
      Effect.gen(function* () {
        const run = yield* service.start(request("claude", "interrupt-genuine-error"));
        const interrupting = yield* service.interrupt(run.id).pipe(Effect.forkScoped);
        let current = yield* service.status(run.id);
        for (let attempt = 0; attempt < 100 && current.state !== "failed"; attempt += 1) {
          yield* Effect.sleep("10 millis");
          current = yield* service.status(run.id);
        }
        yield* Fiber.interrupt(interrupting);
        return current;
      }),
    );
    expect(current.state).toBe("failed");
    expect(current.error).toContain("genuine fixture failure");
  });
});
