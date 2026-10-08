/** Owned native-manager boundary fixture; no transport, OAuth, or protocol impersonation. */
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { opaqueFixture } from "pi-cosmic-core/testing";

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
