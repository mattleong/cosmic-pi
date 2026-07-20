import { type Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach } from "vitest";
import { environmentValue, setEnvironmentValueForTest } from "../boundary/environment";
import { registerToolRenderers } from "./registration";

export type RegisteredRenderer = {
  name: string;
  execute?: (...args: unknown[]) => Promise<unknown>;
  renderCall?: (...args: unknown[]) => Component;
  renderResult?: (...args: unknown[]) => Component;
  renderShell?: "default" | "self";
  prepareArguments?: (args: unknown) => unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
};

export function preserveCodePreviewToolsEnv(): void {
  let previousCodePreviewTools: string | undefined;

  beforeEach(() => {
    previousCodePreviewTools = environmentValue("CODE_PREVIEW_TOOLS");
  });

  afterEach(() => {
    setEnvironmentValueForTest("CODE_PREVIEW_TOOLS", previousCodePreviewTools);
  });
}

export function registerRenderers(cwd = "/tmp/project"): RegisteredRenderer[] {
  const registered: RegisteredRenderer[] = [];
  registerToolRenderers(
    { registerTool: (tool: unknown) => registered.push(tool as RegisteredRenderer) } as never,
    cwd,
  );
  return registered;
}

export function findRenderer<T extends RegisteredRenderer = RegisteredRenderer>(
  registered: RegisteredRenderer[],
  name: string,
): T {
  const tool = registered.find((candidate) => candidate.name === name);
  if (!tool) throw new TypeError(`Expected ${name} renderer to be registered`);
  return tool as T;
}
