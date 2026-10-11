export function getFirstShellCommandName(command: string): string | undefined {
  const words = getLeadingShellWords(command);
  const commandWord = words.find((word) => !isShellAssignment(word));
  return commandWord?.split("/").pop();
}

export function normalizeShellCommandWhitespace(command: string): string {
  return command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
}

interface ShellScan {
  readonly text: string;
  readonly end: number;
}

function getLeadingShellWords(command: string): string[] {
  const words: string[] = [];
  let index = skipShellWhitespace(command, 0);
  while (index < command.length && !isShellOperator(command.charAt(index))) {
    const word = readShellWord(command, index);
    if (word.text) words.push(word.text);
    if (words.length >= 8) break;
    index = skipShellWhitespace(command, word.end);
  }
  return words;
}

function skipShellWhitespace(command: string, start: number): number {
  let index = start;
  while (index < command.length && /\s/.test(command.charAt(index))) index++;
  return index;
}

function readShellWord(command: string, start: number): ShellScan {
  let text = "";
  let index = start;
  while (index < command.length) {
    const char = command.charAt(index);
    if (/\s/.test(char) || isShellOperator(char)) break;
    const part = readShellWordPart(command, index);
    text += part.text;
    index = part.end;
  }
  return { text, end: index };
}

function readShellWordPart(command: string, index: number): ShellScan {
  const char = command.charAt(index);
  if (char === "'" || char === '"') return readShellQuoted(command, index + 1, char);
  if (char === "\\")
    return { text: command.charAt(index + 1), end: Math.min(index + 2, command.length) };
  return { text: char, end: index + 1 };
}

function readShellQuoted(command: string, start: number, quote: string): ShellScan {
  let text = "";
  let index = start;
  while (index < command.length && command.charAt(index) !== quote) {
    if (quote === '"' && command.charAt(index) === "\\") index++;
    if (index < command.length) {
      text += command.charAt(index);
      index++;
    }
  }
  return { text, end: index < command.length ? index + 1 : index };
}

function isShellAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word);
}

function isShellOperator(char: string): boolean {
  return "|&;()<>{}".includes(char);
}
