import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  galleryDirectory,
  galleryFrames,
  writeGallerySection,
  withPresentationSettings,
  type GalleryScenario,
} from "pi-code-previews/testing";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { styleNativeMcp } from "../src/tools/native-mcp-render";

const dynamic: ToolDefinition<any, any, any> = {
  name: "mcp__docs__lookup",
  label: "docs/lookup",
  description: "MCP tool fixture",
  parameters: opaqueFixture({ type: "object" }),
  exposure: "direct",
  namespace: { name: "mcp__docs" },
  execute: () => Promise.resolve({ content: [], details: { server: "docs", tool: "lookup" } }),
};
const resource = (name: string): ToolDefinition<any, any, any> => ({
  name,
  label: name,
  description: "MCP resource fixture",
  parameters: opaqueFixture({ type: "object" }),
  annotations: { readOnlyHint: true },
  exposure: "direct",
  execute: () => Promise.resolve({ content: [], details: { server: "docs", tool: name } }),
});
const result = (
  text: string,
  details = { server: "docs", tool: "lookup" },
): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details,
});
const clipped =
  "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\nHEAD\nTAIL";
const scenarios: Array<{ definition: ToolDefinition<any, any, any>; scenario: GalleryScenario }> = [
  {
    definition: dynamic,
    scenario: { title: "Pending tool", args: { query: "Getting started" }, phase: "pending" },
  },
  {
    definition: dynamic,
    scenario: {
      title: "Progress",
      args: { query: "Getting started" },
      phase: "running",
      result: result("Searching documentation"),
    },
  },
  {
    definition: dynamic,
    scenario: {
      title: "Neutral returned output",
      args: { query: "Getting started" },
      result: result("Guide\nInstallation\nUsage"),
    },
  },
  {
    definition: dynamic,
    scenario: {
      title: "Error and recovery",
      args: { query: "Getting started" },
      isError: true,
      result: result("Lookup failed\nRetry with another query; retained recovery detail"),
    },
  },
  {
    definition: dynamic,
    scenario: {
      title: "Saved clipping",
      args: {},
      result: {
        ...result(`${clipped}\n[Full output: /tmp/mcp-output.txt]`),
        details: { server: "docs", tool: "lookup", fullOutputPath: "/tmp/mcp-output.txt" },
      },
    },
  },
  {
    definition: dynamic,
    scenario: {
      title: "Unsaved clipping",
      args: {},
      result: result(`${clipped}\n\n[Could not save the full output: ENOSPC]`),
    },
  },
  {
    definition: dynamic,
    scenario: {
      title: "Unclassified native result",
      args: { query: "Raw output" },
      result: { ...result("Unclassified output retained in full"), details: undefined },
    },
  },
  {
    definition: dynamic,
    scenario: {
      title: "Native image",
      args: {},
      result: {
        ...result("Image retained by Pi"),
        content: [
          { type: "text", text: "Image retained by Pi" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      },
    },
  },
  {
    definition: resource("read_mcp_resource"),
    scenario: {
      title: "Read resource",
      args: { server: "docs", uri: "docs://guide" },
      result: result("Resource contents", { server: "docs", tool: "read_mcp_resource" }),
    },
  },
  {
    definition: resource("list_mcp_resources"),
    scenario: {
      title: "Resource pagination and partial server failure",
      args: {},
      result: result(
        JSON.stringify({
          resources: [{ server: "docs", uri: "docs://guide", name: "Guide" }],
          nextCursor: "next",
          errors: [{ server: "offline", error: "Connection unavailable\nDiagnostic evidence" }],
        }),
        { server: "", tool: "list_mcp_resources" },
      ),
    },
  },
  {
    definition: resource("list_mcp_resource_templates"),
    scenario: {
      title: "Empty template listing",
      args: { server: "docs" },
      result: result('{"resourceTemplates":[]}', {
        server: "docs",
        tool: "list_mcp_resource_templates",
      }),
    },
  },
];

const directory = galleryDirectory(process.env);
it.live.skipIf(!directory)("standalone native MCP presentation gallery", () =>
  Effect.gen(function* () {
    const lines = ["# MCP Previews"];
    for (const style of ["preview", "compact"] as const) {
      lines.push(`## ${style}`);
      for (const { definition, scenario } of scenarios)
        lines.push(
          ...withPresentationSettings(
            {
              syntaxHighlighting: false,
              toolCallTiming: false,
              toolCallCollapsedStyle: style,
            },
            () => galleryFrames(styleNativeMcp(definition), scenario),
          ),
        );
    }
    yield* writeGallerySection(directory!, "pi-mcp-previews", lines);
  }),
);
