import { defineRule } from "@oxlint/plugins";
import type { Comment } from "@oxlint/plugins";

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

const HORIZONTAL_SPACE = /[ \t]/u;
const WORD = /[\p{L}\p{N}_$]/u;

function lineStart(text: string, offset: number): number {
  let index = offset;
  while (index > 0 && HORIZONTAL_SPACE.test(text[index - 1] ?? "")) index -= 1;
  return index;
}

function lineEnd(text: string, offset: number): number {
  let index = offset;
  while (index < text.length && HORIZONTAL_SPACE.test(text[index] ?? "")) index += 1;
  return index;
}

function startsLine(text: string, offset: number): boolean {
  const start = lineStart(text, offset);
  return start === 0 || text[start - 1] === "\n";
}

function endsLine(text: string, offset: number): boolean {
  const end = lineEnd(text, offset);
  return end === text.length || text[end] === "\n" || text[end] === "\r";
}

function newlineLength(text: string, offset: number): number {
  if (text.startsWith("\r\n", offset)) return 2;
  return text[offset] === "\n" ? 1 : 0;
}

function removal(text: string, comment: Comment): Edit {
  const ownsStart = startsLine(text, comment.start);
  const ownsEnd = endsLine(text, comment.end);
  if (ownsStart && ownsEnd) {
    const end = lineEnd(text, comment.end);
    return { start: lineStart(text, comment.start), end: end + newlineLength(text, end), replacement: "" };
  }
  if (ownsEnd) return { start: lineStart(text, comment.start), end: comment.end, replacement: "" };
  const joinsWords = WORD.test(text[comment.start - 1] ?? "") && WORD.test(text[comment.end] ?? "");
  return joinsWords
    ? { start: comment.start, end: comment.end, replacement: " " }
    : { start: comment.start, end: lineEnd(text, comment.end), replacement: "" };
}

function mergedRemovals(text: string, comments: readonly Comment[]): Map<Comment, Edit> {
  const owners = new Map<Comment, Edit>();
  let owner: Comment | undefined;
  let group: Edit | undefined;
  for (const comment of comments) {
    const edit = removal(text, comment);
    if (owner && group && group.replacement === "" && edit.replacement === "" && edit.start <= group.end) {
      group = { start: group.start, end: Math.max(group.end, edit.end), replacement: "" };
      owners.set(owner, group);
      continue;
    }
    owner = comment;
    group = edit;
    owners.set(owner, group);
  }
  return owners;
}

export const noCommentsRule = defineRule({
  meta: {
    type: "suggestion",
    fixable: "code",
    docs: {
      description: "Disallow source comments; names, types, and tests carry intent.",
    },
    messages: {
      comment:
        "Remove this comment. Carry the intent in names, types, or tests instead of prose beside the code.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        const text = context.sourceCode.text;
        const comments = context.sourceCode
          .getAllComments()
          .filter((comment) => comment.type !== "Shebang");
        const edits = mergedRemovals(text, comments);
        for (const comment of comments) {
          const edit = edits.get(comment);
          if (edit === undefined) {
            context.report({ loc: comment.loc, messageId: "comment" });
            continue;
          }
          context.report({
            loc: comment.loc,
            messageId: "comment",
            fix: (fixer) => fixer.replaceTextRange([edit.start, edit.end], edit.replacement),
          });
        }
      },
    };
  },
});
