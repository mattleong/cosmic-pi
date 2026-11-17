import type { EventBus, ToolRenderers } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { ForeignCallable } from "pi-cosmic-core/schema/foreign-callable";
import { rendererFields } from "./renderer-row";

/**
 * Pi resolves a tool's renderers only for rows it draws itself. A surface that draws another
 * conversation's tool calls, such as a subagent's transcript, asks the live presentation owners
 * of this Pi process instead: Code Previews for the tools it previews, and each cooperating
 * extension's replay bridge for the tools it registered.
 */
const TOOL_RENDERER_LOOKUP = "code-previews:tool-renderers:lookup:v1";
const MAX_TOOL_NAME_CHARS = 256;

const LookupSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TOOL_NAME_CHARS)),
  offer: ForeignCallable<[renderers: ToolRenderers]>(),
});
const decodeLookup = decodeUnknownOrUndefined(LookupSchema);

/**
 * Answers lookups with the renderers this owner draws `name` with, or stays silent. The answer
 * never executes a tool or changes activation, and a retired owner must return `undefined`.
 * Returns the unsubscribe.
 */
export function answerToolRendererLookups(
  events: Pick<EventBus, "on">,
  renderers: (name: string) => ToolRenderers | undefined,
): () => void {
  return events.on(TOOL_RENDERER_LOOKUP, (data) => {
    const lookup = decodeLookup(data);
    if (!lookup) return;
    const found = invokeHostCallback(() => renderers(lookup.name), undefined);
    if (found) invokeHostCallback(() => lookup.offer(found), undefined);
  });
}

/**
 * The renderers a live owner in this Pi process draws `name` with, or `undefined` when none
 * answers, such as for another extension's tool that doesn't use the shell. The first answer
 * wins; owners answer for disjoint tools.
 */
export function lookupToolRenderers(
  events: Pick<EventBus, "emit">,
  name: string,
): ToolRenderers | undefined {
  let found: ToolRenderers | undefined;
  invokeHostCallback(
    () =>
      events.emit(TOOL_RENDERER_LOOKUP, {
        name,
        offer: (renderers: ToolRenderers) => {
          found ??= rendererFields(renderers);
        },
      }),
    undefined,
  );
  return found;
}
