// Optional no-inference smoke requires an explicitly separate disposable Herdr server.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/cryptoRandomBytes:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/strictEffectProvide:off
import { randomBytes } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import type { BackendLaunchRequest } from "../src/backend/model.ts";
import { HerdrCli } from "../src/boundary/herdr-cli.ts";
import { captureHerdrEnvironment } from "../src/boundary/herdr-environment.ts";
import { HerdrHarness } from "../src/boundary/herdr-harness.ts";
import { HerdrHost } from "../src/boundary/herdr-host.ts";
import { SupervisorChannel } from "../src/boundary/supervisor-channel.ts";
import { validateDisposableHerdrSelection } from "./herdr-real-smoke-safety.ts";

const enabled = process.env.PI_SUBAGENTS_REAL_HERDR_CODEX_SMOKE === "1";

const disposableEnvironment = (): NodeJS.ProcessEnv => {
  const socket = process.env.PI_SUBAGENTS_REAL_HERDR_SOCKET_PATH;
  const configPath = process.env.PI_SUBAGENTS_REAL_HERDR_CONFIG_PATH;
  const paneId = process.env.PI_SUBAGENTS_REAL_HERDR_PANE_ID;
  if (!socket || !configPath || !paneId)
    throw new Error(
      "Herdr Codex smoke requires a separate disposable socket/config and an existing caller pane ID.",
    );
  const selected = validateDisposableHerdrSelection(socket, configPath, process.env);
  return captureHerdrEnvironment({
    ...process.env,
    HERDR_SOCKET_PATH: selected.socket,
    HERDR_CONFIG_PATH: selected.configPath,
    HERDR_SESSION: undefined,
    HERDR_ENV: "1",
    HERDR_PANE_ID: paneId,
  });
};

describe.skipIf(!enabled)("installed Herdr Codex no-inference smoke", () => {
  it("returns atomic native-session evidence and reclaims exact topology", async () => {
    const model = process.env.PI_SUBAGENTS_HERDR_CODEX_MODEL;
    if (!model) throw new Error("Herdr Codex smoke requires PI_SUBAGENTS_HERDR_CODEX_MODEL.");
    const environment = disposableEnvironment();
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
    await Effect.runPromise(
      Effect.gen(function* () {
        const cli = yield* HerdrCli;
        const before = yield* cli.snapshot;
        expect(before).toMatchObject({ version: expect.stringMatching(/^0\.8\./u), protocol: 19 });
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
          fastMode: false,
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
        expect(hosted.nativeSession).toBeTruthy();
        yield* channel.awaitReady;
        yield* hosted.close;
        const after = yield* cli.snapshot;
        expect(after.panes.some((pane) => pane.paneId === environment.HERDR_PANE_ID)).toBe(true);
        expect(after.panes.some((pane) => pane.paneId === hosted.paneId)).toBe(false);
        expect(after.agents.some((agent) => agent.name === hosted.agentName)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  }, 180_000);
});
