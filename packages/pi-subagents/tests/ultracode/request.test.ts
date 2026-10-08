import { describe, expect, it } from "@effect/vitest";
import {
  carriesUltracodeRequest,
  parseUltracodeRequest,
  ultracodeRequestMessage,
} from "../../src/ultracode/request.ts";

describe("/ultracode budget prefix", () => {
  it.each([
    ["+500k review the parser", 500_000, "review the parser"],
    ["+1.5m migrate the store", 1_500_000, "migrate the store"],
    ["+200000 fix the flake", 200_000, "fix the flake"],
    ["+1.1k tidy", 1_100, "tidy"],
    ["+2M audit", 2_000_000, "audit"],
    ["  +750k\tsplit the module  ", 750_000, "split the module"],
  ])("reads %j as a budget and a task", (args, budget, task) => {
    expect(parseUltracodeRequest(args)).toEqual({ task, budget });
  });

  it.each([
    "+500kb fix the flake",
    "+abc fix the flake",
    "+ 500k fix the flake",
    "+0k fix the flake",
    "+1.5 fix the flake",
    "+1.2345k fix the flake",
    "+-5k fix the flake",
    "+500k,fix the flake",
    "fix the flake +500k",
  ])("keeps %j whole as the task", (args) => {
    expect(parseUltracodeRequest(args)).toEqual({ task: args.trim() });
  });

  it("leaves no task when the request is only a budget", () => {
    expect(parseUltracodeRequest("+500k")).toEqual({ task: "", budget: 500_000 });
  });
});

describe("/ultracode request message", () => {
  it("carries the task, the authoring guide and any budget", () => {
    const guide = "/guides/workflow-authoring/SKILL.md";
    const plain = ultracodeRequestMessage({ task: "review the parser" }, guide);
    expect(plain.startsWith("review the parser")).toBe(true);
    expect(plain).toContain(guide);
    expect(plain).not.toMatch(/budget/iu);

    const budgeted = ultracodeRequestMessage({ task: "review the parser", budget: 500_000 }, guide);
    expect(budgeted).toContain("budget: 500000");
  });

  it("is recognized in the prompt it becomes, and other prompts aren't", () => {
    const message = ultracodeRequestMessage({ task: "review the parser" }, "/guide.md");
    expect(carriesUltracodeRequest(message)).toBe(true);
    expect(carriesUltracodeRequest(`Context from an input handler\n${message}`)).toBe(true);
    expect(carriesUltracodeRequest("review the parser")).toBe(false);
  });
});
