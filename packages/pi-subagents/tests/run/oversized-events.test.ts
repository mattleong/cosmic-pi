import { describe, expect, it } from "@effect/vitest";
import { yieldUntil } from "pi-cosmic-core/testing";
import { OVERSIZED_IMAGE_DATA, oversizedLine as oversized } from "../support/oversized-line.ts";
import {
  assistantMessageEndFrame,
  localServiceFixture,
  request,
  withService,
} from "./fixtures/service-harness.ts";

const IMAGE = { type: "image", mimeType: "image/png", data: OVERSIZED_IMAGE_DATA };

const toolResult = (toolCallId: string, isError: boolean) => ({
  role: "toolResult",
  toolCallId,
  toolName: "read",
  content: [IMAGE],
  isError,
  timestamp: 1,
});

describe("oversized Pi child events", () => {
  it.effect("settles normally after a 6 MiB agent_end and turn_end", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      const control = fake.controls[0]!;
      const answer = assistantMessageEndFrame("Screenshot reviewed.");
      control.offer(answer);
      control.offerOversizedLine(
        oversized({
          type: "turn_end",
          message: answer.message,
          toolResults: [toolResult("t", false)],
        }),
      );
      control.offerOversizedLine(
        oversized({
          type: "agent_end",
          messages: [toolResult("t", false), answer.message],
          willRetry: false,
        }),
      );
      control.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      expect(yield* service.status(run.id)).toMatchObject({
        state: "completed",
        finalText: "Screenshot reviewed.",
      });
    });
  });

  it.effect("closes tools whose results exceed the line limit and keeps their outcome", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      const control = fake.controls[0]!;
      for (const [toolCallId, isError] of [
        ["shot", false],
        ["broken", true],
      ] as const) {
        control.offer({
          type: "tool_execution_start",
          toolCallId,
          toolName: "read",
          args: { path: `${toolCallId}.png` },
        });
        control.offerOversizedLine(
          oversized({
            type: "tool_execution_update",
            toolCallId,
            toolName: "read",
            args: {},
            partialResult: { content: [IMAGE] },
          }),
        );
        control.offerOversizedLine(
          oversized({
            type: "tool_execution_end",
            toolCallId,
            toolName: "read",
            result: { content: [IMAGE], details: { isError: !isError } },
            isError,
            durationMs: 12,
          }),
        );
        const message = toolResult(toolCallId, isError);
        control.offerOversizedLine(oversized({ type: "message_start", message }));
        control.offerOversizedLine(oversized({ type: "message_end", message }));
      }
      const settledTools = () =>
        projections
          .at(-1)
          ?.runs[0]?.sessionEvents.filter(
            (event) => event.type === "tool" && event.state !== "running",
          ).length;
      yield* yieldUntil(() => settledTools() === 2);
      expect((yield* service.status(run.id)).sessionEvents).toMatchObject([
        { type: "tool", toolName: "read", state: "completed" },
        { type: "tool", toolName: "read", state: "failed" },
      ]);
      control.settle("Done.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
    });
  });

  it.effect("fails the run when an oversized event carries data the run needs", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      const control = fake.controls[0]!;
      control.offerOversizedLine(
        oversized({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: IMAGE.data }] },
        }),
      );
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      expect((yield* service.status(run.id)).state).toBe("failed");
    });
  });
});
