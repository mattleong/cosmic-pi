// Optional no-inference smoke requires an explicitly separate disposable Herdr server.
import { randomBytes } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { provideBuiltLayer } from "pi-cosmic-core";
import { describe, expect, it } from "vitest";
import type { BackendLaunchRequest } from "../src/backend/model.ts";
import { HerdrCli } from "../src/boundary/herdr-cli.ts";
import { captureHerdrEnvironment } from "../src/boundary/herdr-environment.ts";
import { HerdrHarness } from "../src/boundary/herdr-harness.ts";
import { HerdrHost } from "../src/boundary/herdr-host.ts";
import { SupervisorChannel } from "../src/boundary/supervisor-channel.ts";
import { validateDisposableHerdrSelection } from "./herdr-real-smoke-safety.ts";

const smokeGateEnabled = (source: NodeJS.ProcessEnv): boolean =>
  source.PI_SUBAGENTS_REAL_HERDR_CODEX_SMOKE === "1";
const smokeModel = (source: NodeJS.ProcessEnv): string | undefined =>
  source.PI_SUBAGENTS_HERDR_CODEX_MODEL;
const enabled = smokeGateEnabled(process.env);

const disposableEnvironment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const socket = source.PI_SUBAGENTS_REAL_HERDR_SOCKET_PATH;
  const configPath = source.PI_SUBAGENTS_REAL_HERDR_CONFIG_PATH;
  const paneId = source.PI_SUBAGENTS_REAL_HERDR_PANE_ID;
  if (!socket || !configPath || !paneId)
    throw new Error(
      "Herdr Codex smoke requires a separate disposable socket/config and an existing caller pane ID.",
    );
  const selected = validateDisposableHerdrSelection(socket, configPath, source);
  return captureHerdrEnvironment({
    ...source,
    HERDR_SOCKET_PATH: selected.socket,
    HERDR_CONFIG_PATH: selected.configPath,
    HERDR_SESSION: undefined,
    HERDR_ENV: "1",
    HERDR_PANE_ID: paneId,
  });
};

describe.skipIf(!enabled)("installed Herdr Codex no-inference smoke", () => {
  it("returns atomic native-session evidence and reclaims exact topology", () => {
    const model = smokeModel(process.env);
    if (!model) throw new Error("Herdr Codex smoke requires PI_SUBAGENTS_HERDR_CODEX_MODEL.");
    const environment = disposableEnvironment(process.env);
    const agentDirectory = getAgentDir();
    const boundaries = Layer.merge(
      HerdrCli.layer({ environment }),
      HerdrHarness.layer({ agentDirectory, environment }),
    );
    const host = HerdrHost.layer.pipe(Layer.provide(boundaries));
    const layer = Layer.merge(
      Layer.merge(host, SupervisorChannel.layer({ agentDirectory })),
      boundaries,
    );
    return Effect.runPromise(
      Effect.gen(function* () {
        const cli = yield* HerdrCli;
        const before = yield* cli.snapshot;
        expect([20, 22]).toContain(before.protocol);
        expect(before.panes.some((pane) => pane.paneId === environment.HERDR_PANE_ID)).toBe(true);
        const herdr = yield* HerdrHost;
        const supervisors = yield* SupervisorChannel;
        const runId = `real-herdr-codex-${randomBytes(4).toString("hex")}`;
        const request: BackendLaunchRequest = {
          runId,
          name: runId,
          closeOnReport: true,
          cwd: process.cwd(),
          context: "fresh",
          writeIntent: "read-only",
          openaiFastMode: false,
          model,
          effort: "low",
          activeTools: [],
          projectTrusted: false,
          parentSessionId: `real-herdr-codex-${process.pid}`,
          systemPrompt: "No-inference lifecycle smoke.",
        };
        yield* herdr.preflight({ runtime: "codex", ...request });
        const channel = yield* supervisors.open({ runId });
        const hosted = yield* herdr.launch("codex", request, channel.metadata);
        yield* channel.awaitReady;
        yield* hosted.close;
        const after = yield* cli.snapshot;
        expect(after.panes.some((pane) => pane.paneId === environment.HERDR_PANE_ID)).toBe(true);
        expect(after.panes.some((pane) => pane.paneId === hosted.paneId)).toBe(false);
        expect(after.agents.some((agent) => agent.name === hosted.agentName)).toBe(false);
      }).pipe(Effect.scoped, provideBuiltLayer(layer)),
    );
  }, 180_000);
});
