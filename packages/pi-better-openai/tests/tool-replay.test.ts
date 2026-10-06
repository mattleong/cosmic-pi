// Pi draws history before session_start: on /reload and session replacement the factory has run,
// but the image tool registers only after trusted preview settings load.
import type {
  ExtensionAPI,
  ExtensionHandler,
  SourceInfo,
  ToolDefinition,
  ToolRenderers,
  ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Image, type Component } from "@earendil-works/pi-tui";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { applyPresentationSettings, createToolPresentationHarness } from "pi-code-previews/testing";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import {
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
  plainTheme as theme,
} from "pi-cosmic-core/testing";
import { afterEach, vi } from "vitest";
import { betterOpenAIWithDependencies } from "../src/extension.ts";
import { OPENAI_IMAGE_TOOL } from "../src/image/register.ts";

type Handler = ExtensionHandler<any, any>;
type MessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];

afterEach(() => {
  vi.unstubAllEnvs();
});

const styles = ["compact", "preview"] as const;
const ownerSource: SourceInfo = {
  source: "local",
  path: "/extensions/pi-better-openai/index.ts",
  scope: "user",
  origin: "top-level",
};
const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
const text = (value: string) => ({ type: "text" as const, text: value });
const PROVIDER_TEXT = "PROVIDER_EVIDENCE recovery notes";
const details = {
  id: "image-identity",
  status: "completed",
  prompt: "A watercolor otter PROMPT_END",
  revisedPrompt: "REVISED_EVIDENCE soft watercolor otter",
  mimeType: image.mimeType,
  model: "model",
  action: "generate" as const,
  outputFormat: "png" as const,
};
const images = (component: Component): number =>
  component instanceof Image
    ? 1
    : component instanceof Container || component instanceof Box
      ? component.children.reduce((count, child) => count + images(child), 0)
      : 0;

/** The actual factory under a host whose public tool/command metadata names `toolSource`. */
const harness = (toolSource: SourceInfo = ownerSource) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "openai-replay-" });
    const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "openai-replay-agent-" });
    yield* fs.makeDirectory(path.join(cwd, ".pi", "extensions"), { recursive: true });
    yield* fs.writeFileString(
      path.join(cwd, ".pi", "extensions", "pi-better-openai.json"),
      '{"persistState":false,"usage":{},"image":{"enabled":false}}',
    );
    yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", agentDir));
    const handlers = new Map<string, Handler[]>();
    const commands = new Set<string>();
    const tools: ToolDefinition<any, any, any>[] = [];
    const resolvers: ToolRendererResolver[] = [];
    const messageRenderers = new Map<string, MessageRenderer>();
    const pi = extensionApiFixture({
      on(name: string, handler: Handler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerCommand(name: string) {
        commands.add(name);
      },
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => false),
      getThinkingLevel: vi.fn(() => "off"),
      registerTool(tool: ToolDefinition<any, any, any>) {
        tools.push(tool);
      },
      registerToolRenderer(resolver: ToolRendererResolver) {
        resolvers.push(resolver);
      },
      registerMessageRenderer(customType: string, render: MessageRenderer) {
        messageRenderers.set(customType, render);
      },
      getAllTools: () =>
        tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          exposure: "direct" as const,
          sourceInfo: toolSource,
        })),
      getCommands: () =>
        [...commands].map((name) => ({
          name,
          source: "extension" as const,
          sourceInfo: ownerSource,
        })),
      sendMessage: vi.fn(),
      events: { emit: vi.fn(), on: vi.fn() },
    });
    const ctx = extensionContextFixture({
      cwd,
      mode: "rpc",
      hasUI: true,
      model: { provider: "openai", id: "gpt-5.5" },
      modelRegistry: {
        isUsingOAuth: () => true,
        getProviderAuth: () => Promise.resolve(undefined),
      },
      ui: { notify: vi.fn(), setStatus: vi.fn(), setFooter: vi.fn() },
      sessionManager: {
        getEntries: () => [],
        getBranch: () => [],
        buildContextEntries: () => [],
        getLeafId: () => null,
        getCwd: () => cwd,
        getSessionName: () => undefined,
      },
      getContextUsage: () => ({ contextWindow: 100, percent: 1 }),
      getSystemPrompt: () => "system",
      isProjectTrusted: vi.fn(() => true),
    });
    // The applied presentation settings stand in for the trusted settings startup loads.
    betterOpenAIWithDependencies(pi, { loadPreviewSettings: () => Promise.resolve() });
    const emit = (name: string): Effect.Effect<void> =>
      Effect.forEach(
        handlers.get(name) ?? [],
        (handler) => Effect.promise(() => Promise.resolve(handler({}, ctx))),
        { discard: true },
      );
    /** Pi's resolver chain, ending at the registered definition (none before startup). */
    const resolveToolRenderers = (name: string): ToolRenderers | undefined => {
      const step = (index: number): ToolRenderers | undefined =>
        index < resolvers.length
          ? resolvers[index]!(name, () => step(index + 1))
          : tools.find((tool) => tool.name === name);
      return step(0);
    };
    return { cwd, tools, messageRenderers, resolveToolRenderers, emit };
  });

const presentation = (style: (typeof styles)[number]) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false }),
    ),
    (restore) => Effect.sync(restore),
  );

layer(nodeFilePlatformLayer)("Better OpenAI history before session_start", (it) => {
  for (const style of styles)
    for (const owner of ["owned", "foreign"] as const)
      it.effect(`the same cold ${style} image row adopts only its own tool (${owner})`, () =>
        Effect.gen(function* () {
          yield* presentation(style);
          const h = yield* harness(
            owner === "owned" ? ownerSource : { ...ownerSource, path: "/extensions/foreign.ts" },
          );
          const cold = h.resolveToolRenderers(OPENAI_IMAGE_TOOL);
          expect(cold).toBeDefined();
          const row = createToolPresentationHarness(cold!, { theme, width: 240 });
          const args = { prompt: details.prompt };
          const result = { details, content: [text(PROVIDER_TEXT), image] };
          const before = structuredClone(result);
          row.call(args);
          row.result(result);
          // Before startup the row keeps raw evidence only.
          expect(row.render().join("\n")).toContain(PROVIDER_TEXT);

          yield* h.emit("session_start");
          expect(h.tools.map((tool) => tool.name)).toEqual([OPENAI_IMAGE_TOOL]);
          for (const { expanded, text } of row.cycle(args, result)) {
            expect(text).not.toContain(image.data);
            if (expanded) {
              expect(text).toContain(PROVIDER_TEXT);
              if (owner === "owned") expect(text).toContain(details.revisedPrompt);
            } else {
              // Owned presentation keeps provider text for expansion; raw fallback always shows it.
              expect(text.includes(PROVIDER_TEXT)).toBe(owner === "foreign");
            }
          }
          expect(result).toEqual(before);
          yield* h.emit("session_shutdown");
        }),
      );

  for (const style of styles)
    it.effect(
      `image messages render before session_start with native and legacy images (${style})`,
      () =>
        Effect.gen(function* () {
          yield* presentation(style);
          const h = yield* harness();
          const savedPath = `${h.cwd}/.pi/generated-images/otter.png`;
          const record = { ...details, savedPath };
          // Pi looks the renderer up whenever it draws a message, including reloaded history.
          const render = (message: { readonly content: unknown; readonly details: unknown }) => {
            const renderer = h.messageRenderers.get("openai-image");
            expect(renderer).toBeDefined();
            return renderer!(
              opaqueFixture({
                role: "custom",
                customType: "openai-image",
                display: true,
                ...message,
              }),
              { expanded: true, outputPad: 0 },
              theme,
            )!;
          };
          const expectImages = () => {
            for (const message of [
              { content: [text(PROVIDER_TEXT), image], details: record },
              { content: "", details: { ...record, data: image.data } },
            ]) {
              const component = render(message);
              expect(images(component)).toBe(1);
              expect(component.render(400).join("\n")).toContain(details.revisedPrompt);
            }
          };
          // Without an image component the saved path is the only cwd-dependent text.
          const savedPathShown = () =>
            render({ content: [text(PROVIDER_TEXT)], details: record })
              .render(400)
              .join("\n");

          expectImages();
          // A temp directory under HOME may already be abbreviated with ~/ before startup.
          const beforeStartup = savedPathShown();
          expect(beforeStartup).toContain(".pi/generated-images/otter.png");
          yield* h.emit("session_start");
          expectImages();
          expect(savedPathShown()).toContain(".pi/generated-images/otter.png");
          expect(savedPathShown()).not.toEqual(beforeStartup);
          expect(savedPathShown()).not.toContain(h.cwd);
          yield* h.emit("session_shutdown");
        }),
    );
});
