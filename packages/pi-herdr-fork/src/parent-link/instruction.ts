/**
 * Stable reference-only system-prompt instruction for a Herdr-created fork.
 * It names the parent session without importing any parent content.
 */
export const parentReferenceInstruction = (parentPath: string, parentId: string): string =>
  [
    "## Live parent Pi session (Herdr side session)",
    "",
    "This blank Pi side session is linked to a live parent Pi session that continues running in another pane.",
    `- Parent session file: ${JSON.stringify(parentPath)}`,
    `- Expected parent session ID: ${parentId}`,
    "",
    "The parent session file is a live, append-only JSONL transcript. When current parent activity matters, inspect that file with normal read-only tools (for example the read tool, or read-only bash commands such as tail or rg). Never mutate, resume, or compact the parent session file, and never adopt it as this session's own file. This is reference-only context: no parent content is read or imported automatically.",
  ].join("\n");
