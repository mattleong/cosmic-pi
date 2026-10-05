/** Owned native-manager boundary fixture; no transport, OAuth, or protocol impersonation. */
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { opaqueFixture } from "pi-cosmic-core/testing";
import type { GalleryScenario } from "../../testing";
import type { PreviewToolInfo } from "../../src/application/renderer-contract";
import type { NativeMcpEvidence } from "../../src/tools/native-mcp-summary";

type Definition = ToolDefinition<any, any, any>;
const Input = Schema.Struct({ mode: Schema.optionalKey(Schema.String) });

export function nativeManagerFixture() {
  let api: ExtensionAPI | undefined;
  let closed = 0;
  let executions = 0;
  let started = false;
  const definitions = new Map<string, Definition>();
  const make = (server: string, tool: string): Definition => ({
    name: `mcp__${server}__${tool}`,
    label: `${server}/${tool}`,
    description: "Owned native definition fixture",
    parameters: opaqueFixture({ type: "object", properties: { mode: { type: "string" } } }),
    outputSchema: opaqueFixture({ type: "object" }),
    exposure: "direct",
    namespace: { name: `mcp__${server}` },
    annotations: { readOnlyHint: true, openWorldHint: true },
    execute: (_id, args, signal) => {
      const { mode } = Schema.decodeUnknownSync(Input)(args);
      executions++;
      if (mode === "abort") return Effect.runPromise(Effect.never, { signal });
      return Promise.resolve({
        content: [
          { type: "text", text: mode === "error" ? "Owned request failed" : "TEXT_RETAINED" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        structuredContent: { retained: true },
        isError: mode === "error",
        details: { server, tool },
      });
    },
  });
  const catalog = (server: string, names: string[]) => {
    if (!api) throw new Error("Fixture has not loaded");
    for (const [name, previous] of definitions) {
      if (
        previous.namespace?.name === `mcp__${server}` &&
        !names.includes(previous.label.slice(server.length + 1))
      ) {
        api.registerTool({ ...previous, exposure: "hidden" });
        definitions.delete(name);
      }
    }
    for (const name of names) {
      const fresh = make(server, name);
      definitions.set(fresh.name, fresh);
      api.registerTool(fresh);
    }
  };
  const syncServers = () => {
    if (!api) return;
    const servers = api.getMcpServers().map((server) => server.name);
    for (const definition of definitions.values()) {
      const server = definition.namespace?.name.slice("mcp__".length);
      if (server && !servers.includes(server)) catalog(server, []);
    }
    for (const server of servers) catalog(server, ["lookup"]);
  };
  const factory: ExtensionFactory = (pi) => {
    api = pi;
    pi.registerCommand("mcp", { handler: () => Promise.resolve() });
    pi.on("session_start", () => {
      started = true;
      syncServers();
    });
    pi.on("mcp_servers_change", syncServers);
    pi.on("session_shutdown", () => {
      if (started) closed++;
      started = false;
    });
  };
  return { factory, catalog, definitions, closed: () => closed, executions: () => executions };
}

/** Shared standalone MCP scenarios for the combined Code Previews gallery. */
export interface NativeMcpGalleryFixture {
  readonly name: string;
  readonly metadata: Pick<PreviewToolInfo, "namespace">;
  readonly scenario: GalleryScenario;
}
const galleryResult = (
  text: string,
  details: NativeMcpEvidence = { server: "docs", tool: "lookup" },
) => ({
  content: [{ type: "text" as const, text }],
  details,
});
const clipped =
  "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\nHEAD\nTAIL";
const dynamicGallery = (scenario: GalleryScenario): NativeMcpGalleryFixture => ({
  name: "mcp__docs__lookup",
  metadata: { namespace: { name: "mcp__docs" } },
  scenario,
});
export const nativeMcpGalleryFixtures: readonly NativeMcpGalleryFixture[] = [
  dynamicGallery({
    title: "MCP pending tool",
    args: { query: "Getting started" },
    phase: "pending",
  }),
  dynamicGallery({
    title: "MCP progress",
    args: { query: "Getting started" },
    phase: "running",
    result: galleryResult("Searching documentation"),
  }),
  dynamicGallery({
    title: "MCP neutral returned output",
    args: { query: "Getting started" },
    result: galleryResult("Guide\nInstallation\nUsage"),
  }),
  dynamicGallery({
    title: "MCP error and recovery",
    args: { query: "Getting started" },
    isError: true,
    result: galleryResult("Lookup failed\nRetry with another query; retained recovery detail"),
  }),
  dynamicGallery({
    title: "MCP saved clipping",
    args: {},
    result: galleryResult(`${clipped}\n[Full output: /tmp/mcp-output.txt]`, {
      server: "docs",
      tool: "lookup",
      fullOutputPath: "/tmp/mcp-output.txt",
    }),
  }),
  dynamicGallery({
    title: "MCP unsaved clipping",
    args: {},
    result: galleryResult(`${clipped}\n\n[Could not save the full output: ENOSPC]`),
  }),
  dynamicGallery({
    title: "MCP unclassified native result",
    args: { query: "Raw output" },
    result: { ...galleryResult("Unclassified output retained in full"), details: undefined },
  }),
  dynamicGallery({
    title: "MCP native image",
    args: {},
    result: {
      ...galleryResult("Image retained by Pi"),
      content: [
        { type: "text", text: "Image retained by Pi" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
    },
  }),
  {
    name: "read_mcp_resource",
    metadata: {},
    scenario: {
      title: "MCP read resource",
      args: { server: "docs", uri: "docs://guide" },
      result: galleryResult("Resource contents", { server: "docs", tool: "read_mcp_resource" }),
    },
  },
  {
    name: "list_mcp_resources",
    metadata: {},
    scenario: {
      title: "MCP resource pagination and partial server failure",
      args: {},
      result: galleryResult(
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
    name: "list_mcp_resource_templates",
    metadata: {},
    scenario: {
      title: "MCP empty template listing",
      args: { server: "docs" },
      result: galleryResult('{"server":"docs","resourceTemplates":[]}', {
        server: "docs",
        tool: "list_mcp_resource_templates",
      }),
    },
  },
];
