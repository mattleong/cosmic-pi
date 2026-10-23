import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { synchronousRandomHex } from "pi-cosmic-core";
import { provideBuiltLayer } from "pi-cosmic-core/testing";
import { assert, describe, expect, it } from "vitest";
import { localClaudeBackendDriver } from "../src/backend/local-claude.ts";
import type { BackendEvent } from "../src/backend/model.ts";
import { SupervisorChannel } from "../src/boundary/supervisor-channel.ts";
import { backendLaunch, takeBackendEvent } from "./fixtures/backend-supervisor.ts";
import { localCliProcess } from "./support/local-cli-process.ts";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

const enabled = process.env.PI_SUBAGENTS_REAL_CLAUDE_REPLAY_SMOKE === "1";

describe.skipIf(!enabled)("installed local Claude replay smoke", () => {
  it("exercises a background Agent, SendMessage, and report delivery after its notification", () => {
    const model = process.env.PI_SUBAGENTS_REAL_CLAUDE_MODEL;
    if (!model) throw new Error("Set PI_SUBAGENTS_REAL_CLAUDE_MODEL for the live replay smoke.");
    const agentDirectory = getAgentDir();
    const environment = { ...process.env, PI_SUBAGENTS_CLAUDE_DEBUG: "1" };
    const launch = backendLaunch({
      runId: `real-local-claude-${synchronousRandomHex(4)}`,
      name: "real-local-claude-replay",
      model,
      effort: "low",
      parentSessionId: `real-local-claude-${process.pid}`,
      systemPrompt: Arr.join(
        [
          "This is an explicit protocol reproduction. Do not edit files.",
          "Use the native Agent tool to launch one short read-only background agent whose whole task is to read package.json and return the package name; tell it not to use any mcp__pi_subagents_supervisor tool.",
          "Use SendMessage once for that agent, then wait for its completion notification.",
          "Finally call mcp__pi_subagents_supervisor__agent_submit_report exactly once with a concise report.",
        ],
        " ",
      ),
    });

    return Effect.runPromise(
      Effect.gen(function* () {
        const processes = yield* localCliProcess({ agentDirectory, environment });
        const supervisors = yield* SupervisorChannel;
        const driver = localClaudeBackendDriver(processes, supervisors);
        yield* driver.preflight(launch);
        const backend = yield* driver.spawn(launch);
        yield* backend.controls.initialize;
        yield* backend.controls.start(
          "Run the Agent and SendMessage reproduction, then submit the supervisor report once the agent's completion notification arrives.",
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
          if (event.type === "supervisor_contact" && event.kind === "question")
            return yield* Effect.die(
              `The reproduction asked an unexpected question: ${event.message}`,
            );
          if (event.type === "exit")
            return yield* Effect.die(`Claude exited before reporting: ${event.diagnostic}`);
          if (event.type === "report") report = event;
        }
        expect(report.assignmentEpoch).toBe(1);
        assert(report.text !== undefined);
        expect(Str.trim(report.text)).toBeTruthy();
        // Claude Code 2.1.299 removed TaskOutput; background results arrive as notifications.
        for (const tool of ["Agent", "SendMessage"])
          expect(observedNativeTools.has(tool), `Claude did not invoke ${tool}`).toBe(true);
        return undefined;
      }).pipe(Effect.scoped, provideBuiltLayer(SupervisorChannel.layer({ agentDirectory }))),
    );
  }, 360_000);
});
