import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionToolContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import { modelRegistryFixture, type HostModelRegistry } from "./model.ts";
import { ignore, overlay } from "./overlay.ts";
import { FIXTURE_CWD, sessionManagerFixture, type HostSessionManager } from "./session.ts";
import { extensionUiFixture } from "./ui.ts";

export type ExtensionHostContext = ExtensionContext &
  ExtensionCommandContext &
  ExtensionToolContext;

export type ExtensionContextOverrides = Partial<
  Omit<ExtensionHostContext, "ui" | "sessionManager" | "modelRegistry">
> & {
  readonly ui?: Partial<ExtensionUIContext>;
  readonly sessionManager?: Partial<HostSessionManager>;
  readonly modelRegistry?: Partial<HostModelRegistry>;
};

type ToolCallOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

interface ContextDefaults {
  readonly cwd: string;
  readonly mode: ExtensionContext["mode"];
  readonly hasUI: boolean;
  readonly ui: ExtensionUIContext;
  readonly sessionManager: HostSessionManager;
  readonly modelRegistry: ExtensionContext["modelRegistry"];
}

const nestedContextKeys = new Set(["ui", "sessionManager", "modelRegistry"]);

const unavailableToolOutcome = (name: string): ToolCallOutcome => ({
  toolCall: { type: "toolCall", id: "fixture-tool-call", name, arguments: {} },
  result: {
    content: [{ type: "text", text: `Tool ${name} is unavailable in this fixture.` }],
    details: undefined,
    isError: true,
  },
  isError: true,
});

const cancelled = () => Promise.resolve({ cancelled: true });

const contextDefaults = (defaults: ContextDefaults): ExtensionHostContext => ({
  ...defaults,
  model: undefined,
  scopedModels: [],
  isIdle: () => true,
  isProjectTrusted: () => false,
  signal: undefined,
  abort: ignore,
  hasPendingMessages: () => false,
  shutdown: ignore,
  getContextUsage: () => undefined,
  compact: ignore,
  getSystemPrompt: () => "",
  tools: [],
  executeTool: (name) => Promise.resolve(unavailableToolOutcome(name)),
  getSystemPromptOptions: () => ({ cwd: defaults.cwd }),
  waitForIdle: () => Promise.resolve(),
  newSession: cancelled,
  fork: cancelled,
  navigateTree: cancelled,
  switchSession: cancelled,
  reload: () => Promise.resolve(),
});

export const extensionContextFixture = (
  overrides: ExtensionContextOverrides = {},
): ExtensionHostContext => {
  const descriptors = Object.getOwnPropertyDescriptors(overrides);
  const declaredCwd = descriptors.cwd?.value;
  const declaredMode = descriptors.mode?.value;
  const cwd = Predicate.isString(declaredCwd) ? declaredCwd : FIXTURE_CWD;
  const { ui, sessionManager, modelRegistry } = overrides;
  const context = contextDefaults({
    cwd,
    mode: descriptors.hasUI?.value === true ? "tui" : "print",
    hasUI: declaredMode === "tui" || declaredMode === "rpc",
    ui: extensionUiFixture(ui),
    sessionManager: sessionManagerFixture(sessionManager, cwd),
    modelRegistry: modelRegistryFixture(modelRegistry),
  });
  const flatOverrides = Rec.fromEntries(
    Arr.filter(
      Rec.toEntries<string, PropertyDescriptor>(descriptors),
      ([key]) => !nestedContextKeys.has(key),
    ),
  );
  return Object.defineProperties(context, flatOverrides);
};

export const extensionApiFixture = (overrides: Partial<ExtensionAPI> = {}): ExtensionAPI =>
  overlay<ExtensionAPI>(
    {
      on: () => ignore,
      registerTool: ignore,
      registerCommand: ignore,
      registerShortcut: ignore,
      registerFlag: ignore,
      getFlag: () => undefined,
      registerMessageRenderer: ignore,
      registerMarkdownTransformer: ignore,
      registerEntryRenderer: ignore,
      registerToolRenderer: ignore,
      sendMessage: ignore,
      sendUserMessage: ignore,
      appendEntry: ignore,
      setSessionName: ignore,
      getSessionName: () => undefined,
      setLabel: ignore,
      exec: () =>
        Promise.resolve({
          stdout: "",
          stderr: "Commands are unavailable in this fixture.",
          code: 127,
          killed: false,
        }),
      getActiveTools: () => [],
      getAllTools: () => [],
      getSettings: () => ({}),
      setActiveTools: ignore,
      getCommands: () => [],
      setModel: () => Promise.resolve(false),
      getThinkingLevel: () => "off",
      setThinkingLevel: ignore,
      registerProvider: ignore,
      unregisterProvider: ignore,
      registerMcpServer: ignore,
      unregisterMcpServer: ignore,
      getMcpServers: () => [],
      registerVirtualModel: ignore,
      unregisterVirtualModel: ignore,
      events: createEventBus(),
    },
    overrides,
  );
