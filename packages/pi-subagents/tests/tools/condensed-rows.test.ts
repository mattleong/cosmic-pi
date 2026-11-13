import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { applyPresentationSettings, createToolPresentationHarness } from "pi-code-previews/testing";
import { stripAnsi } from "pi-cosmic-core";
import { plainTheme } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import type { SubagentRunView } from "../../src/run/model.ts";
import { projectSubagentRunCard } from "../../src/tools/details-projection.ts";
import type { CompactSubagentToolDetails } from "../../src/tools/details-schema.ts";
import { SUBAGENT_CARD_DETAILS_VERSION } from "../../src/tools/details-schema.ts";
import { awaitDetails } from "../../src/tools/details.ts";
import { formatAwaitCounters } from "../../src/tools/render-await.ts";
import { renderProfileRoutesComponent } from "../../src/tools/render-management.ts";
import { renderOnlyTool, view } from "./fixtures/tool-harness.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 84_000, cost: 0.61 };
const card = (overrides: Partial<SubagentRunView>) => projectSubagentRunCard(view(overrides));
const plain = (lines: ReadonlyArray<string>) => stripAnsi(Arr.join(lines, "\n"));

const hierarchy = (ids: ReadonlyArray<string>) => ({ awaitedRunIds: new Set(ids) });
const compactHeading = { compact: true, counted: true };
const linesWith = (lines: ReadonlyArray<string>, text: string) =>
  Arr.filter(lines, Str.includes(text)).length;

const candidate = (context: "fresh" | "fork", model: string) => ({
  model,
  effort: "high" as const,
  context,
  writeIntent: "read-only" as const,
  openaiFastMode: false,
  status: "eligible" as const,
  reason: "Eligible.",
});

describe("await body totals", () => {
  it("leave a single awaited run's counts to its row and keep its usage and descendants", () => {
    const cards = [
      card({ id: "a", state: "completed", usage }),
      card({ id: "child", parentRunId: "a", state: "running" }),
    ];
    const settled = formatAwaitCounters(cards, hierarchy(["a"]), "all_finished", {
      settled: true,
    });
    expect(settled).not.toContain("finished");
    expect(settled).toContain("84k tokens");
    expect(settled).toContain("1 descendant");
  });

  it("keep a running single run's state where its progress rows are a tree", () => {
    const cards = [card({ id: "a", state: "running" })];
    const preview = formatAwaitCounters(cards, hierarchy(["a"]), "all_finished");
    expect(preview).toContain("1 running");
    expect(preview).not.toContain("0/1");
    // A compact heading's spinner states it, though its `running` counter is left out as the glyph's word.
    expect(
      formatAwaitCounters(cards, hierarchy(["a"]), "all_finished", {
        heading: { compact: true, counted: false },
      }),
    ).toBe("");
  });

  it("leave a compact heading's counts out and keep every count under a preview heading", () => {
    const cards = [
      card({ id: "a", state: "completed" }),
      card({ id: "b", state: "failed" }),
      card({ id: "c", state: "running" }),
    ];
    const ids = hierarchy(["a", "b", "c"]);
    const compact = formatAwaitCounters(cards, ids, "all_finished", { heading: compactHeading });
    // Too narrow for its counter, a compact heading leaves every count to the body.
    const narrow = formatAwaitCounters(cards, ids, "all_finished", {
      heading: { compact: true, counted: false },
    });
    expect(narrow).toContain("1/3 finished");
    expect(narrow).toContain("1 failed");
    expect(compact).not.toContain("1/3 finished");
    expect(compact).not.toContain("failed");
    expect(compact).toContain("1 running");
    const preview = formatAwaitCounters(cards, ids, "all_finished");
    expect(preview).toContain("1/3 finished");
    expect(preview).toContain("1 failed");
    expect(preview).toContain("1 running");
  });

  it("keep the counts an expanded compact heading too narrow for its counter leaves out", () => {
    applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false });
    const tool = renderOnlyTool("agent_await");
    const expandedAt = (width: number) => {
      const harness = createToolPresentationHarness(tool);
      harness.call({ runIds: ["agent-1", "agent-2"] }, { expanded: true });
      harness.result(
        {
          content: [{ type: "text", text: "done" }],
          details: awaitDetails({
            runs: [
              view({ id: "agent-1", name: "auth-review", state: "failed" }),
              view({ id: "agent-2", name: "docs-sweep", state: "completed" }),
            ],
            awaitedRunIds: ["agent-1", "agent-2"],
            awaitUntil: "all_finished",
          }),
        },
        { expanded: true },
      );
      return Arr.map(harness.render(width), (line) => Str.trimEnd(stripAnsi(line)));
    };
    // Wide enough, the heading counts and the body doesn't repeat it.
    const wide = expandedAt(100);
    expect(linesWith(wide, "1/2 finished")).toBe(1);
    expect(linesWith(wide, "1 failed")).toBe(1);
    // Too narrow for the heading's counter, the body keeps every count.
    const narrow = expandedAt(40);
    expect(narrow[1]).not.toContain("finished");
    expect(linesWith(narrow, "1/2 finished")).toBe(1);
    expect(linesWith(narrow, "1 failed")).toBe(1);
  });

  it("keep the first run to finish", () => {
    const cards = [
      card({ id: "a", name: "first-run", state: "completed", endedAt: 2 }),
      card({ id: "b", state: "running" }),
    ];
    expect(
      formatAwaitCounters(cards, hierarchy(["a", "b"]), "any_finished", {
        settled: true,
        heading: compactHeading,
      }),
    ).toContain("first-run");
  });
});

describe("profile route candidates", () => {
  const details = {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: "models",
    fallbackProfile: "generalist",
    profiles: [
      {
        id: "reviewer",
        description: "Reviews changes.",
        source: "builtin",
        isDefault: true,
        defaultContext: "fresh",
        defaultWriteIntent: "read-only",
        candidates: [
          candidate("fresh", "openai-codex/default-model"),
          candidate("fork", "openai-codex/forked-model"),
        ],
      },
    ],
  } satisfies CompactSubagentToolDetails;

  it("state context and write intent only where they differ from the profile's defaults", () => {
    const text = plain(renderProfileRoutesComponent(details, true, plainTheme).render(120));
    const line = (model: string) =>
      Option.getOrElse(
        Arr.findFirst(Str.split(text, "\n"), (row) => Fn.pipe(row, Str.includes(model))),
        () => "",
      );
    expect(text).toContain("defaults fresh · read-only");
    const same = line("1. openai-codex/default-model");
    expect(same).not.toContain("fresh");
    expect(same).not.toContain("read-only");
    const forked = line("2. openai-codex/forked-model");
    expect(forked).toContain("fork");
    expect(forked).not.toContain("read-only");
  });

  const agentRoutes = (
    agent: Partial<{ readonly context: "fresh" | "fork"; readonly writeIntent: "writer" }>,
  ) => {
    const text = plain(
      renderProfileRoutesComponent(
        {
          ...details,
          agents: [
            {
              name: "auth-reviewer",
              description: "Reviews auth changes.",
              profile: "reviewer",
              source: "global",
              ...agent,
              candidates: [
                candidate("fresh", "openai-codex/agent-model"),
                candidate("fresh", "openai-codex/agent-backup"),
                candidate("fork", "openai-codex/agent-forked"),
              ],
            },
          ],
        },
        true,
        plainTheme,
      ).render(160),
    );
    return (start: string) =>
      Option.getOrElse(
        Arr.findFirst(Str.split(text, "\n"), (row) =>
          Fn.pipe(Str.trim(row), Str.startsWith(start)),
        ),
        () => "",
      );
  };

  it("state a custom agent's context and write intent once, keeping a candidate that differs", () => {
    const line = agentRoutes({});
    // The agent states nothing, so its line states what its first candidate uses.
    expect(line("auth-reviewer:")).toContain("fresh · read-only");
    for (const model of ["1. openai-codex/agent-model", "2. openai-codex/agent-backup"]) {
      expect(line(model)).not.toContain("fresh");
      expect(line(model)).not.toContain("read-only");
    }
    expect(line("3. openai-codex/agent-forked")).toContain("fork");
  });

  it("compare a custom agent's candidates with what its definition states", () => {
    const line = agentRoutes({ context: "fork", writeIntent: "writer" });
    expect(line("auth-reviewer:")).toContain("fork · writer");
    expect(line("1. openai-codex/agent-model")).toContain("fresh · read-only");
    expect(line("3. openai-codex/agent-forked")).not.toContain("· fork");
    expect(line("3. openai-codex/agent-forked")).toContain("read-only");
  });
});
