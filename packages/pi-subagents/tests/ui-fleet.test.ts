// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SubagentProjection } from "../src/run/model.ts";
import { SubagentFleetComponent } from "../src/ui/fleet.ts";

// SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const projection: SubagentProjection = {
  revision: 1,
  runs: [
    {
      id: "agent-1",
      name: "auth-reader",
      task: "Review authentication",
      selection: {
        source: "profile-candidate",
        reason: "Profile model selection.",
        skippedCandidates: [],
      },
      cwd: "/project",
      state: "waiting_for_parent",
      context: "fresh",
      writeIntent: "read-only",
      fastMode: false,
      host: "local",
      runtime: "pi",
      closeOnReport: true,
      reportGeneration: 0,
      capabilities: [
        "steer",
        "interrupt",
        "resume",
        "rename-display",
        "parent-contact",
        "peer-notice",
        "native-fork",
      ],
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
      startedAt: 1,
      lastActivityAt: 2,
      question: { requestId: "q-1", message: "Which API?", createdAt: 2 },
      sessionEvents: [
        {
          type: "tool",
          toolCallId: "tool-1",
          toolName: "read",
          target: `${"nested/path/".repeat(12)}auth.ts`,
          state: "completed",
          startedAt: 1,
          endedAt: 2,
        },
        { type: "assistant", text: "This duplicate event should stay hidden.", createdAt: 2 },
      ],
      finalText: "## Answer\n\nViewport-safe result.",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: 0.001 },
    },
  ],
};
const completedProjection: SubagentProjection = {
  revision: 2,
  runs: [
    {
      ...projection.runs[0]!,
      state: "completed",
      endedAt: 2_000,
      lastActivityAt: 2_000,
      question: undefined,
    },
  ],
};

const makeComponent = (
  width: number,
  height: number,
  currentProjection: SubagentProjection = projection,
  getNow: () => number = () => 20_000,
  currentTheme: Theme = theme,
  matchesKeybinding?: (data: string, id: string) => boolean,
) => {
  const actions = {
    stop: vi.fn(() => Promise.resolve()),
    interrupt: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    message: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
  };
  const close = vi.fn();
  const component = new SubagentFleetComponent(
    (() => {
      const objectPart2897_0 = {
        theme: currentTheme,
        getProjection: () => currentProjection,
        getHeight: () => height,
        getNow,
      };
      const objectPart2897_1 = matchesKeybinding
        ? { ...objectPart2897_0, matchesKeybinding }
        : objectPart2897_0;
      const objectPart2897_2 = { ...objectPart2897_1, requestRender: vi.fn(), close, actions };
      return objectPart2897_2;
    })(),
  );
  return { actions, close, lines: component.render(width), component };
};

describe("/subagents fleet UI", () => {
  beforeAll(() => initTheme("dark", false));

  it.each([
    [120, 24],
    [80, 18],
    [42, 12],
  ])("renders width-safe responsive output at %sx%s", (width, height) => {
    const { lines } = makeComponent(width, height);
    expect(lines).toHaveLength(height);
    expect(lines.join("\n")).toContain("auth-reader");
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("colors outer borders and panel dividers with theme border colors", () => {
    const fg = vi.fn((_color: string, text: string) => text);
    const themeFixture = { fg, bold: (text: string) => text };
    // SAFETY: This fleet test invokes only fg and bold on the theme fixture.
    const currentTheme = themeFixture as typeof themeFixture & Theme;
    const { component } = makeComponent(120, 24, projection, () => 20_000, currentTheme);
    component.render(80);

    const accentChrome = fg.mock.calls
      .filter(([color]) => color === "borderAccent")
      .map(([, text]) => text)
      .join("");
    const mutedChrome = fg.mock.calls
      .filter(([color]) => color === "borderMuted")
      .map(([, text]) => text)
      .join("");

    expect(accentChrome).toContain("╭");
    expect(accentChrome).toContain("╮");
    expect(accentChrome).toContain("╰");
    expect(accentChrome).toContain("╯");
    expect(accentChrome).toContain("│");
    expect(accentChrome).toContain("├");
    expect(accentChrome).toContain("┤");
    expect(mutedChrome).toContain("│");
    expect(mutedChrome).toContain("─");
  });

  it("does not double-count waiting runs as active work in the fleet title", () => {
    const title = makeComponent(80, 18).lines[0] ?? "";
    expect(title).toContain("1 run · 1 waiting");
    expect(title).not.toContain("active");
    expect(title).not.toContain("working");
  });

  it("groups navigation, available actions, and global footer controls", () => {
    const footer = makeComponent(120, 18).lines.at(-1) ?? "";
    expect(footer).toContain("j/k");
    expect(footer).toContain("C-u/d");
    expect(footer).not.toContain("PgUp/PgDn");
    expect(footer).toContain("m Reply · i Int");
    expect(footer).toContain("? More · Esc/q");
    expect(footer).not.toContain("r Resume");
  });

  it("mentions PgUp/PgDn paging in the expanded ? help while collapsed help stays compact", () => {
    const { component } = makeComponent(120, 18);
    expect(component.render(120).at(-1) ?? "").not.toContain("PgUp/PgDn");
    component.handleInput("?");
    const expanded = component.render(120).at(-1) ?? "";
    expect(expanded).toContain("C-u/d Half");
    expect(expanded).toContain("PgUp/PgDn Page");
    expect(expanded).toContain("? Back");
    component.handleInput("?");
    expect(component.render(120).at(-1) ?? "").not.toContain("PgUp/PgDn");
  });

  it("mentions PgUp/PgDn detail paging in the expanded ? help of the detail pane", () => {
    const { component } = makeComponent(120, 18);
    component.handleInput("l");
    component.handleInput("?");
    expect(component.render(120).at(-1) ?? "").toContain("PgUp/PgDn Detail");
  });

  it("does not advertise unreachable alternate help when the fleet is empty", () => {
    const empty: SubagentProjection = { revision: 3, runs: [] };
    const { component } = makeComponent(80, 18, empty);
    const footer = component.render(80).at(-1) ?? "";
    expect(footer).toContain("No runs");
    expect(footer).toContain("Esc/q Close");
    expect(footer).not.toContain("? More");
  });

  it("shows completion age in fleet rows", () => {
    const { lines } = makeComponent(80, 18, completedProjection);
    expect(lines.join("\n")).toContain("finished 18s ago");
  });

  it("renders retained reports as finished assignments with live guidance and stop controls", () => {
    const retained: SubagentProjection = {
      revision: 3,
      runs: [
        {
          ...projection.runs[0]!,
          state: "reported",
          closeOnReport: false,
          reportGeneration: 2,
          endedAt: 2_000,
          question: undefined,
          finalText: "Second retained report.",
        },
      ],
    };
    const { actions, component } = makeComponent(120, 18, retained);
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("report 2 · retained");
    expect(rendered).toContain("Report generation 2 · backend retained");
    expect(rendered).toContain("Second retained report.");
    expect(rendered).toContain("1 retained");
    expect(component.render(120).at(-1)).toContain("m New task");
    expect(component.render(120).at(-1)).toContain("x Stop");
    expect(component.render(120).at(-1)).not.toContain("r Resume");
    component.handleInput("m");
    expect(component.render(120).join("\n")).toContain("Next assignment for auth-reader");
    component.handleInput("Review the next area");
    component.handleInput("\r");
    expect(actions.message).toHaveBeenCalledWith(
      "agent-1",
      "next-assignment",
      "Review the next area",
    );
  });

  it("uses the shared Braille spinner for running fleet rows", () => {
    const running: SubagentProjection = {
      revision: 3,
      runs: [{ ...projection.runs[0]!, state: "running", question: undefined }],
    };
    expect(makeComponent(80, 18, running, () => 0).lines.join("\n")).toContain("⠋ auth-reader");
    expect(makeComponent(80, 18, running, () => 320).lines.join("\n")).toContain("⠹ auth-reader");
  });

  it.each(["\r", "\n", "\u001b[13u"])("toggles narrow details with each Enter encoding", (key) => {
    const { component } = makeComponent(42, 24, completedProjection);
    component.handleInput(key);
    expect(component.render(42).join("\n")).toContain("Final report");
  });

  it("uses cancel as back from narrow details before closing the inspector", () => {
    const { close, component } = makeComponent(42, 24, completedProjection);
    component.handleInput("\r");
    expect(component.render(42).join("\n")).toContain("Final report");
    component.handleInput("\u001b");
    expect(component.render(42).join("\n")).not.toContain("Final report");
    expect(close).not.toHaveBeenCalled();
    component.handleInput("\u001b");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("supports gg/G endpoints, h/l panes, and q close", () => {
    const twoRuns: SubagentProjection = {
      revision: 4,
      runs: [projection.runs[0]!, { ...projection.runs[0]!, id: "agent-2", name: "second-reader" }],
    };
    const { close, component } = makeComponent(80, 18, twoRuns);
    component.handleInput("G");
    component.handleInput("x");
    expect(component.render(80).at(-1)).toContain("Confirm stop second-reader");
    component.handleInput("\u001b");
    component.handleInput("g");
    component.handleInput("g");
    component.handleInput("x");
    expect(component.render(80).at(-1)).toContain("Confirm stop auth-reader");
    component.handleInput("\u001b");
    component.handleInput("l");
    component.handleInput("h");
    component.handleInput("q");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("honors configured selection and cancel keybindings", () => {
    const bindings = new Map<string, string>([
      ["tui.select.confirm", "o"],
      ["tui.select.cancel", "q"],
      ["tui.select.down", "n"],
      ["tui.select.up", "p"],
    ]);
    const matcher = (data: string, id: string) => bindings.get(id) === data;
    const { close, component } = makeComponent(
      42,
      24,
      completedProjection,
      () => 20_000,
      theme,
      matcher,
    );
    component.handleInput("o");
    expect(component.render(42).join("\n")).toContain("Final report");
    component.handleInput("q");
    expect(component.render(42).join("\n")).not.toContain("Final report");
    component.handleInput("q");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("wraps structured narrow details without showing raw transcript duplicates", () => {
    const { component } = makeComponent(42, 24, completedProjection);
    component.handleInput("\r");
    const lines = component.render(42);
    const rendered = lines.join("\n");

    expect(rendered).toContain("Activity");
    expect(rendered).toContain("Viewport-safe result.");
    expect(rendered).not.toContain("duplicate event");
    expect(rendered).not.toContain("Need a decision");
    expect(lines.every((line) => visibleWidth(line) <= 42)).toBe(true);
  });

  it("scrolls detail output with ctrl+u and ctrl+d", () => {
    const { component } = makeComponent(42, 12, completedProjection);
    component.handleInput("\r");
    const bottom = component.render(42).join("\n");
    expect(bottom).toContain("of");
    expect(bottom).toContain("half-page");
    expect(bottom).toContain("Final report");

    component.handleInput("\u001b[5~");
    const paged = component.render(42).join("\n");
    expect(paged).not.toBe(bottom);
    component.handleInput("\u001b[6~");
    expect(component.render(42).join("\n")).toBe(bottom);

    component.handleInput("\u0015");
    const top = component.render(42).join("\n");
    expect(top).not.toBe(bottom);
    component.handleInput("\u0004");
    expect(component.render(42).join("\n")).toBe(bottom);
  });

  it("hides fleet run IDs until technical mode is enabled", () => {
    const { component } = makeComponent(80, 24);
    expect(component.render(80).join("\n")).not.toContain("agent-1");
    component.handleInput("t");
    expect(component.render(80).join("\n")).toContain("agent-1");
  });

  it("toggles technical details and responsive shortcut help", () => {
    const { component } = makeComponent(42, 24);
    component.handleInput("\r");
    expect(component.render(42).join("\n")).not.toContain("Technical details");
    component.handleInput("t");
    expect(component.render(42).join("\n")).toContain("Technical details");
    expect(component.render(42).at(-1)).toContain("? More");
    component.handleInput("?");
    expect(component.render(42).at(-1)).toContain("m Reply");
  });

  it.each([120, 80])("focuses the visible detail pane with Enter at width %s", (width) => {
    const { component } = makeComponent(width, 12, completedProjection);
    for (let index = 0; index < 20; index += 1) component.handleInput("\u0015");
    component.handleInput("\r");
    const rendered = component.render(width).join("\n");
    expect(rendered).toContain("Final report");
    expect(component.render(width).at(-1)).toContain("C-u/d Detail");
  });

  it("keeps stop confirmation modal and cancels before selection changes", () => {
    const twoRuns: SubagentProjection = {
      revision: 4,
      runs: [projection.runs[0]!, { ...projection.runs[0]!, id: "agent-2", name: "second-reader" }],
    };
    const { actions, component } = makeComponent(80, 18, twoRuns);
    component.handleInput("x");
    expect(component.render(80).at(-1)).toContain("Confirm stop auth-reader");
    component.handleInput("j");
    expect(component.render(80).join("\n")).toContain("Stop canceled");
    component.handleInput("j");
    component.handleInput("x");
    expect(actions.stop).not.toHaveBeenCalled();
    expect(component.render(80).at(-1)).toContain("Confirm stop second-reader");
  });

  it("shows only actions advertised by the run projection", () => {
    const limitedCapabilities: SubagentProjection = {
      revision: 5,
      runs: [
        {
          ...projection.runs[0]!,
          model: "anthropic/claude-opus-5",
          capabilities: ["resume", "rename-display"],
          state: "running",
          question: undefined,
        },
      ],
    };
    const running = makeComponent(120, 18, limitedCapabilities);
    const runningHelp = running.component.render(120).at(-1) ?? "";
    expect(runningHelp).toContain("n Rename");
    expect(runningHelp).toContain("x Stop");
    expect(runningHelp).not.toContain("m Message");
    expect(runningHelp).not.toContain("i Interrupt");
    running.component.handleInput("m");
    running.component.handleInput("i");
    expect(running.actions.message).not.toHaveBeenCalled();
    expect(running.actions.interrupt).not.toHaveBeenCalled();

    const completed = makeComponent(120, 18, {
      revision: 6,
      runs: [{ ...limitedCapabilities.runs[0]!, state: "completed", endedAt: 2_000 }],
    });
    const completedHelp = completed.component.render(120).at(-1) ?? "";
    expect(completedHelp).toContain("r Resume");
    expect(completedHelp).toContain("n Rename");
    expect(completedHelp).not.toContain("x Stop");
  });

  it.each(["paused", "stopping"] as const)(
    "does not offer messaging while a run is %s",
    (state) => {
      const currentProjection: SubagentProjection = {
        revision: 3,
        runs: [{ ...projection.runs[0]!, state, question: undefined }],
      };
      const { actions, component } = makeComponent(80, 18, currentProjection);
      component.handleInput("m");
      expect(actions.message).not.toHaveBeenCalled();
    },
  );

  it("allows completed rename but does not offer terminal stop", () => {
    const { actions, component } = makeComponent(80, 18, completedProjection);
    component.handleInput("n");
    expect(component.render(80).join("\n")).toContain("Rename auth-reader");
    component.handleInput("security-reader");
    component.handleInput("\r");
    expect(actions.rename).toHaveBeenCalledWith("agent-1", "security-reader");
    component.handleInput("x");
    component.handleInput("x");
    expect(actions.stop).not.toHaveBeenCalled();
  });

  it("labels running guidance separately from retained next assignments", () => {
    const runningProjection: SubagentProjection = {
      revision: 7,
      runs: [{ ...projection.runs[0]!, state: "running", question: undefined }],
    };
    const { actions, component } = makeComponent(100, 18, runningProjection);
    expect(component.render(100).at(-1)).toContain("m Guide");
    component.handleInput("m");
    component.handleInput("Check the fallback");
    component.handleInput("\r");
    expect(actions.message).toHaveBeenCalledWith("agent-1", "guidance", "Check the fallback");
  });

  it("accepts Kitty CSI-u printable action shortcuts", () => {
    const { component } = makeComponent(80, 18);
    component.handleInput("\u001b[109u");
    expect(component.render(80).join("\n")).toContain("Reply to auth-reader");
  });

  it("shows action failures inside the fleet instead of behind the overlay", async () => {
    const { actions, component } = makeComponent(80, 18);
    actions.interrupt.mockRejectedValueOnce(new Error("Interrupt channel unavailable"));
    component.handleInput("i");
    await Promise.resolve();
    await Promise.resolve();
    expect(component.render(80).join("\n")).toContain("Interrupt channel unavailable");
  });

  it("dismisses error notices on the next navigation key", async () => {
    const { actions, component } = makeComponent(80, 18);
    actions.interrupt.mockRejectedValueOnce(new Error("Interrupt channel unavailable"));
    component.handleInput("i");
    await Promise.resolve();
    await Promise.resolve();
    expect(component.render(80).join("\n")).toContain("Interrupt channel unavailable");
    component.handleInput("j");
    expect(component.render(80).join("\n")).not.toContain("Interrupt channel unavailable");
  });

  it("closes the overlay from a hung action with Esc or q without cancelling it", () => {
    const escape = String.fromCharCode(27);
    const { actions, close, component } = makeComponent(80, 18);
    actions.interrupt.mockReturnValueOnce(Effect.runPromise(Effect.never));
    component.handleInput("i");
    const footer = component.render(80).at(-1) ?? "";
    expect(footer).toContain("Interrupting");
    expect(footer).toContain("Esc/q Close");
    component.handleInput("j");
    component.handleInput("x");
    expect(close).not.toHaveBeenCalled();
    expect(actions.stop).not.toHaveBeenCalled();
    component.handleInput("q");
    expect(close).toHaveBeenCalledTimes(1);
    component.handleInput(escape);
    expect(close).toHaveBeenCalledTimes(2);
    // Closing never fabricates a cancellation; the operation is still in flight.
    expect(component.render(80).at(-1)).toContain("Interrupting");
  });

  it("pages the stacked run list by its rendered rows instead of the full height", () => {
    const pageDownKey = `${String.fromCharCode(27)}[6~`;
    const halfPageDownKey = String.fromCharCode(4);
    const runs = Array.from({ length: 20 }, (_, index) => ({
      ...projection.runs[0]!,
      id: `agent-${index}`,
      name: `reader-${index}`,
    }));
    const { component } = makeComponent(80, 18, { revision: 10, runs });
    component.handleInput(pageDownKey);
    const paged = component.render(80).join("\n");
    expect(paged).toMatch(/> . reader-5 /);
    component.handleInput(halfPageDownKey);
    expect(component.render(80).join("\n")).toMatch(/> . reader-7 /);
  });

  it("half-pages a narrow run list and shows list position cues", () => {
    const runs = Array.from({ length: 20 }, (_, index) => ({
      ...projection.runs[0]!,
      id: `agent-${index}`,
      name: `reader-${index}`,
    }));
    const { component } = makeComponent(42, 8, { revision: 8, runs });
    expect(component.render(42).join("\n")).toContain("↓ more");
    component.handleInput("\u0004");
    component.handleInput("\u0004");
    const rendered = component.render(42).join("\n");
    expect(rendered).toContain("reader-4");
    expect(rendered).toContain("↑ more");
  });

  it("disambiguates duplicate run names with IDs", () => {
    const duplicate: SubagentProjection = {
      revision: 9,
      runs: [projection.runs[0]!, { ...projection.runs[0]!, id: "agent-2" }],
    };
    const rendered = makeComponent(80, 18, duplicate).component.render(80).join("\n");
    expect(rendered).toContain("[agent-1] auth-reader");
    expect(rendered).toContain("[agent-2] auth-reader");
  });

  it("routes inline reply, interrupt, rename, and confirmed stop controls", async () => {
    const { actions, component } = makeComponent(80, 18);
    component.handleInput("m");
    expect(component.render(80).join("\n")).toContain("Question: Which API?");
    component.handleInput("Use v2");
    component.handleInput("\r");
    expect(actions.message).toHaveBeenCalledWith("agent-1", "reply", "Use v2");
    await Promise.resolve();
    component.handleInput("i");
    expect(actions.interrupt).toHaveBeenCalledWith("agent-1");
    await Promise.resolve();
    component.handleInput("n");
    component.handleInput("renamed-reader");
    component.handleInput("\r");
    expect(actions.rename).toHaveBeenCalledWith("agent-1", "renamed-reader");
    await Promise.resolve();
    component.handleInput("x");
    expect(actions.stop).not.toHaveBeenCalled();
    component.handleInput("\u001b[120;1:2u");
    expect(actions.stop).not.toHaveBeenCalled();
    component.handleInput("x");
    component.handleInput("x");
    expect(actions.stop).toHaveBeenCalledWith("agent-1");
  });
});
