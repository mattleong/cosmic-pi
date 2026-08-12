/**
 * The single import door for the private, vendored Code Mode runtime.
 *
 * The runtime is a private workspace package nested at `packages/pi-code-mode/runtime` and its
 * built output (`runtime/dist/`) ships inside the published `pi-code-mode` tarball. It is
 * imported here by relative path — never by package name — because a private package can never
 * be resolved from a registry by consumers, and because the relative import guarantees the
 * runtime shares this package's single `effect` instance. Every other module in this package
 * must import the runtime through this door.
 */
export { CodeMode, Tool, ToolError, toolError } from "../../runtime/dist/index.js";
