// Lifecycle fixture owns Promise callbacks and mirrors Pi's public command registry only.
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  RegisteredCommand,
  SlashCommandInfo,
  SourceInfo,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePiManagedRuntime } from "pi-cosmic-core";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { afterEach } from "vitest";
import { animationSchedulerProbe } from "../../testing";
import { codePreviewsWithDependencies } from "../../src/application/lifecycle";
import { CodePreviewSchedulerService } from "../../src/application/scheduler";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { codePreviewApplicationLayer } from "../../src/layer";
import type { CompactAnimationScheduler } from "../../src/tools/compact-summary";
import { getNativeMcpStatus } from "../../src/tools/native-mcp-registration";
import { effectTest, step } from "../support/effect-test";

type Definition = ToolDefinition<any, any, any>;
type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
type Handler = (
  event: Readonly<Record<never, never>>,
  ctx: ExtensionContext,
) => void | Promise<void>;

const owned: SourceInfo = {
  source: "previews",
  path: "/owner.ts",
  scope: "user",
  origin: "top-level",
};
const foreign: SourceInfo = { ...owned, source: "other", path: "/foreign.ts" };
const preview = { ...defaultCodePreviewSettings, syntaxHighlighting: false, tools: [] };
const nativeEvents = [
  "session_start",
  "before_agent_start",
  "turn_start",
  "mcp_servers_change",
  "session_shutdown",
] as const;

const nativeTool = (name: string): Definition => ({
  name,
  label: name,
  description: "Fixture native MCP tool",
  parameters: { type: "object", properties: {} },
  execute: () => Promise.resolve({ content: [{ type: "text", text: name }], details: undefined }),
});

/** An owned stand-in for Pi's native manager: records every delivered callback. */
function nativeManager(calls: string[], registerLater: (register: () => void) => void) {
  let api: ExtensionAPI | undefined;
  const record = (name: string) => () => {
    calls.push(name);
  };
  const factory: ExtensionFactory = (pi) => {
    api = pi;
    pi.on("session_start", () => {
      calls.push("session_start");
      pi.registerTool(nativeTool("mcp__docs__lookup"));
    });
    pi.on("before_agent_start", record("before_agent_start"));
    pi.on("turn_start", record("turn_start"));
    pi.on("mcp_servers_change", record("mcp_servers_change"));
    pi.on("session_shutdown", () => {
      calls.push("session_shutdown");
      registerLater(() => pi.registerTool(nativeTool("mcp__docs__late")));
    });
    pi.registerCommand("mcp", {
      description: "Fixture manager",
      getArgumentCompletions: () => [{ value: "login", label: "login" }],
      handler: () => {
        calls.push("/mcp");
        return Promise.resolve();
      },
    });
  };
  return { factory, api: () => api };
}

type Harness = ReturnType<typeof harness>;

function harness(
  options: {
    readonly optIn?: boolean | "unreadable";
    readonly factory?: (calls: string[]) => ExtensionFactory | undefined;
    readonly style?: (definition: Definition) => Definition;
  } = {},
) {
  const handlers: Array<{ readonly name: string; readonly handler: Handler }> = [];
  const commands: Array<{
    readonly name: string;
    readonly sourceInfo: SourceInfo;
    command?: Command;
  }> = [];
  const registered: Definition[] = [];
  const forwarded: string[] = [];
  const calls: string[] = [];
  const styled: Array<{
    readonly native: Definition;
    readonly schedule?: CompactAnimationScheduler;
  }> = [];
  const notices: string[] = [];
  const later: Array<() => void> = [];
  const probe = animationSchedulerProbe();
  let factoryCalls = 0;
  const forward = (name: string) => () => {
    forwarded.push(name);
  };
  const listed = (): SlashCommandInfo[] => {
    const counts = new Map<string, number>();
    for (const { name } of commands) counts.set(name, (counts.get(name) ?? 0) + 1);
    const seen = new Map<string, number>();
    return commands.map(({ name, sourceInfo }) => {
      const occurrence = (seen.get(name) ?? 0) + 1;
      seen.set(name, occurrence);
      const invocation = (counts.get(name) ?? 0) > 1 ? `${name}:${occurrence}` : name;
      return { name: invocation, source: "extension", sourceInfo };
    });
  };
  const pi = extensionApiFixture({
    on: (name: string, handler: Handler) => {
      handlers.push({ name, handler });
      return () => undefined;
    },
    registerCommand: (name: string, command: Command) => {
      commands.push({ name, sourceInfo: owned, command });
    },
    registerTool: (definition: Definition) => {
      registered.push(definition);
    },
    getCommands: listed,
    getAllTools: () => [],
    getActiveTools: () => [],
    registerShortcut: forward("shortcut"),
    registerFlag: forward("flag"),
    registerMessageRenderer: forward("message renderer"),
    registerMarkdownTransformer: forward("markdown transformer"),
    registerEntryRenderer: forward("entry renderer"),
    registerProvider: forward("provider"),
    unregisterProvider: forward("provider removal"),
    registerMcpServer: forward("MCP server"),
    unregisterMcpServer: forward("MCP server removal"),
    registerVirtualModel: forward("virtual model"),
    unregisterVirtualModel: forward("virtual model removal"),
    events: {
      emit: forward("event-bus message"),
      on: () => {
        forwarded.push("event-bus listener");
        return () => undefined;
      },
    },
  });
  const ctx = extensionContextFixture({
    cwd: "/project",
    isProjectTrusted: () => false,
    ui: {
      notify: (message: string) => {
        notices.push(message);
      },
    },
  });
  const manager = nativeManager(calls, (register) => later.push(register));
  const registration = codePreviewsWithDependencies(pi, {
    makeRuntime: (api) =>
      makePiManagedRuntime(
        api,
        Layer.merge(
          codePreviewApplicationLayer,
          Layer.succeed(CodePreviewSchedulerService, {
            defer: () => () => undefined,
            schedule: (interval, tick) => probe.schedule(interval, tick)!,
          }),
        ),
      ),
    registerCommands: (api) =>
      api.registerCommand("code-previews", {
        description: "Owned Code Previews fixture",
        handler: () => Promise.resolve(),
      }),
    loadStartupSettings: () =>
      options.optIn === "unreadable"
        ? Promise.reject(new Error("unreadable settings"))
        : Promise.resolve({ nativeMcpPreviews: options.optIn ?? true }),
    loadSettings: () =>
      Effect.sync(() => {
        setCodePreviewSettings(preview);
        return preview;
      }),
    initializeSyntax: () => Effect.void,
    registerRenderers: () => undefined,
    nativeMcp: {
      createFactory: () => {
        factoryCalls++;
        return options.factory ? options.factory(calls) : manager.factory;
      },
      style: (definition, schedule) => {
        styled.push(schedule ? { native: definition, schedule } : { native: definition });
        return options.style ? options.style(definition) : { ...definition, label: "styled" };
      },
    },
  });
  // Like Pi, each handler for one event settles before the next registered handler runs.
  const emit = (name: string) =>
    step(() =>
      handlers
        .filter((candidate) => candidate.name === name)
        .reduce<Promise<void>>(
          (previous, entry) => previous.then(() => entry.handler({}, ctx)),
          Promise.resolve(),
        ),
    );
  const managerCommand = () => commands.find((entry) => entry.name === "mcp")?.command;
  return {
    registration,
    handlers,
    registered,
    forwarded,
    calls,
    styled,
    notices,
    probe,
    ctx,
    emit,
    factoryCalls: () => factoryCalls,
    commandNames: () => listed().map((command) => command.name),
    managerCommand,
    nativeApi: manager.api,
    runLater: () => later.splice(0).forEach((register) => register()),
    addForeign: (name: string, sourceInfo = foreign) => {
      commands.push({ name, sourceInfo });
    },
  };
}

const composed = (options?: Parameters<typeof harness>[0]) =>
  Effect.suspend(() => {
    const h = harness(options);
    return step(() => h.registration).pipe(Effect.as(h));
  });

const handlerNames = (h: Harness) => h.handlers.map((entry) => entry.name);

afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

for (const optIn of [false, "unreadable"] as const)
  effectTest(`startup opt-in ${optIn} leaves Pi's builtin MCP untouched`, function* () {
    const h = yield* composed({ optIn });
    assert.equal(h.factoryCalls(), 0);
    assert.deepEqual(h.commandNames(), ["code-previews"]);
    assert.deepEqual(handlerNames(h), ["session_start", "session_shutdown"]);
    assert.equal(getNativeMcpStatus().state, "off");
  });

effectTest("a Pi without the native factory composes nothing", function* () {
  const h = yield* composed({ factory: () => undefined });
  assert.deepEqual(h.commandNames(), ["code-previews"]);
  assert.deepEqual(handlerNames(h), ["session_start", "session_shutdown"]);
  assert.equal(getNativeMcpStatus().state, "unavailable");
});

type FailedFactory = readonly [string, (pi: ExtensionAPI) => void | Promise<void>];
const eagerRegistrations: ReadonlyArray<readonly [string, (pi: ExtensionAPI) => void]> = [
  ["flag", (pi) => pi.registerFlag("mcp-flag", { type: "boolean" })],
  ["shortcut", (pi) => pi.registerShortcut("ctrl+m", { handler: () => undefined })],
  ["message renderer", (pi) => pi.registerMessageRenderer("mcp", () => undefined)],
  ["provider", (pi) => pi.registerProvider("mcp", { baseUrl: "http://localhost" })],
  ["MCP server", (pi) => pi.registerMcpServer("docs", { command: "fixture" })],
  ["event-bus listener", (pi) => void pi.events.on("mcp", () => undefined)],
];
const failedFactories: ReadonlyArray<FailedFactory> = [
  ...eagerRegistrations.map(
    ([label, register]): FailedFactory => [
      `swallows a refused eager ${label}`,
      (pi) => {
        pi.on("session_start", () => undefined);
        pi.registerCommand("mcp", { handler: () => Promise.resolve() });
        try {
          register(pi);
        } catch {
          // A changed factory may catch the refusal; composition must still fail as a whole.
        }
      },
    ],
  ),
  [
    "throws after registering",
    (pi) => {
      pi.on("session_start", () => undefined);
      pi.registerCommand("mcp", { handler: () => Promise.resolve() });
      throw new Error("native factory failed");
    },
  ],
  [
    "rejects asynchronously",
    (pi) => {
      pi.on("session_start", () => undefined);
      pi.registerCommand("mcp", { handler: () => Promise.resolve() });
      return Promise.reject(new Error("native factory failed"));
    },
  ],
  ["omits /mcp", (pi) => void pi.on("session_start", () => undefined)],
  [
    "registers another command",
    (pi) => {
      pi.registerCommand("mcp", { handler: () => Promise.resolve() });
      pi.registerCommand("mcp-extra", { handler: () => Promise.resolve() });
    },
  ],
  [
    "registers an eager tool",
    (pi) => {
      pi.registerCommand("mcp", { handler: () => Promise.resolve() });
      pi.registerTool(nativeTool("eager"));
    },
  ],
];

for (const [label, factory] of failedFactories)
  effectTest(`a native factory that ${label} leaves no partial takeover`, function* () {
    const h = yield* composed({ factory: () => factory });
    assert.deepEqual(h.commandNames(), ["code-previews"]);
    assert.deepEqual(handlerNames(h), ["session_start", "session_shutdown"]);
    assert.deepEqual(h.forwarded, []);
    assert.deepEqual(h.registered, []);
    assert.equal(getNativeMcpStatus().state, "failed");
  });

effectTest("the owned manager starts once and receives every native callback", function* () {
  const h = yield* composed();
  assert.deepEqual(h.commandNames(), ["code-previews", "mcp"]);
  assert.equal(getNativeMcpStatus().state, "composed");
  yield* h.emit("session_start");
  assert.equal(getNativeMcpStatus().state, "owned");
  for (const name of nativeEvents.slice(1, -1)) yield* h.emit(name);
  const command = h.managerCommand();
  assert.ok(command);
  yield* step(() => command.handler("", h.ctx));
  const completions = yield* step(() =>
    Promise.resolve(command.getArgumentCompletions?.("lo") ?? null),
  );
  assert.deepEqual(
    completions?.map((item) => item.value),
    ["login"],
  );
  yield* h.emit("session_shutdown");
  assert.deepEqual(h.calls, [...nativeEvents.slice(0, -1), "/mcp", "session_shutdown"]);
  // Native tools arrive after preview activation, so the fresh definition is styled.
  assert.deepEqual(
    h.registered.map((definition) => definition.label),
    ["styled"],
  );
  assert.equal(h.styled[0]?.native.name, "mcp__docs__lookup");
});

const conflicts: ReadonlyArray<readonly [string, (h: Harness) => void]> = [
  ["another extension's /mcp", (h) => h.addForeign("mcp")],
  ["a duplicate /code-previews anchor", (h) => h.addForeign("code-previews")],
];
for (const [label, conflict] of conflicts)
  effectTest(`${label} keeps the composed manager stopped`, function* () {
    const h = yield* composed();
    conflict(h);
    for (const name of nativeEvents) yield* h.emit(name);
    const command = h.managerCommand();
    assert.ok(command);
    yield* step(() => command.handler("", h.ctx));
    assert.equal(
      yield* step(() => Promise.resolve(command.getArgumentCompletions?.("lo") ?? null)),
      null,
    );
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.registered, []);
    assert.equal(h.notices.length, 1);
    assert.equal(getNativeMcpStatus().state, "conflict");
  });

effectTest(
  "an admitted manager preserves native lifecycle after a later command conflict",
  function* () {
    const h = yield* composed();
    yield* h.emit("session_start");
    h.addForeign("mcp");
    for (const name of nativeEvents.slice(1, -1)) yield* h.emit(name);
    const command = h.managerCommand();
    assert.ok(command);
    yield* step(() => command.handler("", h.ctx));
    yield* h.emit("session_shutdown");
    yield* h.emit("session_shutdown");
    assert.deepEqual(h.calls, [...nativeEvents.slice(0, -1), "session_shutdown"]);
  },
);

effectTest(
  "retired presentation revokes animation and later definitions stay native",
  function* () {
    const h = yield* composed();
    yield* h.emit("session_start");
    const schedule = h.styled[0]?.schedule;
    assert.ok(schedule);
    let ticks = 0;
    assert.ok(schedule(100, () => void ticks++));
    h.probe.tick();
    assert.equal(ticks, 1);
    const scheduled = h.probe.scheduled;
    // The preview lifecycle retires first; native shutdown still runs after it.
    yield* h.emit("session_shutdown");
    h.probe.tick();
    assert.equal(ticks, 1);
    assert.equal(
      schedule(100, () => void ticks++),
      undefined,
    );
    assert.equal(h.probe.scheduled, scheduled);
    h.runLater();
    const late = h.registered.at(-1);
    assert.equal(late?.name, "mcp__docs__late");
    assert.notEqual(late?.label, "styled");
    assert.equal(h.styled.length, 1);
  },
);

effectTest("a presentation failure registers the native definition unstyled", function* () {
  const h = yield* composed({
    style: () => {
      throw new Error("presentation failed");
    },
  });
  yield* h.emit("session_start");
  const [definition] = h.registered;
  assert.equal(definition?.name, "mcp__docs__lookup");
  assert.equal(definition, h.styled[0]?.native);
  assert.deepEqual(
    yield* step(() => definition!.execute("call", {}, undefined, undefined, h.ctx)),
    { content: [{ type: "text", text: "mcp__docs__lookup" }], details: undefined },
  );
  assert.deepEqual(getNativeMcpStatus(), { state: "owned", presentationFailed: true });
});

effectTest("live native callbacks keep the owner's other APIs unchanged", function* () {
  const h = yield* composed();
  yield* h.emit("session_start");
  const api = h.nativeApi();
  assert.ok(api);
  api.registerFlag("late-flag", { type: "boolean" });
  api.events.emit("mcp", undefined);
  assert.deepEqual(h.forwarded, ["flag", "event-bus message"]);
  yield* h.emit("session_shutdown");
});
