// Pure humanized `code_mode` tool presentation: intent headline, activity summaries, and
// collapsed/expanded call/result projections, including hostile-input containment.
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  type Component,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODE_MODE_FALLBACK_INTENT,
  decodeCodeModeRenderDetails,
  describeCodeModeIntent,
  nestedToolIcon,
  renderCodeModeToolCall,
  renderCodeModeToolResult,
} from "../src/ui/tool-renderer.ts";
import {
  describeNestedActivity,
  MAX_ACTIVITY_FIELD_LENGTH,
  MAX_INTENT_LENGTH,
  MAX_PROGRESS_ENTRIES,
  type CodeModeToolDetails,
} from "../src/tools/format.ts";

/** Identity theme: no ANSI, so assertions read plain text. */
const theme = {
  bold: (text: string) => text,
  fg: (_key: string, text: string) => text,
} as Theme;

/** Marking theme: color keys become visible tags for the few color-sensitive assertions. */
const markingTheme = {
  bold: (text: string) => `<b>${text}</b>`,
  fg: (key: string, text: string) => `<${key}>${text}</${key}>`,
} as Theme;

const rendered = (component: Component, width = 400): string => component.render(width).join("\n");

const resultOf = (
  text: string,
  details: CodeModeToolDetails | unknown,
): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details,
});

describe("describeCodeModeIntent", () => {
  it("keeps a short human-readable intent as-is", () => {
    expect(describeCodeModeIntent("Inspect the extension")).toBe("Inspect the extension");
  });

  it("falls back to a neutral phrase for missing, non-string, or empty intent", () => {
    expect(describeCodeModeIntent(undefined)).toBe(CODE_MODE_FALLBACK_INTENT);
    expect(describeCodeModeIntent(42)).toBe(CODE_MODE_FALLBACK_INTENT);
    expect(describeCodeModeIntent("   ")).toBe(CODE_MODE_FALLBACK_INTENT);
    expect(describeCodeModeIntent("[2J")).toBe(CODE_MODE_FALLBACK_INTENT);
  });

  it("strips terminal controls and collapses whitespace", () => {
    expect(describeCodeModeIntent("Check[31m the\nXfiles")).toBe("Check the files");
  });

  it("truncates code-point-safely at the display bound", () => {
    const intent = "🌍".repeat(MAX_INTENT_LENGTH + 20);
    const shown = describeCodeModeIntent(intent);
    expect([...shown]).toHaveLength(MAX_INTENT_LENGTH);
    expect(shown.endsWith("…")).toBe(true);
    expect(shown).not.toContain("�");
  });
});

describe("describeNestedActivity", () => {
  it("summarizes all eight known nested tools", () => {
    expect(describeNestedActivity("pi.read", { path: "src/app.ts" })).toBe("Read src/app.ts");
    expect(describeNestedActivity("pi.bash", { command: "pnpm test" })).toBe("Run pnpm test");
    expect(describeNestedActivity("pi.edit", { path: "src/app.ts" })).toBe("Edit src/app.ts");
    expect(describeNestedActivity("pi.write", { path: "src/new.ts" })).toBe("Write src/new.ts");
    expect(describeNestedActivity("pi.grep", { pattern: "TODO", path: "src" })).toBe(
      "Search TODO in src",
    );
    expect(describeNestedActivity("pi.find", { pattern: "*.ts", path: "packages" })).toBe(
      "Find *.ts in packages",
    );
    expect(describeNestedActivity("pi.ls", { path: "docs" })).toBe("List docs");
    expect(describeNestedActivity("$codemode.search", { query: "read files" })).toBe(
      "Discover tools for read files",
    );
  });

  it("uses safe defaults when optional fields are absent", () => {
    expect(describeNestedActivity("pi.read", {})).toBe("Read file");
    expect(describeNestedActivity("pi.bash", {})).toBe("Run command");
    expect(describeNestedActivity("pi.edit", {})).toBe("Edit file");
    expect(describeNestedActivity("pi.write", {})).toBe("Write file");
    expect(describeNestedActivity("pi.grep", { pattern: "x" })).toBe("Search x in cwd");
    expect(describeNestedActivity("pi.find", {})).toBe("Find pattern in cwd");
    expect(describeNestedActivity("pi.ls", {})).toBe("List cwd");
    expect(describeNestedActivity("$codemode.search", {})).toBe("Discover tools");
  });

  it("truncates long paths, patterns, and queries code-point-safely", () => {
    const path = "a/".repeat(200);
    const label = describeNestedActivity("pi.read", { path });
    expect([...label]).toHaveLength("Read ".length + MAX_ACTIVITY_FIELD_LENGTH);
    expect(label.endsWith("…")).toBe(true);
  });

  it("contains hostile inputs: control injection, wrong types, and unknown names", () => {
    expect(describeNestedActivity("pi.read", { path: "]0;pwna.txt" })).toBe("Read a.txt");
    expect(describeNestedActivity("pi.read", { path: 7 })).toBe("Read file");
    expect(describeNestedActivity("pi.read", null)).toBe("Read file");
    expect(describeNestedActivity("pi.read", "not an object")).toBe("Read file");
    expect(describeNestedActivity(undefined, { path: "x" })).toBe("Call tool");
    expect(describeNestedActivity("custom.tool", { anything: { nested: true } })).toBe(
      "Call custom.tool",
    );
    // Raw objects are never stringified into the label.
    expect(describeNestedActivity("pi.grep", { pattern: { toString: () => "x" } })).toBe(
      "Search pattern in cwd",
    );
  });
});

describe("nestedToolIcon", () => {
  it("degrades when a stale or hostile optional icon API is missing", () => {
    expect(nestedToolIcon("pi.read", null)).toBeUndefined();
    expect(
      nestedToolIcon("pi.read", () => {
        throw new Error("stale preview helper");
      }),
    ).toBeUndefined();
    expect(nestedToolIcon("read", () => "📖")).toBeUndefined();
    expect(nestedToolIcon("pi.read", () => 42 as never)).toBeUndefined();
    expect(nestedToolIcon("pi.read", () => "📖\u001b]0;title\u0007")).toBe("📖");
    expect(nestedToolIcon("pi.read", () => "📖")).toBe("📖");
  });
});

describe("renderCodeModeToolCall", () => {
  const args = { code: "const a = 1;\nreturn a;", intent: "Inspect the extension" };

  it("collapsed shows only the intent headline, never the source", () => {
    const text = rendered(renderCodeModeToolCall(args, theme, { expanded: false }));
    expect(text).toContain("Code Mode · Inspect the extension");
    expect(text).not.toContain("const a = 1;");
    expect(text).not.toContain('"code"');
  });

  it("renders collapsed when the shell delegates without a context", () => {
    const text = rendered(renderCodeModeToolCall(args, theme, undefined));
    expect(text).toContain("Code Mode · Inspect the extension");
    expect(text).not.toContain("const a = 1;");
  });

  it("falls back to the neutral intent when none was provided", () => {
    const text = rendered(renderCodeModeToolCall({ code: "return 1;" }, theme, undefined));
    expect(text).toContain(`Code Mode · ${CODE_MODE_FALLBACK_INTENT}`);
  });

  it("expanded shows the full program source with newlines, without JSON framing", () => {
    const text = rendered(renderCodeModeToolCall(args, theme, { expanded: true }));
    expect(text).toContain("Code Mode · Inspect the extension");
    expect(text).toContain("Program");
    expect(text).toContain("const a = 1;");
    expect(text).toContain("return a;");
    expect(text.indexOf("const a = 1;")).toBeLessThan(text.indexOf("return a;"));
    expect(text).not.toContain('{"code"');
  });

  it("strips terminal controls from a hostile program source but keeps its text", () => {
    const hostile = { code: "line1[2Jrest\nline2end", intent: "x" };
    const text = rendered(renderCodeModeToolCall(hostile, theme, { expanded: true }));
    expect(text).toContain("line1rest");
    expect(text).toContain("line2end");
    expect(text).not.toContain("");
    expect(text).not.toContain("");
  });

  it("sanitizes control sequences out of a hostile intent headline", () => {
    const hostile = { code: "return 1;", intent: "safe]2;evil intent" };
    const text = rendered(renderCodeModeToolCall(hostile, theme, undefined));
    expect(text).toContain("Code Mode · safe intent");
    expect(text).not.toContain("");
  });

  it("shows a bounded placeholder when Pi supplies incomplete or hostile arguments", () => {
    const text = rendered(renderCodeModeToolCall({ intent: "x" }, theme, { expanded: true }));
    expect(text).toContain("(program not available)");
    expect(rendered(renderCodeModeToolCall(undefined, theme, { expanded: true }))).toContain(
      "(program not available)",
    );
  });

  it("styles the headline with the tool title and dim colors", () => {
    const text = rendered(renderCodeModeToolCall(args, markingTheme, undefined));
    expect(text).toContain("<toolTitle><b>Code Mode</b></toolTitle>");
    expect(text).toContain("<dim>· Inspect the extension</dim>");
  });
});

describe("renderCodeModeToolResult", () => {
  const runningDetails: CodeModeToolDetails = {
    toolCalls: [
      { tool: "pi.read", status: "completed", activity: "Read src/app.ts" },
      { tool: "pi.grep", status: "running", activity: "Search TODO in src" },
    ],
  };

  it("partial shows activity rows with symbols and a progress footer, not raw text", () => {
    const result = resultOf("code_mode: 2 nested tool calls (1 settled)", runningDetails);
    const text = rendered(
      renderCodeModeToolResult(result, { isPartial: true }, theme, {
        expanded: false,
        isError: false,
      }),
    );
    expect(text).toContain("✓ 📖 Read src/app.ts");
    expect(text).toContain("⠋ 🔎 Search TODO in src");
    expect(text).toContain("1 of 2 settled · 1 succeeded · 1 running");
    expect(text).not.toContain("code_mode: 2 nested tool calls");
  });

  it("uses the standalone built-in tool emojis while preserving lifecycle status", () => {
    const details: CodeModeToolDetails = {
      toolCalls: [
        { tool: "pi.bash", status: "completed", activity: "Run command" },
        { tool: "pi.read", status: "completed", activity: "Read file" },
        { tool: "pi.write", status: "completed", activity: "Write file" },
        { tool: "pi.edit", status: "completed", activity: "Edit file" },
        { tool: "pi.grep", status: "completed", activity: "Search pattern in cwd" },
        { tool: "pi.find", status: "completed", activity: "Find pattern in cwd" },
        { tool: "pi.ls", status: "completed", activity: "List cwd" },
        { tool: "$codemode.search", status: "completed", activity: "Discover tools" },
        { tool: "read", status: "completed", activity: "Bare read" },
      ],
    };
    const text = rendered(
      renderCodeModeToolResult(resultOf("", details), { isPartial: false }, theme, {
        expanded: false,
        isError: false,
      }),
    );
    expect(text).toContain("✓ 🔧 Run command");
    expect(text).toContain("✓ 📖 Read file");
    expect(text).toContain("✓ ✏️ Write file");
    expect(text).toContain("✓ ✂️ Edit file");
    expect(text).toContain("✓ 🔎 Search pattern in cwd");
    expect(text).toContain("✓ 🎯 Find pattern in cwd");
    expect(text).toContain("✓ 📂 List cwd");
    expect(text).toContain("✓ Discover tools");
    expect(text).toContain("✓ Bare read");
    expect(text).not.toContain("✓ 📖 Bare read");
  });

  it("renders queued, cancelled, durations, and accurate lifecycle counts", () => {
    const details: CodeModeToolDetails = {
      toolCalls: [
        { tool: "pi.read", status: "queued", activity: "Read queued" },
        { tool: "pi.bash", status: "cancelled", activity: "Run sleep", durationMs: 1_250 },
      ],
      counts: {
        total: 2,
        queued: 1,
        running: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 1,
      },
    };
    const text = rendered(
      renderCodeModeToolResult(resultOf("", details), { isPartial: true }, markingTheme, {
        expanded: false,
        isError: false,
      }),
    );
    expect(text).toContain("<dim>◌</dim> <toolTitle>📖</toolTitle>");
    expect(text).toContain("<muted>⊘</muted> <toolTitle>🔧</toolTitle>");
    expect(text).toContain("<muted> · 1.3s</muted>");
    expect(text).toContain("1 of 2 settled · 1 queued · 1 cancelled");
  });

  it("colors running, success, and error rows distinctly", () => {
    const details: CodeModeToolDetails = {
      toolCalls: [
        { tool: "pi.read", status: "completed", activity: "Read a" },
        { tool: "pi.read", status: "error", activity: "Read b" },
        { tool: "pi.read", status: "running", activity: "Read c" },
      ],
    };
    const text = rendered(
      renderCodeModeToolResult(resultOf("", details), { isPartial: true }, markingTheme, {
        expanded: false,
        isError: false,
      }),
    );
    expect(text).toContain("<success>✓</success>");
    expect(text).toContain("<error>✗</error>");
    expect(text).toContain("<warning>⠋</warning>");
    expect(text).toContain("<muted>2 of 3 settled · 1 succeeded · 1 failed · 1 running</muted>");
  });

  it("selects the running Braille glyph from the supplied animation frame", () => {
    const text = rendered(
      renderCodeModeToolResult(
        resultOf("", runningDetails),
        { isPartial: true },
        theme,
        { expanded: false, isError: false },
        1,
      ),
    );
    expect(text).toContain("⠙ 🔎 Search TODO in src");
    expect(text).not.toContain("⠋ 🔎 Search TODO in src");
  });

  it("final success shows completed rows and an operations footer, hiding raw output", () => {
    const details: CodeModeToolDetails = {
      toolCalls: [
        { tool: "pi.read", status: "completed", activity: "Read a" },
        { tool: "pi.grep", status: "completed", activity: "Search x in cwd" },
      ],
    };
    const result = resultOf("SECRET-MODEL-OUTPUT", details);
    const collapsed = rendered(
      renderCodeModeToolResult(result, { isPartial: false }, theme, {
        expanded: false,
        isError: false,
      }),
    );
    expect(collapsed).toContain("✓ 📖 Read a");
    expect(collapsed).toContain("✓ 🔎 Search x in cwd");
    expect(collapsed).toContain("2 operations completed");
    expect(collapsed).not.toContain("SECRET-MODEL-OUTPUT");
    expect(collapsed).toContain("▸ output · expand");
  });

  it("expanded shows the same rows plus the complete sanitized output under a label", () => {
    const details: CodeModeToolDetails = {
      toolCalls: [{ tool: "pi.read", status: "completed", activity: "Read a" }],
    };
    const result = resultOf("line one[31m\nline two", details);
    const text = rendered(
      renderCodeModeToolResult(result, { isPartial: false }, theme, {
        expanded: true,
        isError: false,
      }),
    );
    expect(text).toContain("✓ 📖 Read a");
    expect(text).toContain("1 operation completed");
    expect(text).toContain("Output");
    expect(text).toContain("line one");
    expect(text).toContain("line two");
    expect(text).not.toContain("");
    expect(text).not.toContain("");
  });

  it("projects multiline structured results as labeled sections without changing content", () => {
    const output = `${JSON.stringify(
      {
        status: " M src/a.ts\n M src/b.ts\n",
        protectedQueryFiles: "src/protected/a.ts\nsrc/protected/b.ts",
        nestedIndexes: "No files found matching pattern",
        diffCheck: "(no output)",
      },
      null,
      2,
    )}\n\nLogs:\ninspection complete`;
    const result = resultOf(output, {
      toolCalls: [{ tool: "pi.bash", status: "completed", activity: "Run git status --short" }],
      outputKind: "structured",
    });
    const text = rendered(
      renderCodeModeToolResult(result, { isPartial: false }, theme, {
        expanded: true,
        isError: false,
      }),
    );
    for (const expected of [
      "Output",
      "status",
      " M src/a.ts",
      " M src/b.ts",
      "protectedQueryFiles",
      "src/protected/a.ts",
      "src/protected/b.ts",
      "nestedIndexes",
      "No files found matching pattern",
      "Logs",
      "inspection complete",
    ])
      expect(text).toContain(expected);
    expect(text).not.toContain("\\n M src/b.ts");
  });

  it("does not reinterpret a text result merely because the string contains valid JSON", () => {
    const jsonText = JSON.stringify({ status: "one\ntwo" }, null, 2);
    const text = rendered(
      renderCodeModeToolResult(
        resultOf(jsonText, { toolCalls: [], outputKind: "text" }),
        { isPartial: false },
        theme,
        { expanded: true, isError: false },
      ),
    );
    expect(text).toContain('"status": "one\\ntwo"');
    expect(text).not.toContain("status\none\ntwo");
  });

  it("errors show a Failed footer and the sanitized error text when expanded", () => {
    const result = resultOf("[ToolFailure] nested read refused", undefined);
    const collapsed = rendered(
      renderCodeModeToolResult(result, { isPartial: false }, theme, {
        expanded: false,
        isError: true,
      }),
    );
    expect(collapsed).toContain("Failed");
    expect(collapsed).toContain("▸ error · expand");
    expect(collapsed).not.toContain("[ToolFailure]");
    const expanded = rendered(
      renderCodeModeToolResult(result, { isPartial: false }, theme, {
        expanded: true,
        isError: true,
      }),
    );
    expect(expanded).toContain("Failed");
    expect(expanded).toContain("Error");
    expect(expanded).toContain("[ToolFailure] nested read refused");
  });

  it("degrades to a bounded custom result instead of throwing into Pi's generic fallback", () => {
    const throwingTheme = {
      bold: () => {
        throw new Error("theme unavailable");
      },
      fg: () => {
        throw new Error("theme unavailable");
      },
    } as unknown as Theme;
    const result = resultOf("SECRET-MODEL-OUTPUT", {
      toolCalls: [{ tool: "pi.read", status: "completed", activity: "Read a" }],
    });
    const collapsed = rendered(
      renderCodeModeToolResult(result, { isPartial: false }, throwingTheme, {
        expanded: false,
        isError: false,
      }),
    );
    expect(collapsed).toContain("Code Mode completed");
    expect(collapsed).toContain("▸ output · expand");
    expect(collapsed).not.toContain("SECRET-MODEL-OUTPUT");

    const expanded = rendered(
      renderCodeModeToolResult(result, { isPartial: false }, throwingTheme, {
        expanded: true,
        isError: false,
      }),
    );
    expect(expanded).toContain("Code Mode completed");
    expect(expanded).toContain("Output");
    expect(expanded).toContain("SECRET-MODEL-OUTPUT");
  });

  it("cancelled details show a Cancelled footer even with settled rows", () => {
    const details: CodeModeToolDetails = {
      toolCalls: [{ tool: "pi.read", status: "completed", activity: "Read a" }],
      cancelled: true,
    };
    const text = rendered(
      renderCodeModeToolResult(
        resultOf("Execution cancelled.", details),
        { isPartial: false },
        theme,
        {
          expanded: false,
          isError: false,
        },
      ),
    );
    expect(text).toContain("Cancelled");
  });

  it("notes truncation in the footer", () => {
    const details: CodeModeToolDetails = {
      toolCalls: [{ tool: "pi.read", status: "completed", activity: "Read a" }],
      truncated: true,
    };
    const text = rendered(
      renderCodeModeToolResult(resultOf("x", details), { isPartial: false }, theme, {
        expanded: false,
        isError: false,
      }),
    );
    expect(text).toContain("1 operation completed · output truncated");
  });

  it("shows +N earlier for exact modern counts", () => {
    const details: CodeModeToolDetails = {
      toolCalls: Array.from({ length: 32 }, (_, index) => ({
        tool: "pi.read",
        status: "completed" as const,
        activity: `Read recent-${index}`,
      })),
      totalToolCalls: 40,
      counts: {
        total: 40,
        queued: 0,
        running: 0,
        succeeded: 39,
        failed: 1,
        cancelled: 0,
      },
    };
    const text = rendered(
      renderCodeModeToolResult(resultOf("", details), { isPartial: false }, theme, {
        expanded: false,
        isError: false,
      }),
    );
    expect(text).toContain("+8 earlier");
    expect(text).toContain("39 succeeded · 1 failed");
  });

  it("shows +N more beyond the bounded entries without exposing raw data", () => {
    const details: CodeModeToolDetails = {
      toolCalls: Array.from({ length: 32 }, (_, index) => ({
        tool: "pi.read",
        status: "completed" as const,
        activity: `Read file-${index}`,
      })),
      totalToolCalls: 40,
    };
    const text = rendered(
      renderCodeModeToolResult(resultOf("done", details), { isPartial: false }, theme, {
        expanded: false,
        isError: false,
      }),
    );
    expect(text).toContain("+8 more");
    expect(text).toContain("40 operations completed");
  });

  it("shows a useful status when there are no nested calls", () => {
    const result = resultOf("plain value", { toolCalls: [] });
    const collapsed = rendered(
      renderCodeModeToolResult(result, { isPartial: false }, theme, {
        expanded: false,
        isError: false,
      }),
    );
    expect(collapsed).toContain("Completed");
    expect(collapsed).not.toContain("plain value");
    const expanded = rendered(
      renderCodeModeToolResult(result, { isPartial: false }, theme, {
        expanded: true,
        isError: false,
      }),
    );
    expect(expanded).toContain("Output");
    expect(expanded).toContain("plain value");
  });

  it("sanitizes hostile activity labels persisted in details", () => {
    const details = {
      toolCalls: [{ tool: "pi.read", status: "completed", activity: "Read [9999Devil" }],
    };
    const text = rendered(
      renderCodeModeToolResult(resultOf("", details), { isPartial: false }, theme, {
        expanded: false,
        isError: false,
      }),
    );
    expect(text).toContain("✓ 📖 Read evil");
    expect(text).not.toContain("");
  });

  it("tolerates hostile or legacy details without throwing", () => {
    for (const details of [undefined, null, "garbage", 42, { toolCalls: "nope" }, []]) {
      const text = rendered(
        renderCodeModeToolResult(resultOf("out", details), { isPartial: false }, theme, {
          expanded: false,
          isError: false,
        }),
      );
      expect(text).toContain("Completed");
    }
  });

  it("falls back to a tool-derived label for legacy entries without activity", () => {
    const details = { toolCalls: [{ tool: "pi.read", status: "completed" }] };
    const text = rendered(
      renderCodeModeToolResult(resultOf("", details), { isPartial: false }, theme, {
        expanded: false,
        isError: false,
      }),
    );
    expect(text).toContain("✓ 📖 Read file");
  });
});

describe("renderCodeModeToolResult expand hint keybinding", () => {
  let previous: KeybindingsManager;

  beforeEach(() => {
    previous = getKeybindings();
  });

  afterEach(() => {
    setKeybindings(previous);
  });

  const collapsed = (isError: boolean): string =>
    rendered(
      renderCodeModeToolResult(
        resultOf("hidden text", { toolCalls: [] }),
        { isPartial: false },
        theme,
        {
          expanded: false,
          isError,
        },
      ),
    );

  it("names the configured custom expand key, preferring user bindings over defaults", () => {
    setKeybindings(
      new KeybindingsManager(
        { "app.tools.expand": { defaultKeys: "ctrl+o" } },
        { "app.tools.expand": "ctrl+r" },
      ),
    );
    expect(collapsed(false)).toContain("▸ output · ctrl+r expand");
    expect(collapsed(false)).not.toContain("ctrl+o");
  });

  it("joins multiple configured keys with a slash", () => {
    setKeybindings(
      new KeybindingsManager({ "app.tools.expand": { defaultKeys: ["ctrl+o", "f4"] } }),
    );
    expect(collapsed(false)).toContain("▸ output · ctrl+o/f4 expand");
  });

  it("preserves the error wording alongside the configured key", () => {
    setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
    expect(collapsed(true)).toContain("▸ error · ctrl+o expand");
  });

  it("falls back to a keyless hint when the binding is explicitly unbound", () => {
    setKeybindings(
      new KeybindingsManager(
        { "app.tools.expand": { defaultKeys: "ctrl+o" } },
        { "app.tools.expand": [] },
      ),
    );
    expect(collapsed(false)).toContain("▸ output · expand");
    expect(collapsed(false)).not.toContain("ctrl+o");
  });
});

describe("decodeCodeModeRenderDetails", () => {
  it("drops malformed entries while the total never undercounts the raw array", () => {
    const decoded = decodeCodeModeRenderDetails({
      toolCalls: [
        { tool: "pi.read", status: "completed", activity: "Read a" },
        { status: "nonsense" },
        null,
        "text",
        { tool: 5, status: "running" },
      ],
      totalToolCalls: "many",
      cancelled: "yes",
      truncated: 1,
    });
    expect(decoded.toolCalls).toHaveLength(2);
    expect(decoded.toolCalls[0]?.activity).toBe("Read a");
    expect(decoded.toolCalls[1]?.tool).toBe("");
    expect(decoded.totalToolCalls).toBe(5);
    expect(decoded.cancelled).toBe(false);
    expect(decoded.truncated).toBe(false);
  });

  it("never lowers the total below the decoded entries", () => {
    const decoded = decodeCodeModeRenderDetails({
      toolCalls: [{ tool: "pi.read", status: "running" }],
      totalToolCalls: 0,
    });
    expect(decoded.totalToolCalls).toBe(1);
  });

  it("decodes at most the bounded entries from a huge hostile raw array", () => {
    const decoded = decodeCodeModeRenderDetails({
      toolCalls: Array.from({ length: 1_000 }, (_, index) => ({
        tool: "pi.read",
        status: "completed",
        activity: `Read file-${index}`,
      })),
    });
    expect(decoded.toolCalls).toHaveLength(MAX_PROGRESS_ENTRIES);
    expect(decoded.toolCalls[0]?.activity).toBe("Read file-0");
    expect(decoded.toolCalls[MAX_PROGRESS_ENTRIES - 1]?.activity).toBe(
      `Read file-${MAX_PROGRESS_ENTRIES - 1}`,
    );
    expect(decoded.totalToolCalls).toBe(1_000);
  });

  it("stays bounded on a huge sparse hostile array without materializing it", () => {
    // A sparse array carries a large length with no allocated slots; only the bounded
    // slice may ever be inspected.
    const sparse: unknown[] = [];
    sparse.length = 50_000_000;
    const decoded = decodeCodeModeRenderDetails({ toolCalls: sparse });
    expect(decoded.toolCalls).toHaveLength(0);
    expect(decoded.totalToolCalls).toBe(50_000_000);
  });

  it("ignores hostile persisted totals that are not safe non-negative integers", () => {
    for (const totalToolCalls of [-5, Number.NaN, Infinity, 2 ** 53, 1.5, "9999", null]) {
      const decoded = decodeCodeModeRenderDetails({
        toolCalls: [{ tool: "pi.read", status: "completed" }],
        totalToolCalls,
      });
      expect(decoded.totalToolCalls).toBe(1);
    }
  });

  it("accepts a larger valid persisted total above the raw length", () => {
    const decoded = decodeCodeModeRenderDetails({
      toolCalls: [{ tool: "pi.read", status: "completed" }],
      totalToolCalls: 40,
    });
    expect(decoded.totalToolCalls).toBe(40);
  });
});

describe("renderCodeModeToolResult hostile raw details bounding", () => {
  it("renders only the bounded rows plus an accurate hidden count for a huge raw array", () => {
    const hostileDetails = {
      toolCalls: Array.from({ length: 100 }, (_, index) => ({
        tool: "pi.read",
        status: "completed",
        activity: `Read file-${index}`,
      })),
      // No valid supplied total: the raw length itself must drive the hidden count.
      totalToolCalls: "not a number",
    };
    const component = renderCodeModeToolResult(
      resultOf("done", hostileDetails),
      { isPartial: false },
      theme,
      { expanded: false, isError: false },
    );
    const text = rendered(component);
    const rows = text.split("\n").filter((line) => line.startsWith("✓ 📖 Read file-"));
    expect(rows).toHaveLength(MAX_PROGRESS_ENTRIES);
    expect(text).toContain(`Read file-${MAX_PROGRESS_ENTRIES - 1}`);
    expect(text).not.toContain(`Read file-${MAX_PROGRESS_ENTRIES}`);
    expect(text).toContain(`+${100 - MAX_PROGRESS_ENTRIES} more`);
    expect(text).toContain("100 operations completed");
  });

  it("renders a bounded component for a huge malformed raw array without unbounded rows", () => {
    const malformed: unknown[] = [];
    malformed.length = 1_000_000;
    const component = renderCodeModeToolResult(
      resultOf("done", { toolCalls: malformed }),
      { isPartial: false },
      theme,
      { expanded: false, isError: false },
    );
    const text = rendered(component);
    // No entry decodes, so no activity rows render; the total still reflects the raw length.
    expect(text.split("\n").filter((line) => line.length > 0).length).toBeLessThanOrEqual(3);
    expect(text).toContain("+1000000 more");
    expect(text).toContain("1000000 operations completed");
  });
});
