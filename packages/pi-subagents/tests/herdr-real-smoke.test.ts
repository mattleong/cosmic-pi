// Optional real-host smoke. Every suite requires an explicitly separate disposable Herdr server.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/cryptoRandomBytes:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/strictEffectProvide:off
import { randomBytes } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { describe, expect, it } from "vitest";
import { makeHerdrBackendDriver } from "../src/backend/herdr.ts";
import type { BackendHandle, BackendLaunchRequest } from "../src/backend/model.ts";
import {
  HerdrCli,
  makeHerdrCli,
  type HerdrCliShape,
  type HerdrCreatedWorkspace,
} from "../src/boundary/herdr-cli.ts";
import { captureHerdrEnvironment } from "../src/boundary/herdr-environment.ts";
import { HerdrHarness } from "../src/boundary/herdr-harness.ts";
import { HerdrHost } from "../src/boundary/herdr-host.ts";
import { SupervisorChannel } from "../src/boundary/supervisor-channel.ts";
import { validateDisposableHerdrSelection } from "./herdr-real-smoke-safety.ts";

const noInferenceEnabled = process.env.PI_SUBAGENTS_REAL_HERDR_SMOKE === "1";
const shellEnabled = process.env.PI_SUBAGENTS_REAL_HERDR_SHELL_SMOKE === "1";
const assignmentEnabled = process.env.PI_SUBAGENTS_REAL_HERDR_ASSIGNMENT_SMOKE === "1";
const assignmentAcknowledged =
  process.env.PI_SUBAGENTS_REAL_HERDR_ASSIGNMENT_ACK === "paid-and-destructive";
const models = {
  pi: process.env.PI_SUBAGENTS_HERDR_PI_MODEL,
  claude: process.env.PI_SUBAGENTS_HERDR_CLAUDE_MODEL,
  codex: process.env.PI_SUBAGENTS_HERDR_CODEX_MODEL,
} as const;

const disposableEnvironment = (): NodeJS.ProcessEnv => {
  const socket = process.env.PI_SUBAGENTS_REAL_HERDR_SOCKET_PATH;
  const configPath = process.env.PI_SUBAGENTS_REAL_HERDR_CONFIG_PATH;
  if (!socket || !configPath)
    throw new Error(
      "Real Herdr smoke requires PI_SUBAGENTS_REAL_HERDR_SOCKET_PATH and PI_SUBAGENTS_REAL_HERDR_CONFIG_PATH for a separately provisioned disposable server.",
    );
  const disposable = validateDisposableHerdrSelection(socket, configPath, process.env);
  return captureHerdrEnvironment({
    ...process.env,
    HERDR_SOCKET_PATH: disposable.socket,
    HERDR_CONFIG_PATH: disposable.configPath,
    HERDR_SESSION: undefined,
  });
};

const assertProtocol = (snapshot: { readonly version: string; readonly protocol: number }) => {
  expect(snapshot.protocol).toBe(19);
  expect(snapshot.version).toMatch(/^0\.8\./u);
};

const assertEmptyDisposableSnapshot = (snapshot: {
  readonly version: string;
  readonly protocol: number;
  readonly workspaces: ReadonlyArray<unknown>;
  readonly tabs: ReadonlyArray<unknown>;
  readonly panes: ReadonlyArray<unknown>;
  readonly agents: ReadonlyArray<unknown>;
}) => {
  assertProtocol(snapshot);
  if (
    snapshot.workspaces.length > 0 ||
    snapshot.tabs.length > 0 ||
    snapshot.panes.length > 0 ||
    snapshot.agents.length > 0
  )
    throw new Error(
      "Real Herdr smoke refuses a non-empty server; provision isolated XDG config/state homes and a fresh socket.",
    );
};

const requiredModels = () => {
  for (const [runtime, model] of Object.entries(models))
    if (!model) throw new Error(`Missing PI_SUBAGENTS_HERDR_${runtime.toUpperCase()}_MODEL.`);
};

const makeBoundaries = (environment: NodeJS.ProcessEnv) => {
  const agentDirectory = getAgentDir();
  const boundaries = Layer.merge(
    HerdrCli.layer({ environment }),
    HerdrHarness.layer({ agentDirectory, environment }),
  );
  const host = HerdrHost.layer.pipe(Layer.provide(boundaries));
  return {
    layer: Layer.merge(Layer.merge(host, SupervisorChannel.layer({ agentDirectory })), boundaries),
  };
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const markerCommand = (marker: string): string => {
  const pivot = Math.floor(marker.length / 2);
  return `printf '%s%s\\n' ${shellQuote(marker.slice(0, pivot))} ${shellQuote(marker.slice(pivot))}`;
};

const closeExactShellWorkspace = async (
  cli: HerdrCliShape,
  created: HerdrCreatedWorkspace,
): Promise<void> => {
  const snapshot = await Effect.runPromise(cli.snapshot);
  const workspace = snapshot.workspaces.find(
    (candidate) => candidate.workspaceId === created.workspaceId,
  );
  const tab = snapshot.tabs.find((candidate) => candidate.tabId === created.tabId);
  const pane = snapshot.panes.find((candidate) => candidate.paneId === created.rootPane.paneId);
  const exact =
    snapshot.workspaces.length === 1 &&
    snapshot.tabs.length === 1 &&
    snapshot.panes.length === 1 &&
    snapshot.agents.length === 0 &&
    workspace?.label === created.workspaceLabel &&
    workspace.activeTabId === created.tabId &&
    tab?.workspaceId === created.workspaceId &&
    tab.label === created.tabLabel &&
    tab.paneCount === 1 &&
    pane?.terminalId === created.rootPane.terminalId &&
    pane.workspaceId === created.workspaceId &&
    pane.tabId === created.tabId;
  if (!exact)
    throw new Error(
      "Disposable Herdr smoke topology changed after creation; refusing to close unproven workspace ownership.",
    );
  await Effect.runPromise(cli.closeWorkspace(created.workspaceId));
  const after = await Effect.runPromise(cli.snapshot);
  if (after.workspaces.some((candidate) => candidate.workspaceId === created.workspaceId))
    throw new Error("Disposable Herdr smoke workspace closure was not confirmed.");
};

describe.skipIf(!shellEnabled)("installed Herdr real-shell marker smoke", () => {
  for (const source of ["recent", "recent-unwrapped"] as const) {
    it(`${source} observes the same long marker on a disposable server`, async () => {
      const environment = disposableEnvironment();
      const cli = makeHerdrCli({ environment, paneOutputSource: source });
      assertEmptyDisposableSnapshot(await Effect.runPromise(cli.snapshot));
      const marker = `pi-subagents-shell-${source}-${randomBytes(256).toString("hex")}`;
      const created = await Effect.runPromise(
        cli.createWorkspace(process.cwd(), `pi-subagents shell ${source}`),
      );
      let testFailure: unknown;
      let cleanupFailure: unknown;
      try {
        await Effect.runPromise(
          cli.runPaneCommand(
            created.rootPane.paneId,
            markerCommand(marker),
            "prepare pane environment",
          ),
        );
        await Effect.runPromise(
          cli.waitPaneOutput(created.rootPane.paneId, marker, "confirm pane environment"),
        );
      } catch (error) {
        testFailure = error;
      } finally {
        try {
          await closeExactShellWorkspace(cli, created);
        } catch (error) {
          cleanupFailure = error;
        }
      }
      if (cleanupFailure) throw cleanupFailure;
      if (testFailure) throw testFailure;
    }, 60_000);
  }
});

describe.skipIf(!noInferenceEnabled)("installed Herdr no-inference smoke", () => {
  it("preflights, starts, confirms helper readiness, and immediately stops all runtimes without prompting", async () => {
    requiredModels();
    const environment = disposableEnvironment();
    const { layer } = makeBoundaries(environment);
    await Effect.runPromise(
      Effect.gen(function* () {
        const cli = yield* HerdrCli;
        const herdr = yield* HerdrHost;
        const supervisors = yield* SupervisorChannel;
        assertEmptyDisposableSnapshot(yield* cli.snapshot);
        for (const runtime of ["pi", "claude", "codex"] as const) {
          const model = models[runtime]!;
          yield* herdr.preflight({
            runtime,
            context: "fresh",
            writeIntent: "read-only",
            closeOnReport: true,
            model,
            effort: "xhigh",
            cwd: process.cwd(),
          });
          const runId = `real-herdr-${runtime}-${randomBytes(4).toString("hex")}`;
          const channel = yield* supervisors.open({ runId });
          const launch: BackendLaunchRequest = {
            runId,
            name: runId,
            closeOnReport: true,
            cwd: process.cwd(),
            context: "fresh",
            writeIntent: "read-only",
            fastMode: false,
            model,
            effort: "xhigh",
            activeTools: [],
            projectTrusted: false,
            parentSessionId: `real-smoke-${process.pid}`,
            systemPrompt: "No-inference smoke: do not submit a task prompt.",
          };
          const hosted = yield* herdr.launch(runtime, launch, channel.metadata);
          yield* channel.awaitReady;
          yield* hosted.close;
        }
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  }, 180_000);
});

const awaitAssignmentEvidence = (handle: BackendHandle, marker: string) =>
  Effect.gen(function* () {
    let started = false;
    let reported = false;
    while (!started || !reported) {
      const event = yield* Queue.take(handle.events);
      handle.acknowledge(event);
      if (event.type === "run_started" && event.assignmentEpoch === 1) started = true;
      if (event.type === "report" && event.assignmentEpoch === 1) {
        expect(event.text).toContain(marker);
        reported = true;
      }
      if (event.type === "protocol_error")
        return yield* Effect.die(new Error(`Herdr assignment protocol failure: ${event.message}`));
      if (event.type === "exit")
        return yield* Effect.die(
          new Error(`Herdr assignment exited before report: ${event.diagnostic}`),
        );
    }
  }).pipe(
    Effect.timeoutOption("3 minutes"),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.void
        : Effect.die(new Error("Timed out waiting for Herdr assignment start/report evidence.")),
    ),
  );

describe.skipIf(!assignmentEnabled)("installed Herdr paid assignment smoke", () => {
  it("requires explicit paid/destructive acknowledgement", () => {
    expect(assignmentAcknowledged).toBe(true);
  });

  it.skipIf(!assignmentAcknowledged)(
    "submits and receives one supervisor-owned report from every Herdr runtime",
    async () => {
      requiredModels();
      const environment = disposableEnvironment();
      const { layer } = makeBoundaries(environment);
      await Effect.runPromise(
        Effect.gen(function* () {
          const cli = yield* HerdrCli;
          const host = yield* HerdrHost;
          const supervisors = yield* SupervisorChannel;
          assertEmptyDisposableSnapshot(yield* cli.snapshot);
          for (const runtime of ["pi", "claude", "codex"] as const) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const marker = `herdr-assignment-${runtime}-${randomBytes(12).toString("hex")}`;
                const runId = `real-herdr-assignment-${runtime}-${randomBytes(4).toString("hex")}`;
                const request: BackendLaunchRequest = {
                  runId,
                  name: runId,
                  closeOnReport: true,
                  cwd: process.cwd(),
                  context: "fresh",
                  writeIntent: "read-only",
                  fastMode: false,
                  model: models[runtime]!,
                  effort: "xhigh",
                  activeTools: [],
                  projectTrusted: false,
                  parentSessionId: `real-assignment-smoke-${process.pid}`,
                  systemPrompt: "Read-only smoke. Follow the assignment exactly.",
                };
                const driver = makeHerdrBackendDriver(runtime, host, supervisors);
                if (driver.preflight) yield* driver.preflight(request);
                const handle = yield* driver.spawn(request);
                yield* handle.controls.initialize;
                yield* handle.controls.start(
                  `Do not inspect files or perform other work. Immediately call supervisor_submit_report with a fresh delivery_id and report text containing exactly this marker: ${marker}`,
                  1,
                );
                yield* awaitAssignmentEvidence(handle, marker);
                yield* handle.terminate("graceful");
              }),
            );
          }
        }).pipe(Effect.scoped, Effect.provide(layer)),
      );
    },
    600_000,
  );
});
