// Explicitly gated installed-CLI smoke; it performs auth/readiness probes only and spends no model tokens.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/asyncFunction:off
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect, it } from "vitest";
import { makeLocalCliProcess } from "../src/boundary/local-cli-process.ts";
import { makeSupervisorChannel } from "../src/boundary/supervisor-channel.ts";
import { makeLocalClaudeBackendDriver } from "../src/backend/local-claude.ts";
import { makeLocalCodexBackendDriver } from "../src/backend/local-codex.ts";
import type { BackendLaunchRequest } from "../src/backend/model.ts";

it.runIf(process.env.PI_SUBAGENTS_REAL_CLI_SMOKE === "1")(
  "preflights installed Claude Code and Codex without inference",
  async () => {
    const agentDirectory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-real-cli-"));
    try {
      const processes = makeLocalCliProcess({ agentDirectory });
      for (const runtime of ["claude", "codex"] as const)
        await expect(
          Effect.runPromise(
            processes.preflight({
              runtime,
              context: "fresh",
              writeIntent: "read-only",
              closeOnReport: true,
              model: runtime === "claude" ? "sonnet" : "gpt-5.6-sol",
              effort: "xhigh",
              cwd: process.cwd(),
            }),
          ),
        ).resolves.toBeUndefined();
      await expect(
        Effect.runPromise(
          processes.preflight({
            runtime: "claude",
            context: "fresh",
            writeIntent: "writer",
            closeOnReport: true,
            model: "sonnet",
            effort: "xhigh",
            cwd: process.cwd(),
          }),
        ),
      ).resolves.toBeUndefined();

      const supervisors = makeSupervisorChannel({ agentDirectory });
      const request = (runtime: "claude" | "codex", model: string): BackendLaunchRequest => ({
        runId: `real-${runtime}`,
        name: `real-${runtime}`,
        closeOnReport: true,
        cwd: process.cwd(),
        context: "fresh",
        writeIntent: "read-only",
        fastMode: false,
        model,
        effort: "xhigh",
        activeTools: [],
        projectTrusted: true,
        parentSessionId: "real-smoke",
        systemPrompt: "Do not begin work; readiness smoke only.",
      });
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const claude = yield* makeLocalClaudeBackendDriver(processes, supervisors).spawn(
              request("claude", "sonnet"),
            );
            yield* claude.controls.initialize;
            const claudeEarlyExit = yield* claude.awaitExit.pipe(
              Effect.timeoutOption("500 millis"),
            );
            expect(Option.isNone(claudeEarlyExit)).toBe(true);
            const codex = yield* makeLocalCodexBackendDriver(processes, supervisors).spawn(
              request("codex", "gpt-5.6-sol"),
            );
            expect(yield* codex.controls.initialize).toMatchObject({
              model: "gpt-5.6-sol",
              effort: "xhigh",
            });
            const claudeWriter = yield* makeLocalClaudeBackendDriver(processes, supervisors).spawn({
              ...request("claude", "sonnet"),
              runId: "real-claude-writer",
              writeIntent: "writer",
            });
            expect(yield* claudeWriter.controls.initialize).toMatchObject({
              model: expect.stringContaining("claude-sonnet"),
              effort: "xhigh",
            });
          }),
        ),
      );
    } finally {
      await fs.rm(agentDirectory, { recursive: true, force: true });
    }
  },
  20_000,
);
