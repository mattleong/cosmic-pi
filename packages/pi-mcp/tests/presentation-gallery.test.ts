import {
  applyPresentationSettings,
  galleryDirectory,
  galleryFrames,
  writeGallerySection,
  type GalleryScenario,
} from "pi-code-previews/testing";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeMcpErrorReceipts } from "../src/boundary/host-tool-result.ts";
import { buildMcpTool, wrapMcpTool } from "../src/tools/controller.ts";
import type { McpGatewayReply } from "../src/tools/model.ts";

const args = { action: "tools.call", server: "browser", tool: "click", arguments: { ref: "e12" } };
const reply = (fields: Partial<McpGatewayReply>) => ({
  action: "tools.call",
  outcome: "completed",
  isError: false,
  notices: [],
  data: {},
  ...fields,
});
const text = (value: string) => [{ type: "text" as const, text: value }];

const scenarios: ReadonlyArray<GalleryScenario> = [
  {
    title: "remote tool error",
    args,
    isError: true,
    result: {
      content: text("The element is no longer attached to the page."),
      details: reply({
        isError: true,
        data: {
          result: {
            isError: true,
            content: [{ type: "text", text: "The element is no longer attached to the page." }],
          },
        },
      }),
    },
  },
  {
    title: "sign-in required",
    args,
    isError: true,
    result: {
      content: text("OAuth sign-in required."),
      details: reply({
        outcome: "not-sent",
        isError: true,
        data: { kind: "auth-required", reason: "auth-oauth-required" },
      }),
    },
  },
  {
    title: "server warnings",
    args,
    result: {
      content: text("Clicked."),
      details: reply({
        notices: [
          "Rate limit is close: 95 of 100 requests used this hour.",
          "Session expires soon.",
        ],
        data: { result: { content: [{ type: "text", text: "Clicked." }] } },
      }),
    },
  },
];

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders MCP failures and notices in both collapsed styles", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const) {
        const restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
        try {
          const tool = wrapMcpTool(
            buildMcpTool({
              owner: Symbol("gallery"),
              receipts: makeMcpErrorReceipts(),
              execute: () => Promise.reject(new Error("Rendering must not execute")),
            }),
          );
          for (const scenario of scenarios)
            lines.push(
              ...galleryFrames(tool, { ...scenario, title: `${style} · ${scenario.title}` }),
            );
        } finally {
          restore();
        }
      }
      yield* writeGallerySection(directory, "pi-mcp", lines);
    }),
  );
});
