import {
  applyPresentationSettings,
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  writeGallerySection,
  type GalleryScenario,
} from "pi-code-previews/testing";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { registerAskUserTool } from "../src/tools/ask-user.ts";
import { registerAsyncAskUserTools } from "../src/tools/ask-user-async.ts";

const noExecution = () => {
  throw new Error("Rendering must not execute");
};
const outcome = {
  outcome: "submitted",
  answers: [{ key: "decision", kind: "text", text: "Ship it", note: "After the review" }],
};
interface RequestFields {
  readonly status: "pending" | "submitted";
  readonly delivery: "pending" | "failed";
  readonly presentation?: "open" | "queued";
  readonly outcome?: typeof outcome;
}
const request = (requestId: string, fields: RequestFields) => ({
  requestId,
  deliveryId: `delivery-${requestId}`,
  ...fields,
});
const text = (value: string) => [{ type: "text" as const, text: value }];

const scenarios: ReadonlyArray<GalleryScenario> = [
  {
    title: "questionnaires waiting for answers",
    args: { action: "status" },
    result: {
      content: text("Agent-facing questionnaire status"),
      details: {
        requests: [
          request("request-1", { status: "pending", delivery: "pending", presentation: "open" }),
          request("request-2", { status: "pending", delivery: "pending", presentation: "queued" }),
        ],
      },
    },
  },
  {
    title: "answers saved but not delivered",
    args: { action: "status" },
    result: {
      content: text("Agent-facing questionnaire status"),
      details: {
        requests: [request("request-1", { status: "submitted", delivery: "failed", outcome })],
      },
    },
  },
];

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders questionnaire states in both collapsed styles", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const) {
        const restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
        try {
          const tool = captureRegistrations((pi) => {
            registerAskUserTool(pi, noExecution);
            registerAsyncAskUserTools(pi, noExecution, noExecution);
          }).tools.find((entry) => entry.name === "ask_user_async_control")!;
          for (const scenario of scenarios)
            lines.push(
              ...galleryFrames(tool, { ...scenario, title: `${style} · ${scenario.title}` }),
            );
        } finally {
          restore();
        }
      }
      yield* writeGallerySection(directory, "pi-ask-user", lines);
    }),
  );
});
