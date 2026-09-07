/** Safe, bounded visual-SGR preservation for arbitrarily chunked terminal streams. */

const SAFE_SGR_PARAMETERS = /^[0-9;]*$/u;
const MAX_SAFE_SGR_PARAMETER_LENGTH = 128;
const MAX_PRESERVED_SGR_SEQUENCES_PER_LINE = 256;
const MAX_PRESERVED_SGR_BYTES_PER_LINE = 4_096;
const TERMINAL_STRING_INTRODUCERS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);

export interface TerminalStyledFragment<Channel extends string = string> {
  readonly channel: Channel;
  readonly text: string;
}

export interface SanitizedTerminalStyledFragment<
  Channel extends string = string,
> extends TerminalStyledFragment<Channel> {
  /** Compact safe SGR state active before this fragment, for reopening after another channel. */
  readonly reopenSgr: string;
}

type TerminalParserMode =
  | "text"
  | "escape"
  | "escape-intermediate"
  | "csi"
  | "terminal-string"
  | "terminal-string-escape";

interface SgrState {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strikethrough: boolean;
  foreground?: string;
  background?: string;
}

interface StyledChannelState {
  mode: TerminalParserMode;
  csi: string;
  csiInvalid: boolean;
  sgr: SgrState;
  lineSequences: number;
  lineBytes: number;
  lineBudgetExhausted: boolean;
}

const emptySgrState = (): SgrState => ({
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strikethrough: false,
});

const emptyStyledChannelState = (): StyledChannelState => ({
  mode: "text",
  csi: "",
  csiInvalid: false,
  sgr: emptySgrState(),
  lineSequences: 0,
  lineBytes: 0,
  lineBudgetExhausted: false,
});

const resetSgrState = (state: SgrState): void => {
  Object.assign(state, emptySgrState());
  delete state.foreground;
  delete state.background;
};

const sgrStatePrefix = (state: SgrState): string => {
  const parameters = [
    state.bold ? "1" : undefined,
    state.dim ? "2" : undefined,
    state.italic ? "3" : undefined,
    state.underline ? "4" : undefined,
    state.inverse ? "7" : undefined,
    state.strikethrough ? "9" : undefined,
    state.foreground,
    state.background,
  ].filter((parameter): parameter is string => parameter !== undefined);
  return parameters.length === 0 ? "" : `\u001b[${parameters.join(";")}m`;
};

const SIMPLE_SAFE_SGR = new Set([
  0,
  1,
  2,
  3,
  4,
  7,
  9,
  21,
  22,
  23,
  24,
  27,
  29,
  39,
  49,
  ...Array.from({ length: 8 }, (_, index) => 30 + index),
  ...Array.from({ length: 8 }, (_, index) => 40 + index),
  ...Array.from({ length: 8 }, (_, index) => 90 + index),
  ...Array.from({ length: 8 }, (_, index) => 100 + index),
]);

const parseSafeSgr = (parameters: string): ReadonlyArray<number> | undefined => {
  if (parameters.length > MAX_SAFE_SGR_PARAMETER_LENGTH || !SAFE_SGR_PARAMETERS.test(parameters))
    return undefined;
  const values = (parameters.length === 0 ? [""] : parameters.split(";")).map((part) =>
    part.length === 0 ? 0 : Number(part),
  );
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  for (let index = 0; index < values.length; index += 1) {
    const code = values[index] ?? -1;
    if (code !== 38 && code !== 48) {
      if (!SIMPLE_SAFE_SGR.has(code)) return undefined;
      continue;
    }
    const mode = values[index + 1];
    if (mode === 5) {
      const color = values[index + 2];
      if (color === undefined || color > 255) return undefined;
      index += 2;
      continue;
    }
    if (mode === 2) {
      const colors = values.slice(index + 2, index + 5);
      if (colors.length !== 3 || colors.some((color) => color > 255)) return undefined;
      index += 4;
      continue;
    }
    return undefined;
  }
  return values;
};

const applySafeSgr = (state: SgrState, values: ReadonlyArray<number>): void => {
  for (let index = 0; index < values.length; index += 1) {
    const code = values[index] ?? 0;
    if (code === 0) resetSgrState(state);
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 9) state.strikethrough = true;
    else if (code === 21) state.bold = false;
    else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code === 29) state.strikethrough = false;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))
      state.foreground = String(code);
    else if (code === 39) delete state.foreground;
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))
      state.background = String(code);
    else if (code === 49) delete state.background;
    else if (code === 38 || code === 48) {
      const count = values[index + 1] === 5 ? 3 : 5;
      const color = values.slice(index, index + count).join(";");
      if (code === 38) state.foreground = color;
      else state.background = color;
      index += count - 1;
    }
  }
};

const resetStyledLineBudget = (state: StyledChannelState): void => {
  state.lineSequences = 0;
  state.lineBytes = 0;
  state.lineBudgetExhausted = false;
};

/**
 * Sanitize arbitrarily chunked, interleaved terminal streams in one linear pass. Parser, SGR,
 * and per-line traffic budgets are independent per channel; unfinished controls remain
 * fail-closed when the input ends. Returned text contains only printable content and strict,
 * bounded visual SGR sequences.
 */
export function sanitizeTerminalStyledFragments<Channel extends string>(
  fragments: ReadonlyArray<TerminalStyledFragment<Channel>>,
): ReadonlyArray<SanitizedTerminalStyledFragment<Channel>> {
  const states = new Map<Channel, StyledChannelState>();
  return fragments.map((fragment) => {
    const state = states.get(fragment.channel) ?? emptyStyledChannelState();
    states.set(fragment.channel, state);
    const reopenSgr = sgrStatePrefix(state.sgr);
    let output = "";
    const emitSgr = (parameters: string): void => {
      const values = parseSafeSgr(parameters);
      if (values === undefined || state.lineBudgetExhausted) return;
      // Canonical numeric parameters keep downstream ANSI trackers aligned with our state;
      // omitted fields (`ESC[;m`) are reset codes and become `0;0`.
      const sequence = `\u001b[${values.join(";")}m`;
      if (
        state.lineSequences >= MAX_PRESERVED_SGR_SEQUENCES_PER_LINE ||
        state.lineBytes + sequence.length > MAX_PRESERVED_SGR_BYTES_PER_LINE
      ) {
        output += "\u001b[0m";
        resetSgrState(state.sgr);
        state.lineBudgetExhausted = true;
        return;
      }
      output += sequence;
      state.lineSequences += 1;
      state.lineBytes += sequence.length;
      applySafeSgr(state.sgr, values);
    };
    const emitText = (character: string, code: number): void => {
      if (character === "\n") {
        output += character;
        resetStyledLineBudget(state);
      } else if (character === "\t") output += "   ";
      else if (code >= 32 && code !== 127 && !(code >= 0x80 && code <= 0x9f)) output += character;
    };
    const processText = (character: string, code: number): void => {
      if (code === 0x1b) state.mode = "escape";
      else if (code === 0x9b) {
        state.mode = "csi";
        state.csi = "";
        state.csiInvalid = false;
      } else if (TERMINAL_STRING_INTRODUCERS.has(code)) state.mode = "terminal-string";
      else emitText(character, code);
    };

    for (const character of fragment.text) {
      const code = character.charCodeAt(0);
      if (state.mode === "text") {
        processText(character, code);
        continue;
      }
      if (state.mode === "terminal-string") {
        if (code === 0x07 || code === 0x9c) state.mode = "text";
        else if (code === 0x1b) state.mode = "terminal-string-escape";
        continue;
      }
      if (state.mode === "terminal-string-escape") {
        if (character === "\\" || code === 0x9c) state.mode = "text";
        else if (code !== 0x1b) state.mode = "terminal-string";
        continue;
      }
      if (state.mode === "escape") {
        if (character === "[") {
          state.mode = "csi";
          state.csi = "";
          state.csiInvalid = false;
        } else if (["]", "P", "X", "^", "_"].includes(character)) state.mode = "terminal-string";
        else if (code >= 0x20 && code <= 0x2f) state.mode = "escape-intermediate";
        else if (code >= 0x30 && code <= 0x7e) state.mode = "text";
        else {
          state.mode = "text";
          processText(character, code);
        }
        continue;
      }
      if (state.mode === "escape-intermediate") {
        if (code >= 0x20 && code <= 0x2f) continue;
        state.mode = "text";
        if (code < 0x30 || code > 0x7e) processText(character, code);
        continue;
      }
      // CSI: collect only parameter/intermediate bytes until one final byte arrives. A nested
      // introducer abandons the malformed CSI and is immediately processed as a new control.
      if (code >= 0x40 && code <= 0x7e) {
        if (character === "m" && !state.csiInvalid) emitSgr(state.csi);
        state.mode = "text";
      } else if (code === 0x1b || TERMINAL_STRING_INTRODUCERS.has(code) || code === 0x9b) {
        state.mode = "text";
        processText(character, code);
      } else if (state.csi.length < MAX_SAFE_SGR_PARAMETER_LENGTH) state.csi += character;
      else state.csiInvalid = true;
    }
    return { channel: fragment.channel, text: output, reopenSgr };
  });
}

/**
 * Remove terminal controls except bounded, allowlisted SGR colors/styles.
 * Cursor motion, screen erasure, hyperlinks, clipboard controls, and terminal strings are stripped.
 */
export function sanitizeTerminalStyledText(value: string): string {
  return sanitizeTerminalStyledFragments([{ channel: "text", text: value }])[0]?.text ?? "";
}
