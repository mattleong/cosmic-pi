import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type * as Schema from "effect/Schema";
import { renderContextFixture } from "../../testing";
import type { CompactAnimationScheduler } from "../../src/tools/compact-summary";
import { nativeArgumentPreview } from "../../src/tools/native-codemode-args";
import type { NativeCodemodeCall } from "../../src/tools/native-codemode-evidence";
import { createNativeCodemodeRenderers } from "../../src/tools/native-codemode-render";
import { nativeCodemodeCallSubject } from "../../src/tools/native-codemode-subject";
import { nativeCodemodeSummary } from "../../src/tools/native-codemode-summary";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

export const nativeReceipt = (args: Schema.JsonObject): string => {
  const json = JSON.stringify(args);
  return json.length > 200 ? `${Fn.pipe(json, Str.slice(0, 197))}...` : json;
};

export const codemodeSubject = (name: string, args?: Schema.JsonObject) =>
  nativeCodemodeCallSubject(name, args && nativeArgumentPreview(nativeReceipt(args)), "/project");

export const nativeCall = (
  overrides: Partial<Omit<NativeCodemodeCall, "status">> & { readonly status?: string } = {},
) => ({
  id: "private/1",
  name: "read",
  args: '{"path":"/project/a.ts"}',
  status: "ok",
  ...overrides,
});

export const scriptResult = <Details>(
  state: string,
  details: Details,
  ...output: AgentToolResult<unknown>["content"]
): AgentToolResult<Details> => ({
  content: [{ type: "text", text: `Script ${state}\nWall time 0.1 seconds\nOutput:\n` }, ...output],
  details,
});

export const settledSummary = (
  result: AgentToolResult<unknown>,
  { code = "", isError = false }: { readonly code?: string; readonly isError?: boolean } = {},
) =>
  nativeCodemodeSummary("/project")({
    phase: "settled",
    args: { code },
    result,
    context: renderContextFixture({ isError }),
  });

export const codemodeRenderers = (scheduleAnimation: CompactAnimationScheduler = () => undefined) =>
  createNativeCodemodeRenderers("/project", { scheduleAnimation });
