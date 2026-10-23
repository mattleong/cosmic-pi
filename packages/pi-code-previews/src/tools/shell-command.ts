import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";

export function getFirstShellCommandName(command: string): string | undefined {
  const words = getLeadingShellWords(command);
  const commandWord = Option.getOrUndefined(
    Arr.findFirst(words, (word) => !isShellAssignment(word)),
  );
  return commandWord === undefined ? undefined : Str.split(commandWord, "/").pop();
}

export function normalizeShellCommandWhitespace(command: string): string {
  return Fn.pipe(command, Str.replace(/\\\n/g, " "), Str.replace(/\s+/g, " "), Str.trim);
}

interface ShellScan {
  readonly text: string;
  readonly end: number;
}

function getLeadingShellWords(command: string): string[] {
  const words: string[] = [];
  let index = skipShellWhitespace(command, 0);
  while (index < command.length && !isShellOperator(command[index] ?? "")) {
    const word = readShellWord(command, index);
    if (word.text) words.push(word.text);
    if (words.length >= 8) break;
    index = skipShellWhitespace(command, word.end);
  }
  return words;
}

function skipShellWhitespace(command: string, start: number): number {
  let index = start;
  while (index < command.length && /\s/.test(command[index] ?? "")) index++;
  return index;
}

function readShellWord(command: string, start: number): ShellScan {
  let text = "";
  let index = start;
  while (index < command.length) {
    const char = command[index] ?? "";
    if (/\s/.test(char) || isShellOperator(char)) break;
    const part = readShellWordPart(command, index);
    text += part.text;
    index = part.end;
  }
  return { text, end: index };
}

function readShellWordPart(command: string, index: number): ShellScan {
  const char = command[index] ?? "";
  if (char === "'" || char === '"') return readShellQuoted(command, index + 1, char);
  if (char === "\\")
    return { text: command[index + 1] ?? "", end: Math.min(index + 2, command.length) };
  return { text: char, end: index + 1 };
}

function readShellQuoted(command: string, start: number, quote: string): ShellScan {
  let text = "";
  let index = start;
  while (index < command.length && (command[index] ?? "") !== quote) {
    if (quote === '"' && (command[index] ?? "") === "\\") index++;
    if (index < command.length) {
      text += command[index] ?? "";
      index++;
    }
  }
  return { text, end: index < command.length ? index + 1 : index };
}

function isShellAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word);
}

function isShellOperator(char: string): boolean {
  return Fn.pipe("|&;()<>{}", Str.includes(char));
}
