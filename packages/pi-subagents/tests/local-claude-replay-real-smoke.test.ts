// Optional live reproduction. This invokes the installed Claude CLI and can incur
// provider usage; it is excluded unless the caller sets the explicit gate.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { synchronousRandomHex, provideBuiltLayer } from "pi-cosmic-core";
import { describe, expect, it } from "vitest";
import { makeLocalClaudeBackendDriver } from "../src/backend/local-claude.ts";
import type { BackendEvent } from "../src/backend/model.ts";
import { makeLocalCliProcess } from "../src/boundary/local-cli-process.ts";
import { SupervisorChannel } from "../src/boundary/supervisor-channel.ts";
import { backendLaunch, takeBackendEvent } from "./fixtures/backend-supervisor.ts";

const smokeGateEnabled = (source: NodeJS.ProcessEnv): boolean =>
  source.PI_SUBAGENTS_REAL_CLAUDE_REPLAY_SMOKE === "1";
const smokeModel = (source: NodeJS.ProcessEnv): string | undefined =>
  source.PI_SUBAGENTS_REAL_CLAUDE_MODEL;
const sourceEnvironment = { ...process.env };
const enabled = smokeGateEnabled(sourceEnvironment);

describe.skipIf(!enabled)("installed local Claude replay smoke", () => {
  it("exercises Agent, SendMessage, TaskOutput, and supervisor report delivery", () => {
    const model = smokeModel(sourceEnvironment);
    if (!model) throw new Error("Set PI_SUBAGENTS_REAL_CLAUDE_MODEL for the live replay smoke.");
    const agentDirectory = getAgentDir();
    const environment = { ...sourceEnvironment, PI_SUBAGENTS_CLAUDE_DEBUG: "1" };
    const processes = makeLocalCliProcess({ agentDirectory, environment });
    const launch = backendLaunch({
      runId: `real-local-claude-${synchronousRandomHex(4)}`,
      name: "real-local-claude-replay",
      model,
      effort: "low",
      parentSessionId: `real-local-claude-${process.pid}`,
      systemPrompt: [
        "This is an explicit protocol reproduction. Do not edit files.",
        "Use the native Agent tool to launch one short read-only background agent.",
        "Use SendMessage once for that agent, then use TaskOutput to collect its result.",
        "Finally call mcp__pi_subagents_supervisor__supervisor_submit_report exactly once with a concise report.",
      ].join(" "),
    });

    return Effect.runPromise(
      Effect.gen(function* () {
        const supervisors = yield* SupervisorChannel;
        const driver = makeLocalClaudeBackendDriver(processes, supervisors);
        yield* driver.preflight(launch);
        const backend = yield* driver.spawn(launch);
        yield* backend.controls.initialize;
        yield* backend.controls.start(
          "Run the Agent, SendMessage, and TaskOutput reproduction, then submit the supervisor report.",
          1,
        );

        const observedNativeTools = new Set<string>();
        let report: Extract<BackendEvent, { readonly type: "report" }> | undefined;
        while (!report) {
          const event = yield* takeBackendEvent(backend, {
            timeout: "5 minutes",
            acknowledge: true,
          });
          if (event.type === "native_agent_activity") observedNativeTools.add(event.kind);
          if (event.type === "protocol_error") return yield* Effect.die(event.message);
          if (event.type === "exit")
            return yield* Effect.die(`Claude exited before reporting: ${event.diagnostic}`);
          if (event.type === "report") report = event;
        }
        expect(report.assignmentEpoch).toBe(1);
        expect(report.text?.trim()).toBeTruthy();
        for (const tool of ["Agent", "SendMessage", "TaskOutput"])
          expect(observedNativeTools.has(tool), `Claude did not invoke ${tool}`).toBe(true);
      }).pipe(Effect.scoped, provideBuiltLayer(SupervisorChannel.layer({ agentDirectory }))),
    );
  }, 360_000);
});
