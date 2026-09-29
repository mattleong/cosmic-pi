import * as Pi from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";

/**
 * Compose a fresh public native factory with this extension's API. Never retrieve, mutate,
 * or wrap a definition belonging to the loaded builtin or another extension.
 * Namespace lookup keeps older Pi peers without this optional factory loadable.
 */
type NativeParameters = { type: "object"; properties: { code: { type: "string" } } };
export type NativeCodemodeDefinition = ToolDefinition<NativeParameters, unknown>;

export function captureFreshNativeCodemode(pi: ExtensionAPI): NativeCodemodeDefinition | undefined {
  if (!Predicate.isFunction(Pi.createCodemodeExtension)) return undefined;
  let captured: ToolDefinition<any, any, any> | undefined;
  const adapter: ExtensionAPI = {
    ...pi,
    registerTool(definition) {
      if (definition.name !== "codemode" || captured)
        throw new Error("Unexpected native codemode registration");
      captured = definition;
    },
  };
  const result = Pi.createCodemodeExtension()(adapter);
  // The public native factory registers synchronously. Do not admit a changed async contract.
  if (result) throw new Error("Asynchronous native codemode registration is unsupported");
  if (!captured) throw new Error("Native codemode did not register a definition");
  // SAFETY: The public native factory owns this code-only parameter schema; the adapter
  // captures its fresh definition without rebuilding or replacing that schema object.
  return captured as NativeCodemodeDefinition;
}
