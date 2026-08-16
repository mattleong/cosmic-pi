import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach } from "vitest";
import {
  codePreviewPerformanceConfig,
  codePreviewToolsEnvironmentValue,
  publishCodePreviewEnvironmentProjection,
} from "../../config/env";
import { registerToolRenderers } from "./registration";

type NativeRenderer = ToolDefinition<any, any, any>;
type NativeRenderCall = NonNullable<NativeRenderer["renderCall"]>;
type NativeRenderResult = NonNullable<NativeRenderer["renderResult"]>;
type TestToolResult = {
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
    readonly data?: string;
    readonly mimeType?: string;
  }>;
  readonly details?: unknown;
};
type TestRenderContext = {
  readonly args?: unknown;
  readonly toolCallId?: string;
  readonly invalidate?: () => void;
  readonly state?: object;
  readonly cwd?: string;
  readonly executionStarted?: boolean;
  readonly argsComplete?: boolean;
  readonly isPartial?: boolean;
  readonly expanded?: boolean;
  readonly showImages?: boolean;
  readonly isError?: boolean;
};

export type RegisteredRenderer = Omit<NativeRenderer, "renderCall" | "renderResult"> & {
  readonly renderCall?: (
    args: Parameters<NativeRenderCall>[0],
    theme: Parameters<NativeRenderCall>[1],
    context?: TestRenderContext,
  ) => ReturnType<NativeRenderCall>;
  readonly renderResult?: (
    result: TestToolResult,
    options: Parameters<NativeRenderResult>[1],
    theme: Parameters<NativeRenderResult>[2],
    context?: TestRenderContext,
  ) => ReturnType<NativeRenderResult>;
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
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  registerToolRenderers(
    {
      registerTool: <Tool>(tool: Tool) => {
        // SAFETY: Tests invoke registered renderers with host-equivalent content fixtures.
        registered.push(tool as Tool & RegisteredRenderer);
      },
    } as never,
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
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  return tool as T;
}
