import { visibleWidth, type SettingItem } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { plainTheme } from "pi-cosmic-core/testing";
import {
  framedKeyHintBar,
  framedKeyHints,
  joinKeyHints,
  keyHintBar,
  keyHintRows,
  wrapKeyHints,
} from "../src/manager/key-labels.ts";
import { TextPanelComponent } from "../src/manager/panel.ts";
import {
  createSettingsGroupSubmenu,
  managerSettingsTheme,
  withSettingsGroupChildren,
} from "../src/manager/settings-surface.ts";
import { managerTable } from "../src/manager/table.ts";
import { surfaceFor } from "./support/settings-surface.ts";

const DOWN = "\u001b[B";
const ESC = "\u001b";

const rows = (): SettingItem[] => [
  { id: "first", label: "First", currentValue: "on", values: ["on", "off"] },
  { id: "mode", label: "Mode", currentValue: "auto", values: ["auto", "fast", "slow"] },
  { id: "last", label: "Last", currentValue: "off", values: ["on", "off"] },
];

describe("shared settings surface", () => {
  it("toggles booleans immediately but saves enum values only when one is chosen", () => {
    const { press, onChange } = surfaceFor(rows());
    press("\r");
    expect(onChange).toHaveBeenLastCalledWith("first", "off", expect.anything());

    onChange.mockClear();
    press("j", "\r", "j", "j", ESC);
    expect(onChange).not.toHaveBeenCalled();

    press("\r", "j", "\r");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("mode", "fast", expect.anything());
  });

  it("reaches the ends of the list with G and gg", () => {
    const { press, onChange } = surfaceFor(rows());
    press("G", "\r");
    expect(onChange).toHaveBeenLastCalledWith("last", "on", expect.anything());
    press("g", "g", "\r");
    expect(onChange).toHaveBeenLastCalledWith("first", "off", expect.anything());
  });

  it("clears an applied filter with Esc before Esc closes the surface", () => {
    const { press, onCancel, text } = surfaceFor(rows());
    press("/", "z", "z", "\r");
    expect(text()).not.toContain("First");
    press(ESC);
    expect(onCancel).not.toHaveBeenCalled();
    expect(text()).toContain("First");
    press(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("saves rows inside a children group like top-level rows and shows the persisted value", () => {
    const saved: Array<readonly [string, string]> = [];
    const items = withSettingsGroupChildren(
      [
        {
          id: "group:session",
          label: "Session",
          currentValue: "inherit all",
          children: [
            { id: "session:depth", label: "Depth", currentValue: "3", values: ["1", "3"] },
          ],
          summary: () => "depth 1",
        },
      ],
      managerSettingsTheme(plainTheme),
      (id, value, show) => {
        saved.push([id, value]);
        show("1 (saved)");
      },
    );
    const { press, onChange, text } = surfaceFor(items);
    press("\r", "\r", "k", "\r");
    expect(saved).toEqual([["session:depth", "1"]]);
    expect(text()).toContain("1 (saved)");
    press(ESC);
    expect(text()).toContain("depth 1");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("returns from a choice list inside a group without leaving the group", () => {
    const values = new Map([["mode", "auto"]]);
    const groupChanges = vi.fn((id: string, value: string) => {
      values.set(id, value);
    });
    const { press, text } = surfaceFor([
      {
        kind: "group",
        id: "group:advanced",
        label: "Advanced",
        currentValue: "auto",
        submenu: (_value, done) =>
          createSettingsGroupSubmenu({
            title: "Advanced group",
            items: () => [
              {
                id: "mode",
                label: "Mode",
                currentValue: values.get("mode") ?? "auto",
                values: ["auto", "fast"],
              },
            ],
            onChange: groupChanges,
            done,
            listTheme: managerSettingsTheme(plainTheme),
          }),
      },
    ]);
    press("\r", "\r", DOWN, ESC);
    expect(groupChanges).not.toHaveBeenCalled();
    expect(text()).toContain("Advanced group");

    press("\r", DOWN, "\r");
    expect(groupChanges).toHaveBeenCalledExactlyOnceWith("mode", "fast", expect.any(Function));
    expect(text()).toContain("Advanced group");
  });
});

describe("text panel", () => {
  it("returns to the settings list when closed from a settings row", () => {
    const { press, text } = surfaceFor([
      {
        id: "debug",
        label: "Debug info",
        currentValue: "open",
        submenu: (_value, done) =>
          new TextPanelComponent({
            title: "Debug panel",
            theme: plainTheme,
            lines: ["Status: ready"],
            done: () => done(),
            exit: "nested",
          }),
      },
    ]);
    press("\r");
    expect(text()).toContain("Debug panel");
    press("q");
    expect(text()).not.toContain("Debug panel");
    expect(text()).toContain("Debug info");
  });

  const lines = Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`);

  it("closes only on exit keys, never on any key", () => {
    for (const key of [ESC, "q", "\u0003"]) {
      const done = vi.fn();
      const panel = new TextPanelComponent({ title: "Panel", theme: plainTheme, lines, done });
      for (const other of ["x", " ", "\r", "j"]) panel.handleInput(other);
      expect(done).not.toHaveBeenCalled();
      panel.handleInput(key);
      expect(done).toHaveBeenCalledOnce();
    }
  });

  it("scrolls to reveal every line when the panel is shorter than its content", () => {
    const panel = new TextPanelComponent({
      title: "Panel",
      theme: plainTheme,
      lines,
      done: () => undefined,
      maxHeight: () => 8,
    });
    const shown = () => Arr.join(panel.render(40), "\n");
    expect(panel.render(40)).toHaveLength(8);
    expect(shown()).not.toContain("Line 30");
    panel.handleInput("G");
    expect(shown()).toContain("Line 30");
    panel.handleInput("g");
    panel.handleInput("g");
    expect(shown()).toContain("Line 1 ");
  });

  it("breaks an over-long path after a slash instead of inside a name", () => {
    const panel = new TextPanelComponent({
      title: "Panel",
      theme: plainTheme,
      lines: ["    /Users/someone/.pi/agent/code-previews.json"],
      done: () => undefined,
    });
    const shown = Arr.join(panel.render(40), "\n");
    expect(shown).toContain("code-previews.json");
    expect(shown).toContain("/agent/");
  });

  it("starts a wide hyphenated name beside its label and breaks it after a hyphen", () => {
    const name = "billing-and-invoicing-migration-review-follow-up-for-the-legacy-ledger-export-v2";
    const panel = new TextPanelComponent({
      title: "Panel",
      theme: plainTheme,
      lines: [`✗ Agent ${name}: disabled`],
      done: () => undefined,
    });
    const body = Arr.map(panel.render(57), (line) =>
      Str.trim(Fn.pipe(line, Str.replace(/│/gu, ""))),
    );
    const first = Option.getOrThrow(Arr.findFirst(body, Str.startsWith("✗ Agent")));
    expect(first).not.toBe("✗ Agent");
    const parts = Arr.filter(body, (line) => /[a-z]-/u.test(line));
    expect(Arr.every(Arr.take(parts, parts.length - 1), Str.endsWith("-"))).toBe(true);
    expect(Arr.join(Arr.map(parts, Str.replace(/^✗ Agent /u, "")), "")).toContain(name);
  });

  it("breaks a row of facts between whole facts before it breaks between words", () => {
    const panel = new TextPanelComponent({
      title: "Panel",
      theme: plainTheme,
      lines: ["  Collapsed tool calls: compact · changes apply after /reload"],
      done: () => undefined,
    });
    const body = Arr.map(panel.render(57), (line) =>
      Str.trim(Fn.pipe(line, Str.replace(/│/gu, ""))),
    );
    expect(body).toContain("Collapsed tool calls: compact");
    expect(body).toContain("· changes apply after /reload");
  });

  it("wraps long lines instead of clipping them", () => {
    const words = Array.from({ length: 20 }, (_, index) => `word${index}`);
    const panel = new TextPanelComponent({
      title: "Panel",
      theme: plainTheme,
      lines: [Arr.join(words, " ")],
      done: () => undefined,
    });
    const rendered = panel.render(30);
    for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    const shown = Arr.join(rendered, " ");
    for (const word of words) expect(shown).toContain(word);
  });
});

describe("manager table", () => {
  it("gives no space to a column whose cells are all empty", () => {
    const cells = [
      ["scout", "openai-codex/gpt-6-luna", ""],
      ["planner", "claude-bridge/claude-opus-5-5", ""],
    ];
    const table = managerTable(
      cells,
      [
        { minWidth: 8, priority: 3 },
        { minWidth: 8, priority: 2 },
        { minWidth: 11, priority: 1 },
      ],
      48,
    );
    expect(table.widths[2]).toBe(0);
    for (const row of cells) expect(table.row(row)).toContain(row[1]);
  });

  it("lays out a header row over the shown columns only", () => {
    const cells = [["scout", "high", ""]];
    const table = managerTable(
      cells,
      [
        { minWidth: 4, priority: 3, header: "Profile" },
        { minWidth: 4, priority: 2, header: "Effort" },
        { minWidth: 4, priority: 1, header: "Fallbacks" },
      ],
      48,
    );
    expect(table.header).toContain("Effort");
    expect(table.header).not.toContain("Fallbacks");
    expect(Fn.pipe(table.header ?? "", Str.indexOf("Effort"))).toEqual(
      Fn.pipe(table.row(cells[0]!), Str.indexOf("high")),
    );
    expect(managerTable(cells, [{ minWidth: 4, priority: 1 }], 48).header).toBeUndefined();
  });
});

// A pair splits into its keys and its verb: `↑↓/j/k Move` names `↑↓/j/k` for Move.
const hintPairs = (hint: string) =>
  Arr.map(Str.split(hint, " · "), (pair) => {
    const [keys, ...verb] = Str.split(pair, " ");
    return { keys, verb: Arr.join(verb, " ") };
  });

describe("key hints", () => {
  it("keeps every pair, including the exit, when a bar wraps at a narrow width", () => {
    const hint = joinKeyHints(["↑↓ Move", "Enter Inspect", "x Stop", "Esc Close", "? More"]);
    const shown = Arr.join(keyHintRows(hint, 20), " ");
    for (const pair of ["↑↓ Move", "Enter Inspect", "x Stop", "Esc Close", "? More"])
      expect(shown).toContain(pair);
  });

  it("keeps every default hint when help expands", () => {
    const bar = {
      hints: ["↑↓ Move", "Enter Inspect"],
      more: ["j/k Move"],
      exit: "top" as const,
      exitAliases: ["q"],
    };
    const collapsed = hintPairs(keyHintBar(bar, false));
    const expanded = hintPairs(keyHintBar(bar, true));
    // Every default pair keeps its keys under the same verb, and aliases join it as one pair;
    // only the help toggle changes its verb.
    for (const pair of Arr.filter(collapsed, (entry) => entry.keys !== "?"))
      expect(
        Arr.some(
          expanded,
          (shown) => shown.verb === pair.verb && Fn.pipe(shown.keys, Str.includes(pair.keys)),
        ),
      ).toBe(true);
    const verbs = Arr.map(expanded, (pair) => pair.verb);
    expect(Arr.dedupe(verbs)).toEqual(verbs);
    expect(
      Arr.some(expanded, (pair) => pair.verb === "Move" && Fn.pipe(pair.keys, Str.includes("j/k"))),
    ).toBe(true);
    expect(
      Arr.some(expanded, (pair) => pair.verb === "Close" && Fn.pipe(pair.keys, Str.includes("q"))),
    ).toBe(true);
  });

  it("merges a more pair that names the exit's verb into the exit", () => {
    const expanded = keyHintBar(
      { hints: ["↑↓ Move"], more: ["q Close", "h Back"], exit: "top", exitAliases: ["C-c"] },
      true,
    );
    const closes = Arr.filter(Str.split(expanded, " · "), Str.endsWith(" Close"));
    expect(closes).toHaveLength(1);
    expect(closes[0]).toContain("C-c");
    expect(closes[0]).toContain("q");
  });

  it("keeps the exit in a framed border and every other pair above it at any width", () => {
    const hints = ["↑↓ Move", "Enter Open", "Tab Saved profiles", "m Model", "a Manage"];
    const tail = ["Esc Close", "? More"];
    for (const inner of [30, 55, 178]) {
      const { border, overflow } = framedKeyHints(hints, tail, inner);
      expect(visibleWidth(border)).toBeLessThanOrEqual(inner);
      const shown = `${border} ${Arr.join(keyHintRows(overflow, inner), " ")}`;
      for (const pair of [...hints, ...tail]) expect(shown).toContain(pair);
      for (const pair of tail) expect(border).toContain(pair);
    }
  });

  it("names every exit alias in one pair and keeps it in the border while help is expanded", () => {
    const bar = {
      hints: ["↑↓ Scroll"],
      more: ["j/k Scroll", "PgUp/PgDn Page", "gg/G Ends"],
      exit: "top" as const,
      exitKey: "Esc",
      exitAliases: ["C-c", "q"],
    };
    for (const inner of [30, 55, 178]) {
      const { border, overflow } = framedKeyHintBar(bar, true, inner);
      expect(border).toContain("Esc/C-c/q Close");
      expect(border).toContain("? Less");
      const pairs = Arr.map(Str.split(`${Str.trim(border)} · ${overflow}`, " · "), Str.trim);
      expect(Arr.filter(pairs, Str.endsWith(" Close"))).toEqual(["Esc/C-c/q Close"]);
    }
  });

  it("wraps between pairs, never inside one", () => {
    const pairs = ["↑↓ Move", "Enter Change", "/ Filter", "PgUp/PgDn/C-u/C-d Page", "Esc Close"];
    const hint = joinKeyHints(pairs);
    for (const width of [10, 20, 30, 80]) {
      const wrapped = wrapKeyHints(hint, width);
      expect(Arr.join(wrapped, " · ")).toBe(hint);
      for (const row of wrapped)
        for (const part of Str.split(row, " · ")) expect(pairs).toContain(Fn.pipe(part, Str.trim));
    }
  });
});
