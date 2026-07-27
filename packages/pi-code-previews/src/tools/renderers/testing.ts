import { type Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach } from "vitest";
import {
  codePreviewPerformanceConfig,
  codePreviewToolsEnvironmentValue,
  publishCodePreviewEnvironmentProjection,
} from "../../config/env";
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

/** Publishes only the tools portion of the synchronous environment projection for tests. */
export function publishCodePreviewToolsEnvironment(value: string | undefined): void {
  publishCodePreviewEnvironmentProjection(codePreviewPerformanceConfig, value);
}

export function preserveCodePreviewToolsEnv(): void {
  let previousCodePreviewTools: string | undefined;

  beforeEach(() => {
    previousCodePreviewTools = codePreviewToolsEnvironmentValue;
  });

  afterEach(() => {
    publishCodePreviewToolsEnvironment(previousCodePreviewTools);
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
