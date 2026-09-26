/** Pure host-side Code Mode limits: program source bytes and cumulative nested output bytes. */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** Exact UTF-8 byte length of one string, matching the runtime's own output accounting. */
export const utf8ByteLength = (value: string): number => encoder.encode(value).byteLength;

/**
 * Cut encoded bytes before a partial sequence, preserving genuine U+FFFD characters.
 * Non-streaming decoding leaves no state behind for the next call.
 */
const utf8Truncate = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.floor(maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
};

/**
 * The single final clamp over the entire model-visible `code_mode` text, applied to both the
 * success string and the thrown-failure string after all extension composition (diagnostic
 * kind/location/suggestions, logs, separators, and any runtime truncation markers) has
 * happened. It is the last bound the model sees:
 *
 * - the returned byte length is always `<= maxOutputBytes`;
 * - `maxOutputBytes === 0` yields the empty string;
 * - text already within budget is returned unchanged (exact fit admitted);
 * - oversized text is truncated code-point-safely, with a byte-accounted marker reserved
 *   *inside* the budget (and omitted when even the bare marker cannot fit).
 *
 * This runs on top of the runtime's own `maxOutputBytes` bound: the runtime keeps the guest
 * result/logs within budget, and this clamp additionally bounds the extension chrome the
 * runtime never sees, so a hostile program cannot leak an oversized message through the
 * `[kind] … Logs:` framing or a large thrown Error.
 */
export const clampModelVisibleText = (text: string, maxOutputBytes: number): string => {
  if (maxOutputBytes <= 0) return "";
  const totalBytes = utf8ByteLength(text);
  if (totalBytes <= maxOutputBytes) return text;
  const marker = ` …[output truncated: ${totalBytes} bytes exceeds the ${maxOutputBytes}-byte limit]`;
  const markerBytes = utf8ByteLength(marker);
  if (markerBytes >= maxOutputBytes) return utf8Truncate(text, maxOutputBytes);
  return `${utf8Truncate(text, maxOutputBytes - markerBytes)}${marker}`;
};

type CumulativeOutputAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly message: string };

export interface CumulativeOutputBudget {
  /**
   * Admits or refuses one nested tool result. The check and the consumption are one
   * synchronous step, so parallel nested calls (fixed runtime concurrency 8) can never
   * interleave between them. An exact fit is admitted; the first overrun is refused with a
   * deterministic, model-safe message and consumes nothing.
   */
  readonly admit: (guestData: string) => CumulativeOutputAdmission;
  /**
   * Bounds and consumes guest-visible nested failure text from the same cumulative budget.
   * When only part of the budget remains, the returned text is code-point-safe truncated to
   * that remainder; an exhausted budget yields an empty safe failure message.
   */
  readonly admitFailure: (message: string) => string;
  readonly remaining: () => number;
}

/**
 * Cumulative UTF-8 byte budget over the exact plain text handed to the guest program.
 * Each nested result is counted exactly once, at admission.
 */
export const makeCumulativeOutputBudget = (limitBytes: number): CumulativeOutputBudget => {
  let used = 0;
  return {
    admit: (guestData) => {
      const bytes = utf8ByteLength(guestData);
      if (used + bytes > limitBytes) {
        return {
          admitted: false,
          message:
            `Nested tool output refused: admitting ${bytes} bytes would exceed the cumulative ` +
            `nested-output budget (${used} of ${limitBytes} bytes already used). ` +
            "The operation may already have completed. Inspect retained results or affected state; do not replay mutations to recover output.",
        };
      }
      used += bytes;
      return { admitted: true };
    },
    admitFailure: (message) => {
      const remaining = Math.max(0, limitBytes - used);
      const admitted = utf8Truncate(message, remaining);
      used += utf8ByteLength(admitted);
      return admitted;
    },
    remaining: () => Math.max(0, limitBytes - used),
  };
};

/**
 * Pre-execution program source budget in exact UTF-8 bytes; an exact fit is accepted.
 * Returns the model-safe refusal message, or undefined when the source is within budget.
 */
export const checkSourceSize = (code: string, maxSourceBytes: number): string | undefined => {
  const bytes = utf8ByteLength(code);
  if (bytes <= maxSourceBytes) return undefined;
  return (
    `Program source is ${bytes} UTF-8 bytes, which exceeds the configured ` +
    `maxSourceBytes limit of ${maxSourceBytes}. Send a smaller program.`
  );
};
