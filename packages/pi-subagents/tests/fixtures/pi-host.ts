import type {
  BeforeAgentStartEvent,
  ExtensionUIContext,
  NormalizedBuildSystemPromptOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import {
  extensionContextFixture,
  piKeybindingsFixture,
  type ExtensionContextOverrides,
} from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";

export const sessionContextFixture = (
  overrides: ExtensionContextOverrides = {},
  sessionId?: string,
) =>
  extensionContextFixture({
    cwd: process.cwd(),
    signal: undefined,
    hasUI: false,
    mode: "rpc",
    isProjectTrusted: () => true,
    ...(sessionId !== undefined && {
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    }),
    ...overrides,
  });

export const beforeAgentStartEvent = (
  prompt: string,
  options: Partial<NormalizedBuildSystemPromptOptions> = {},
): BeforeAgentStartEvent => ({
  type: "before_agent_start",
  prompt,
  systemPrompt: "",
  systemPromptOptions: {
    cwd: process.cwd(),
    selectedTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {},
    contextFiles: [],
    skills: [],
    ...options,
  },
});

export const mountingCustomUi = (
  theme: Theme,
  created: (component: Component) => void,
  size: { readonly columns?: number; readonly rows?: number } = {},
) => {
  const host = fakeCustomSurfaceHost({
    ...size,
    theme,
    keybindings: piKeybindingsFixture({
      matches: (data, id) =>
        id === "tui.select.confirm"
          ? matchesKey(data, Key.enter)
          : id === "tui.select.cancel"
            ? matchesKey(data, Key.escape)
            : false,
    }),
  });
  const custom: ExtensionUIContext["custom"] = (factory, options) => {
    const opened = host.ctx.ui.custom((...args: Parameters<typeof factory>) => {
      const component = factory(...args);
      if (!Predicate.isPromiseLike(component)) created(component);
      return component;
    }, options);
    queueMicrotask(host.mount);
    return opened;
  };
  return { host, custom };
};
