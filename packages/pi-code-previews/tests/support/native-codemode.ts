import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type * as Schema from "effect/Schema";
import { renderContextFixture } from "../../testing";
import type { CompactAnimationScheduler } from "../../src/tools/compact-summary";
import { nativeArgumentPreview } from "../../src/tools/native-codemode-args";
import type { NativeCodemodeCall } from "../../src/tools/native-codemode-evidence";
import { createNativeCodemodeRenderers } from "../../src/tools/native-codemode-render";
import { nativeCodemodeCallSubject } from "../../src/tools/native-codemode-subject";
import { nativeCodemodeSummary } from "../../src/tools/native-codemode-summary";

/** Pi's argument receipt for a nested call: its JSON, cut to 197 code units and `...` past 200. */
export const nativeReceipt = (args: Schema.JsonObject): string => {
  const json = JSON.stringify(args);
  return json.length > 200 ? `${json.slice(0, 197)}...` : json;
};

/** The row target native codemode derives from a call's receipt, or from no receipt at all. */
export const codemodeSubject = (name: string, args?: Schema.JsonObject) =>
  nativeCodemodeCallSubject(name, args && nativeArgumentPreview(nativeReceipt(args)), "/project");

/** One native call record, with any status: a successful read of /project/a.ts unless overridden. */
export const nativeCall = (
  overrides: Partial<Omit<NativeCodemodeCall, "status">> & { readonly status?: string } = {},
) => ({
  id: "private/1",
  name: "read",
  args: '{"path":"/project/a.ts"}',
  status: "ok",
  ...overrides,
});

/** A finished script: Pi's status header, then the script's output parts. */
export const scriptResult = <Details>(
  state: string,
  details: Details,
  ...output: AgentToolResult<unknown>["content"]
): AgentToolResult<Details> => ({
  content: [{ type: "text", text: `Script ${state}\nWall time 0.1 seconds\nOutput:\n` }, ...output],
  details,
});

/** The settled projection the renderer computes; only `isError` of the context is read. */
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

/** Native codemode presentation for /project, animated only by the given scheduler. */
export const codemodeRenderers = (scheduleAnimation: CompactAnimationScheduler = () => undefined) =>
  createNativeCodemodeRenderers("/project", { scheduleAnimation });
