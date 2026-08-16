import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, expect, it, vi } from "vitest";
import type { AskUserServiceContract } from "../src/questionnaire/service.ts";
import { AskUserService } from "../src/questionnaire/service.ts";
import { registerAskUserTool } from "../src/tools/ask-user.ts";
import type { AskUserRequest } from "../src/tools/schema.ts";

const request: AskUserRequest = {
  questions: [
    {
      key: "approach",
      title: "Approach",
      prompt: "Which approach?",
      mode: "single",
      choices: [
        { value: "safe", label: "Safe", description: "Minimize risk." },
        { value: "fast", label: "Fast", description: "Optimize delivery." },
      ],
    },
  ],
};

interface CapturedTool {
  readonly name: string;
  readonly executionMode?: string;
  readonly renderShell?: string;
  readonly promptGuidelines?: readonly string[];
  readonly execute: (
    id: string,
    input: AskUserRequest,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: readonly { type: string; text: string }[]; details: unknown }>;
}

describe("ask_user tool", () => {
  it("returns structured answers", () => {
    const service: AskUserServiceContract = {
      ask: () =>
        Effect.succeed({
          outcome: "submitted" as const,
          answers: [
            {
              key: "approach",
              kind: "choices" as const,
              values: ["safe"],
              labels: ["Safe"],
              note: "Keep the migration small.",
            },
          ],
        }),
    };
    const runtime = ManagedRuntime.make(Layer.succeed(AskUserService, service));
    let tool: CapturedTool | undefined;
    const fixture = {
      registerTool: vi.fn((definition: CapturedTool) => {
        tool = definition;
      }),
    };
    // SAFETY: registerAskUserTool uses only registerTool from this fixture.
    const pi = fixture as typeof fixture & ExtensionAPI;

    registerAskUserTool(pi, {
      run: (effect, signal) => runtime.runPromise(effect, signal ? { signal } : undefined),
    });

    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    return tool!
      .execute("call", request, undefined, undefined, {} as ExtensionContext)
      .then((result) => {
        expect(result.details).toMatchObject({ outcome: "submitted" });
        expect(result.content[0]?.text).toContain("safe (Safe)");
        expect(result.content[0]?.text).toContain("Keep the migration small");
      })
      .finally(() => runtime.dispose());
  });
});
