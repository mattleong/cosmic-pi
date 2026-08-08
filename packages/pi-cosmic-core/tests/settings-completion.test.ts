import { describe, expect, it } from "vitest";
import { completeSettingsArguments } from "../src/settings-completion.ts";

const descriptors = [
  {
    id: "usage.enabled",
    description: "Fetch and display usage windows.",
    values: ["true", "false"],
  },
  {
    id: "usage.showResetTimes",
    description: "Include reset countdowns.",
    values: ["true", "false"],
  },
  {
    id: "footer.mode",
    description: "replace, status, or off.",
    values: ["replace", "status", "off"],
  },
] as const;

const extras = [
  { value: "help", label: "help", description: "Show setting ids and usage" },
  { value: "diagnostics", label: "diagnostics", description: "Show diagnostics" },
] as const;

const values = (prefix: string) =>
  completeSettingsArguments(prefix, descriptors, [...extras])?.map((entry) => entry.value) ?? null;

describe("completeSettingsArguments", () => {
  it("lists descriptors in order followed by the caller's extra verbs", () => {
    expect(values("")).toEqual([
      "usage.enabled",
      "usage.showResetTimes",
      "footer.mode",
      "help",
      "diagnostics",
    ]);
  });

  it("matches setting ids and extras case-insensitively by prefix", () => {
    expect(values("usage.s")).toEqual(["usage.showResetTimes"]);
    expect(values("FOOTER")).toEqual(["footer.mode"]);
    expect(values("HELP")).toEqual(["help"]);
  });

  it("completes finite values after an exact id, preserving value order and case rules", () => {
    expect(values("footer.mode ")).toEqual([
      "footer.mode replace",
      "footer.mode status",
      "footer.mode off",
    ]);
    expect(values("footer.mode re")).toEqual(["footer.mode replace"]);
    expect(values("usage.enabled T")).toEqual(["usage.enabled true"]);
  });

  it("labels and describes each completion", () => {
    const completions = completeSettingsArguments("footer.mode re", descriptors);
    expect(completions).toEqual([
      {
        value: "footer.mode replace",
        label: "footer.mode replace",
        description: "replace, status, or off.",
      },
    ]);
  });

  it("returns null, never an empty array, when nothing matches", () => {
    expect(values("zzz")).toBeNull();
    expect(values("unknown ")).toBeNull();
    expect(values("help ")).toBeNull();
    expect(completeSettingsArguments("usage.enabled zzz", descriptors)).toBeNull();
    expect(completeSettingsArguments("", [])).toBeNull();
  });

  it("treats descriptors without values as accepting no completions", () => {
    expect(
      completeSettingsArguments("plain ", [{ id: "plain", description: "No finite values." }]),
    ).toBeNull();
  });
});
