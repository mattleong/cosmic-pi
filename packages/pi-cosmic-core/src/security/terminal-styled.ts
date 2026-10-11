const SAFE_SGR_PARAMETERS = /^[0-9;]*$/u;
const MAX_SAFE_SGR_PARAMETER_LENGTH = 128;
const MAX_PRESERVED_SGR_SEQUENCES_PER_LINE = 256;
const MAX_PRESERVED_SGR_BYTES_PER_LINE = 4_096;
export const TERMINAL_STRING_INTRODUCERS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);
export const ESCAPE_STRING_INTRODUCERS = new Set(["]", "P", "X", "^", "_"]);

export const isPrintableCode = (code: number): boolean =>
  code >= 32 && code !== 127 && !(code >= 0x80 && code <= 0x9f);

interface TerminalStyledFragment<Channel extends string = string> {
  readonly channel: Channel;
  readonly text: string;
}

interface SanitizedTerminalStyledFragment<
  Channel extends string = string,
> extends TerminalStyledFragment<Channel> {
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
  readonly attributes: Set<number>;
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

const emptyStyledChannelState = (): StyledChannelState => ({
  mode: "text",
  csi: "",
  csiInvalid: false,
  sgr: { attributes: new Set() },
  lineSequences: 0,
  lineBytes: 0,
  lineBudgetExhausted: false,
});

const resetSgrState = (state: SgrState): void => {
  state.attributes.clear();
  delete state.foreground;
  delete state.background;
};

const SGR_ATTRIBUTES = [1, 2, 3, 4, 7, 9];

const isBasicColor = (code: number, base: number): boolean =>
  (code >= base && code <= base + 7) || (code >= base + 60 && code <= base + 67);

const sgrStatePrefix = (state: SgrState): string => {
  const parameters = [
    ...SGR_ATTRIBUTES.filter((code) => state.attributes.has(code)).map(String),
    ...[state.foreground, state.background].filter((color) => color !== undefined),
  ];
  return parameters.length === 0 ? "" : `\u001b[${parameters.join(";")}m`;
};

const isSimpleSafeSgr = (code: number): boolean =>
  code === 0 ||
  code === 39 ||
  code === 49 ||
  SGR_ATTRIBUTES.includes(code) ||
  SGR_ATTRIBUTES.includes(code - 20) ||
  isBasicColor(code, 30) ||
  isBasicColor(code, 40);

const extendedColorLength = (values: ReadonlyArray<number>, index: number): number | undefined => {
  const mode = values[index + 1];
  if (mode === 5) {
    const color = values[index + 2];
    return color === undefined || color > 255 ? undefined : 3;
  }
  if (mode !== 2) return undefined;
  const colors = values.slice(index + 2, index + 5);
  return colors.length !== 3 || colors.some((color) => color > 255) ? undefined : 5;
};

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
      if (!isSimpleSafeSgr(code)) return undefined;
      continue;
    }
    const length = extendedColorLength(values, index);
    if (length === undefined) return undefined;
    index += length - 1;
  }
  return values;
};

const applySafeSgr = (state: SgrState, values: ReadonlyArray<number>): void => {
  for (let index = 0; index < values.length; index += 1) {
    const code = values[index] ?? 0;
    if (code === 0) resetSgrState(state);
    else if (SGR_ATTRIBUTES.includes(code)) state.attributes.add(code);
    else if (SGR_ATTRIBUTES.includes(code - 20)) {
      state.attributes.delete(code - 20);
      if (code === 22) state.attributes.delete(1);
    } else if (isBasicColor(code, 30)) state.foreground = String(code);
    else if (code === 39) delete state.foreground;
    else if (isBasicColor(code, 40)) state.background = String(code);
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

interface StyledFragmentWriter {
  readonly state: StyledChannelState;
  output: string;
}

const emitSgr = (writer: StyledFragmentWriter, parameters: string): void => {
  const { state } = writer;
  const values = parseSafeSgr(parameters);
  if (values === undefined || state.lineBudgetExhausted) return;
  const sequence = `\u001b[${values.join(";")}m`;
  if (
    state.lineSequences >= MAX_PRESERVED_SGR_SEQUENCES_PER_LINE ||
    state.lineBytes + sequence.length > MAX_PRESERVED_SGR_BYTES_PER_LINE
  ) {
    writer.output += "\u001b[0m";
    resetSgrState(state.sgr);
    state.lineBudgetExhausted = true;
    return;
  }
  writer.output += sequence;
  state.lineSequences += 1;
  state.lineBytes += sequence.length;
  applySafeSgr(state.sgr, values);
};

const emitText = (writer: StyledFragmentWriter, character: string, code: number): void => {
  if (character === "\n") {
    writer.output += character;
    resetStyledLineBudget(writer.state);
  } else if (character === "\t") writer.output += "   ";
  else if (isPrintableCode(code)) writer.output += character;
};

const beginCsi = (state: StyledChannelState): void => {
  state.mode = "csi";
  state.csi = "";
  state.csiInvalid = false;
};

const processText = (writer: StyledFragmentWriter, character: string, code: number): void => {
  if (code === 0x1b) writer.state.mode = "escape";
  else if (code === 0x9b) beginCsi(writer.state);
  else if (TERMINAL_STRING_INTRODUCERS.has(code)) writer.state.mode = "terminal-string";
  else emitText(writer, character, code);
};

const stepTerminalString = (state: StyledChannelState, code: number): void => {
  if (code === 0x07 || code === 0x9c) state.mode = "text";
  else if (code === 0x1b) state.mode = "terminal-string-escape";
};

const stepTerminalStringEscape = (
  state: StyledChannelState,
  character: string,
  code: number,
): void => {
  if (character === "\\" || code === 0x9c) state.mode = "text";
  else if (code !== 0x1b) state.mode = "terminal-string";
};

const stepEscape = (writer: StyledFragmentWriter, character: string, code: number): void => {
  const { state } = writer;
  if (character === "[") beginCsi(state);
  else if (ESCAPE_STRING_INTRODUCERS.has(character)) state.mode = "terminal-string";
  else if (code >= 0x20 && code <= 0x2f) state.mode = "escape-intermediate";
  else if (code >= 0x30 && code <= 0x7e) state.mode = "text";
  else {
    state.mode = "text";
    processText(writer, character, code);
  }
};

const stepEscapeIntermediate = (
  writer: StyledFragmentWriter,
  character: string,
  code: number,
): void => {
  if (code >= 0x20 && code <= 0x2f) return;
  writer.state.mode = "text";
  if (code < 0x30 || code > 0x7e) processText(writer, character, code);
};

const stepCsi = (writer: StyledFragmentWriter, character: string, code: number): void => {
  const { state } = writer;
  if (code >= 0x40 && code <= 0x7e) {
    if (character === "m" && !state.csiInvalid) emitSgr(writer, state.csi);
    state.mode = "text";
  } else if (code === 0x1b || TERMINAL_STRING_INTRODUCERS.has(code) || code === 0x9b) {
    state.mode = "text";
    processText(writer, character, code);
  } else if (state.csi.length < MAX_SAFE_SGR_PARAMETER_LENGTH) state.csi += character;
  else state.csiInvalid = true;
};

const stepCharacter = (writer: StyledFragmentWriter, character: string): void => {
  const code = character.charCodeAt(0);
  switch (writer.state.mode) {
    case "text":
      return processText(writer, character, code);
    case "terminal-string":
      return stepTerminalString(writer.state, code);
    case "terminal-string-escape":
      return stepTerminalStringEscape(writer.state, character, code);
    case "escape":
      return stepEscape(writer, character, code);
    case "escape-intermediate":
      return stepEscapeIntermediate(writer, character, code);
    case "csi":
      return stepCsi(writer, character, code);
  }
};

export function sanitizeTerminalStyledFragments<Channel extends string>(
  fragments: ReadonlyArray<TerminalStyledFragment<Channel>>,
): ReadonlyArray<SanitizedTerminalStyledFragment<Channel>> {
  const states = new Map<Channel, StyledChannelState>();
  return fragments.map((fragment) => {
    const state = states.get(fragment.channel) ?? emptyStyledChannelState();
    states.set(fragment.channel, state);
    const reopenSgr = sgrStatePrefix(state.sgr);
    const writer: StyledFragmentWriter = { state, output: "" };
    for (const character of fragment.text) stepCharacter(writer, character);
    return { channel: fragment.channel, text: writer.output, reopenSgr };
  });
}
