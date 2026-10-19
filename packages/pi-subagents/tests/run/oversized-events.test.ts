import { describe, expect, it } from "@effect/vitest";
import { yieldUntil } from "pi-cosmic-core/testing";
import { OVERSIZED_IMAGE_DATA, oversizedLine as oversized } from "../support/oversized-line.ts";
import {
  assistantMessageEndFrame,
  localServiceFixture,
  request,
  runView,
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
      expect(yield* runView(service, run.id)).toMatchObject({
        state: "completed",
        finalText: "Screenshot reviewed.",
      });
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
      expect((yield* runView(service, run.id)).state).toBe("failed");
    });
  });
});
