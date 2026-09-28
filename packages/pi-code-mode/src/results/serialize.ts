import * as Predicate from "effect/Predicate";
import type { CodeModeResult } from "../engine/diagnostic.ts";
import { completedCallHeading } from "../engine/output.ts";
import { codeModeDiagnosticMessage, COMPLETED_CALLS_HEADING } from "../tools/format.ts";
import { RESULT_MAX_BYTES, RESULT_MAX_VISITS, type ResultCapture } from "./model.ts";

/** Bounded traversal over validated plain data. Never keeps the guest graph or invokes toJSON. */
export function captureResult(result: CodeModeResult): ResultCapture {
  const parts: string[] = [];
  let bytes = 0;
  let visits = 0;
  const append = (text: string) => {
    if (text.length > RESULT_MAX_BYTES) throw new RangeError("capture-limit");
    bytes += new TextEncoder().encode(text).length;
    if (bytes > RESULT_MAX_BYTES) throw new RangeError("capture-limit");
    parts.push(text);
  };
  const quote = (text: string) => {
    if (text.length > RESULT_MAX_BYTES) throw new RangeError("capture-limit");
    append(JSON.stringify(text));
  };
  const visit = <Value>(value: Value, depth: number): void => {
    if (++visits > RESULT_MAX_VISITS || depth > 32) throw new RangeError("capture-limit");
    if (value === null) return append("null");
    if (Predicate.isString(value)) return quote(value);
    if (Predicate.isNumber(value) || Predicate.isBoolean(value))
      return append(JSON.stringify(value));
    if (Array.isArray(value)) {
      append("[");
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Predicate.isNumber(length) || length > RESULT_MAX_VISITS)
        throw new RangeError("capture-limit");
      for (let i = 0; i < length; i++) {
        if (i > 0) append(",");
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (descriptor !== undefined && !("value" in descriptor))
          throw new RangeError("capture-limit");
        visit(descriptor === undefined ? null : descriptor.value, depth + 1);
      }
      return append("]");
    }
    if (!Predicate.isObjectOrArray(value)) throw new RangeError("capture-limit");
    append("{");
    let first = true;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (!first) append(",");
      first = false;
      quote(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor))
        throw new RangeError("capture-limit");
      append(":");
      visit(descriptor.value, depth + 1);
    }
    append("}");
  };
  try {
    if (result.ok) {
      if (Predicate.isString(result.value)) append(result.value);
      else visit(result.value, 0);
    } else {
      const { error } = result;
      append(`[${error.kind}]`);
      if (error.location) append(` (line ${error.location.line}, column ${error.location.column})`);
      const message = codeModeDiagnosticMessage(error);
      append(` ${message}`);
      for (const hint of error.suggestions ?? []) {
        if (++visits > RESULT_MAX_VISITS) throw new RangeError("capture-limit");
        if (!message.includes(hint)) append(`\n${hint}`);
      }
    }
    if (result.logs?.length) {
      if (bytes > 0) append("\n\n");
      append("Logs:\n");
      for (let index = 0; index < result.logs.length; index++) {
        if (++visits > RESULT_MAX_VISITS) throw new RangeError("capture-limit");
        if (index > 0) append("\n");
        append(result.logs[index]!);
      }
    }
    if (!result.ok && result.completed?.length) {
      if (bytes > 0) append("\n\n");
      append(COMPLETED_CALLS_HEADING);
      for (const call of result.completed) {
        if (++visits > RESULT_MAX_VISITS) throw new RangeError("capture-limit");
        append(`\n${completedCallHeading(call)}\n`);
        append(call.text);
      }
    }
    return { status: "captured", text: parts.join("") };
  } catch {
    return { status: "unavailable", reason: "capture-limit" };
  }
}
