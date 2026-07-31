// Optional real-host smoke. It starts native runtimes but never submits a model prompt.
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/strictEffectProvide:off
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { HerdrCli } from "../src/boundary/herdr-cli.ts";
import { HerdrHarness } from "../src/boundary/herdr-harness.ts";
import { HerdrHost } from "../src/boundary/herdr-host.ts";
import { SupervisorChannel } from "../src/boundary/supervisor-channel.ts";
import type { BackendLaunchRequest } from "../src/backend/model.ts";

const enabled = process.env.PI_SUBAGENTS_REAL_HERDR_SMOKE === "1";
const models = {
  pi: process.env.PI_SUBAGENTS_HERDR_PI_MODEL,
  claude: process.env.PI_SUBAGENTS_HERDR_CLAUDE_MODEL,
  codex: process.env.PI_SUBAGENTS_HERDR_CODEX_MODEL,
} as const;

describe.skipIf(!enabled)("installed Herdr no-inference smoke", () => {
  it("preflights, starts, confirms helper readiness, and immediately stops all runtimes without prompting", async () => {
    for (const [runtime, model] of Object.entries(models))
      if (!model) throw new Error(`Missing PI_SUBAGENTS_HERDR_${runtime.toUpperCase()}_MODEL.`);
    const agentDirectory = getAgentDir();
    const boundaries = Layer.merge(HerdrCli.layer(), HerdrHarness.layer({ agentDirectory }));
    const host = HerdrHost.layer.pipe(Layer.provide(boundaries));
    const layer = Layer.merge(host, SupervisorChannel.layer({ agentDirectory }));
    await Effect.runPromise(
      Effect.gen(function* () {
        const herdr = yield* HerdrHost;
        const supervisors = yield* SupervisorChannel;
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
          const runId = `real-herdr-${runtime}`;
          const channel = yield* supervisors.open({ runId });
          const launch: BackendLaunchRequest = {
            runId,
            name: runId,
            closeOnReport: true,
            cwd: process.cwd(),
            context: "fresh",
            writeIntent: "read-only",
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
    expect(true).toBe(true);
  }, 180_000);
});
