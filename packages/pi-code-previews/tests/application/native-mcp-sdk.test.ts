// Public SDK/Promise host boundary with Pi's real native MCP manager over an owned in-memory
// transport fixture. The agent directory is isolated before any native runtime starts.
import assert from "node:assert/strict";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionFactory,
  type LoadedMcpConfig,
  type McpTransportFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { makePiManagedRuntime, nodeFilePlatformLayer } from "pi-cosmic-core";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { codePreviewsWithDependencies } from "../../src/application/lifecycle";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { loadCodePreviewStartupSettings, queueStartupSettingsSave } from "../../src/config/store";
import { codePreviewApplicationLayer } from "../../src/layer";
import { styleNativeMcp } from "../../src/tools/native-mcp-render";
import { getNativeMcpStatus } from "../../src/tools/native-mcp-registration";
import { step } from "../support/effect-test";

type Definition = ToolDefinition<any, any, any>;
type Transport = ReturnType<McpTransportFactory>;
type Message = Parameters<Transport["send"]>[0];

const RequestSchema = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Int])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
});
const decodeRequest = Schema.decodeUnknownSync(RequestSchema);

interface Connection {
  readonly server: string;
  readonly authenticated: boolean;
  closed: boolean;
  authFailed: boolean;
  readonly announceTools: () => void;
}

/** Owned stand-in servers reached only through native `createTransport`; never a process. */
function fixtureServers() {
  const connections: Connection[] = [];
  const catalogs = new Map<string, string[]>([
    ["docs", ["lookup", "fails", "hang"]],
    ["extra", ["search"]],
    ["remote", ["private"]],
  ]);
  const answer = (
    server: string,
    method: string,
    params: Readonly<Record<string, Schema.MutableJson>>,
  ) => {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: params["protocolVersion"],
          capabilities:
            server === "docs" ? { tools: { listChanged: true }, resources: {} } : { tools: {} },
          serverInfo: { name: server, version: "1.0.0" },
        };
      case "tools/list":
        return {
          tools: (catalogs.get(server) ?? []).map((name) => ({
            name,
            description: `Fixture ${name}`,
            inputSchema: { type: "object", properties: { query: { type: "string" } } },
          })),
        };
      case "tools/call":
        if (params["name"] === "hang") return undefined;
        if (params["name"] === "fails")
          return { content: [{ type: "text", text: "Lookup refused" }], isError: true };
        return {
          content: [{ type: "text", text: `Found ${JSON.stringify(params["arguments"])}` }],
          structuredContent: { hits: 1 },
        };
      case "resources/list":
        return { resources: [{ uri: "docs://guide", name: "Guide" }] };
      case "resources/templates/list":
        return { resourceTemplates: [] };
      case "resources/read":
        return { contents: [{ uri: params["uri"], text: "Guide text" }] };
      default:
        return {};
    }
  };
  const create: McpTransportFactory = (entry, _cwd, authProvider) => {
    const messages = new Set<(message: Message) => void>();
    const closes = new Set<() => void>();
    const deliver = (message: Message) =>
      queueMicrotask(() => {
        if (!connection.closed) for (const listener of messages) listener(message);
      });
    const connection: Connection = {
      server: entry.name,
      authenticated: authProvider !== undefined,
      closed: false,
      authFailed: false,
      announceTools: () => deliver({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
    };
    connections.push(connection);
    return {
      start: () => {
        if (!authProvider || "command" in entry.config) return Promise.resolve();
        // Native auth owns the decision: an empty isolated store yields no token, and an
        // unauthorized reply without a refresh grant must require an explicit sign-in.
        return authProvider
          .token()
          .then((token) => {
            assert.equal(token, undefined);
            return authProvider.onUnauthorized?.({
              response: new Response(null, { status: 401 }),
              serverUrl: new URL("https://mcp.invalid/mcp"),
              fetch: () => Promise.reject(new Error("fixture network is unavailable")),
            });
          })
          .catch((cause) => {
            connection.authFailed = true;
            throw cause;
          });
      },
      send: (message) => {
        const request = decodeRequest(message);
        if (request.id === undefined || request.method === undefined) return Promise.resolve();
        const result = answer(entry.name, request.method, request.params ?? {});
        if (result !== undefined) deliver({ jsonrpc: "2.0", id: request.id, result });
        return Promise.resolve();
      },
      close: () => {
        if (!connection.closed) {
          connection.closed = true;
          for (const listener of closes) listener();
        }
        return Promise.resolve();
      },
      onMessage: (listener) => {
        messages.add(listener);
        return () => void messages.delete(listener);
      },
      onError: () => () => undefined,
      onClose: (listener) => {
        closes.add(listener);
        return () => void closes.delete(listener);
      },
    };
  };
  return {
    create,
    connections,
    replaceCatalog: (server: string, tools: string[]) => catalogs.set(server, tools),
  };
}

const eventually = (label: string, check: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (check()) return;
      yield* Effect.sleep(Duration.millis(5));
    }
    assert.fail(`Timed out waiting for ${label}`);
  });

/** Injected native configuration; ambient `mcp.json` files are never read. */
const config = (): LoadedMcpConfig => ({
  servers: [
    { name: "docs", config: { command: "fixture-docs", exposure: "direct" }, source: "fixture" },
    {
      name: "remote",
      config: { url: "https://mcp.invalid/mcp", exposure: "direct" },
      source: "fixture",
    },
  ],
  errors: [],
  autoEnableCodemode: false,
});

interface SessionOptions {
  readonly optIn: boolean;
  readonly foreignManager?: boolean;
  readonly style?: typeof styleNativeMcp;
}

const startSession = (options: SessionOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "preview-native-mcp-" });
    const agentDir = `${directory}/agent`;
    yield* fs.makeDirectory(agentDir, { recursive: true });
    if (options.optIn)
      yield* fs.writeFileString(`${agentDir}/code-previews.json`, '{"nativeMcpPreviews":true}');
    // Native credentials and refresh locks default to the agent directory: isolate it first.
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("CODE_PREVIEW_NATIVE_MCP", undefined);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        vi.unstubAllEnvs();
        setCodePreviewSettings(defaultCodePreviewSettings);
      }),
    );
    const servers = fixtureServers();
    let builtinStarts = 0;
    let ownedStarts = 0;
    let providerApi: ExtensionAPI | undefined;
    const registrations: Definition[] = [];
    const natives = new Map<Definition, Definition>();
    const nativeOptions = {
      createTransport: servers.create,
      logPath: `${directory}/mcp.log`,
      openUrl: () => assert.fail("fixtures never open a browser"),
      updateConfig: () => assert.fail("fixtures never write MCP config"),
      startupWaitMs: 100,
    };
    const models = yield* step(() =>
      ModelRuntime.create({
        authPath: `${directory}/auth.json`,
        modelsPath: null,
        modelsStorePath: `${directory}/models-cache.json`,
        refreshOnCreate: false,
        allowModelNetwork: false,
      }),
    );
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const owner: ExtensionFactory = (pi) =>
      codePreviewsWithDependencies(
        {
          ...pi,
          registerTool(tool) {
            registrations.push(tool);
            pi.registerTool(tool);
          },
        },
        {
          makeRuntime: (api) =>
            makePiManagedRuntime(api, codePreviewApplicationLayer, {
              agentDirectory: () => agentDir,
              packageName: "pi-code-previews",
            }),
          registerCommands: (api) =>
            api.registerCommand("code-previews", {
              description: "Owned Code Previews fixture",
              handler: () => Promise.resolve(),
            }),
          loadStartupSettings: loadCodePreviewStartupSettings,
          loadSettings: () =>
            Effect.sync(() => {
              const preview = {
                ...defaultCodePreviewSettings,
                syntaxHighlighting: false,
                toolCallCollapsedStyle: "compact" as const,
              };
              setCodePreviewSettings(preview);
              return preview;
            }),
          initializeSyntax: () => Effect.void,
          registerRenderers: () => undefined,
          nativeMcp: {
            createFactory: () =>
              createMcpExtension({
                ...nativeOptions,
                loadConfig: () => {
                  ownedStarts++;
                  return config();
                },
              }),
            style: (definition, schedule) => {
              const styled = (options.style ?? styleNativeMcp)(definition, schedule);
              natives.set(styled, definition);
              return styled;
            },
          },
        },
      );
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir,
      settingsManager: settings,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        { name: "code-previews-test", factory: owner },
        {
          name: "mcp",
          builtin: true,
          replaceable: true,
          factory: createMcpExtension({
            ...nativeOptions,
            loadConfig: () => {
              builtinStarts++;
              return { servers: [], errors: [] };
            },
          }),
        },
        {
          name: "server-provider",
          factory: (pi) => {
            providerApi = pi;
            pi.registerMcpServer("extra", { command: "fixture-extra", exposure: "direct" });
          },
        },
        ...(options.foreignManager
          ? [
              {
                name: "foreign-mcp",
                factory: (pi: ExtensionAPI) =>
                  pi.registerCommand("mcp", {
                    description: "Foreign MCP manager",
                    handler: () => Promise.resolve(),
                  }),
              },
            ]
          : []),
      ],
    });
    yield* step(() => loader.reload());
    const { session } = yield* step(() =>
      createAgentSession({
        cwd: directory,
        agentDir,
        modelRuntime: models,
        settingsManager: settings,
        sessionManager: SessionManager.inMemory(directory),
        resourceLoader: loader,
      }),
    );
    yield* Effect.addFinalizer(() =>
      step(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })).pipe(
        Effect.ensuring(Effect.sync(() => session.dispose())),
      ),
    );
    const errors: string[] = [];
    yield* step(() =>
      session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) }),
    );
    return {
      session,
      servers,
      registrations,
      natives,
      errors,
      builtinStarts: () => builtinStarts,
      ownedStarts: () => ownedStarts,
      providerApi: () => providerApi,
    };
  });

const managers = (session: AgentSession) =>
  session.extensionRunner
    .getRegisteredCommands()
    .filter((command) => /^mcp(?::\d+)?$/u.test(command.invocationName));
const visible = (session: AgentSession, name: string) =>
  session.getAllTools().find((tool) => tool.name === name);
const latest = (registrations: readonly Definition[], name: string) =>
  registrations.findLast((definition) => definition.name === name);
const toolContext = extensionContextFixture({});
const outcome = <Result>(run: () => Promise<Result>) =>
  run().then(
    (result) => ({ result }),
    (cause) => ({ error: cause instanceof Error ? cause.message : "rejected" }),
  );

it.live("owned native MCP replaces the builtin and delegates execution, auth, and lifecycle", () =>
  Effect.gen(function* () {
    const h = yield* startSession({ optIn: true });
    const { session, servers } = h;
    // One manager: the replaceable builtin never loaded, and this extension owns the sole /mcp.
    assert.equal(h.builtinStarts(), 0);
    assert.equal(h.ownedStarts(), 1);
    assert.deepEqual(
      managers(session).map((command) => [command.invocationName, command.sourceInfo.path]),
      [["mcp", "<inline:code-previews-test>"]],
    );
    assert.equal(getNativeMcpStatus().state, "owned");
    yield* eventually("native tools", () =>
      ["mcp__docs__lookup", "mcp__extra__search", "read_mcp_resource"].every((name) =>
        latest(h.registrations, name),
      ),
    );
    const lookup = latest(h.registrations, "mcp__docs__lookup");
    assert.ok(lookup);
    assert.equal(
      visible(session, "mcp__docs__lookup")?.sourceInfo.path,
      "<inline:code-previews-test>",
    );

    // Styled definitions delegate native execution unchanged: content, structured results,
    // MCP errors, resource reads, and abort all match the fresh native definition.
    const compare = (name: string, args: Record<string, string>, abort?: boolean) =>
      Effect.gen(function* () {
        const styled = latest(h.registrations, name);
        assert.ok(styled);
        const native = h.natives.get(styled);
        assert.ok(native && native !== styled, `${name} was styled`);
        const run = (definition: Definition) =>
          outcome(() => {
            const controller = new AbortController();
            const pending = definition.execute(
              `call-${name}`,
              args,
              controller.signal,
              undefined,
              toolContext,
            );
            if (abort) queueMicrotask(() => controller.abort());
            return pending;
          });
        const [fromStyled, fromNative] = yield* step(() => Promise.all([run(styled), run(native)]));
        assert.deepEqual(fromStyled, fromNative);
        return fromStyled;
      });
    const found = yield* compare("mcp__docs__lookup", { query: "effect" });
    assert.ok("result" in found);
    const refused = yield* compare("mcp__docs__fails", { query: "denied" });
    assert.ok("result" in refused);
    const aborted = yield* compare("mcp__docs__hang", { query: "slow" }, true);
    assert.ok("error" in aborted);
    yield* compare("read_mcp_resource", { server: "docs", uri: "docs://guide" });

    // Auth stays native: only the URL server received Pi's provider, and it required sign-in.
    const remote = servers.connections.filter((connection) => connection.server === "remote");
    assert.ok(remote.length > 0 && remote.every((connection) => connection.authenticated));
    yield* eventually("remote sign-in decision", () =>
      remote.some((connection) => connection.authFailed),
    );
    assert.equal(latest(h.registrations, "mcp__remote__private"), undefined);
    assert.ok(
      servers.connections
        .filter((connection) => connection.server !== "remote")
        .every((connection) => !connection.authenticated),
    );

    // Server tool changes register fresh native tools and hide withdrawn ones.
    servers.replaceCatalog("docs", ["lookup", "added"]);
    for (const connection of servers.connections.filter((entry) => entry.server === "docs"))
      connection.announceTools();
    yield* eventually(
      "changed docs tools",
      () => visible(session, "mcp__docs__fails")?.exposure === "hidden",
    );
    assert.ok(latest(h.registrations, "mcp__docs__added"));
    assert.ok(h.natives.has(latest(h.registrations, "mcp__docs__fails")!));

    // Even a late command collision must not prevent native server removal and cleanup.
    h.providerApi()?.registerCommand("mcp", {
      description: "Late command collision",
      handler: () => Promise.resolve(),
    });
    assert.equal(managers(session).length, 2);
    h.providerApi()?.unregisterMcpServer("extra");
    yield* eventually(
      "hidden extension server",
      () => visible(session, "mcp__extra__search")?.exposure === "hidden",
    );
    assert.ok(
      servers.connections
        .filter((connection) => connection.server === "extra")
        .every((connection) => connection.closed),
    );

    // Reload shuts the started manager down and composes exactly one fresh owner.
    const before = servers.connections.length;
    yield* step(() => session.reload());
    assert.ok(servers.connections.slice(0, before).every((connection) => connection.closed));
    assert.equal(h.builtinStarts(), 0);
    assert.equal(h.ownedStarts(), 2);
    assert.equal(managers(session).length, 1);
    yield* eventually("reloaded tools", () =>
      servers.connections.slice(before).some((connection) => connection.server === "docs"),
    );
    yield* step(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
    assert.ok(servers.connections.every((connection) => connection.closed));
    assert.deepEqual(h.errors, []);
  }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);

it.live("a configured startup change switches native ownership only after reload", () =>
  Effect.gen(function* () {
    const h = yield* startSession({ optIn: true });
    yield* eventually("owned native tools before settings edit", () =>
      Boolean(latest(h.registrations, "mcp__docs__lookup")),
    );
    const before = h.servers.connections.slice();
    yield* step(() => queueStartupSettingsSave({ nativeMcpPreviews: false }));
    assert.equal(getNativeMcpStatus().state, "owned");
    assert.equal(h.ownedStarts(), 1);
    assert.equal(h.builtinStarts(), 0);
    assert.ok(before.some((connection) => !connection.closed));
    yield* step(() => h.session.reload());
    assert.equal(getNativeMcpStatus().state, "off");
    assert.equal(h.ownedStarts(), 1);
    assert.equal(h.builtinStarts(), 1);
    assert.ok(before.every((connection) => connection.closed));
    assert.deepEqual(
      managers(h.session).map((command) => command.sourceInfo.path),
      ["builtin:mcp"],
    );
  }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);

it.live("without the startup opt-in Pi's builtin MCP runs unchanged", () =>
  Effect.gen(function* () {
    const h = yield* startSession({ optIn: false });
    assert.equal(h.builtinStarts(), 1);
    assert.equal(h.ownedStarts(), 0);
    assert.deepEqual(
      managers(h.session).map((command) => command.sourceInfo.path),
      ["builtin:mcp"],
    );
    assert.equal(getNativeMcpStatus().state, "off");
  }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);

it.live("another extension's /mcp keeps the composed manager from starting", () =>
  Effect.gen(function* () {
    const h = yield* startSession({ optIn: true, foreignManager: true });
    assert.equal(h.builtinStarts(), 0);
    assert.equal(h.ownedStarts(), 0);
    assert.deepEqual(
      managers(h.session).map((command) => command.invocationName),
      ["mcp:1", "mcp:2"],
    );
    assert.equal(getNativeMcpStatus().state, "conflict");
    const owned = managers(h.session).find(
      (command) => command.sourceInfo.path === "<inline:code-previews-test>",
    );
    assert.ok(owned);
    yield* step(() =>
      owned.handler("", extensionContextFixture({ hasUI: false, ui: { notify() {} } })),
    );
    assert.deepEqual(h.servers.connections, []);
  }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);

it.live("a presentation failure keeps owned native MCP working unstyled", () =>
  Effect.gen(function* () {
    const h = yield* startSession({
      optIn: true,
      style: () => {
        throw new Error("presentation failed");
      },
    });
    yield* eventually("unstyled native tools", () =>
      Boolean(latest(h.registrations, "mcp__docs__lookup")),
    );
    const lookup = latest(h.registrations, "mcp__docs__lookup");
    assert.ok(lookup);
    assert.equal(h.natives.size, 0);
    const result = yield* step(() =>
      lookup.execute("call", { query: "unstyled" }, undefined, undefined, toolContext),
    );
    assert.ok(
      result.content.some((part) => part.type === "text" && part.text.includes("unstyled")),
    );
    assert.deepEqual(getNativeMcpStatus(), { state: "owned", presentationFailed: true });
  }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);
