import type {
  GeneratorReturn,
  InterpreterRuntimeError,
  ProgramThrow,
} from "./interpreter/model.js";
import type { ToolError } from "./tool-error.js";
import type { ToolRuntimeError } from "./tool-runtime.js";

/**
 * Closed failure channel for the confined runtime.
 *
 * Every typed failure a CodeMode execution can raise is one of these classes; host tool
 * failures are normalized to `ToolError` at the host boundary (see `runHost`), so no
 * `unknown` error ever travels through the interpreter's Effect channels. Executions still
 * surface program failures as `Result` data - `executeWithLimits` converts this channel
 * (and any defect) into a `Diagnostic` before returning.
 */
export type RuntimeFailure =
  | InterpreterRuntimeError
  | ProgramThrow
  | GeneratorReturn
  | ToolRuntimeError
  | ToolError;
