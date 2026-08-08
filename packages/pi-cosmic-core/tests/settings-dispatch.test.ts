import { describe, expect, it } from "vitest";
import { dispatchSettingsCommand } from "../src/settings-dispatch.ts";

const descriptors = [
  { id: "usage.enabled", values: ["true", "false"] },
  { id: "footer.mode", values: ["replace", "status", "off"] },
  { id: "image.outputDirectory" },
] as const;

const dispatch = (args: string) => dispatchSettingsCommand(args, descriptors);

describe("dispatchSettingsCommand", () => {
  it("opens the interactive surface for empty input only", () => {
    expect(dispatch("")).toEqual({ _tag: "OpenInteractive" });
    expect(dispatch("   ")).toEqual({ _tag: "OpenInteractive" });
  });

  it("reserves exactly the help and diagnostics verbs", () => {
    expect(dispatch("help")).toEqual({ _tag: "Help" });
    expect(dispatch(" diagnostics ")).toEqual({ _tag: "Diagnostics" });
  });

  it("treats the removed debug alias as an ordinary invalid setting", () => {
    expect(dispatch("debug")).toEqual({ _tag: "Invalid", reason: "missing-value", id: "debug" });
    expect(dispatch("debug now")).toEqual({
      _tag: "Invalid",
      reason: "unknown-setting",
      id: "debug",
    });
  });

  it("applies known ids with exact finite values", () => {
    expect(dispatch("usage.enabled true")).toEqual({
      _tag: "Apply",
      id: "usage.enabled",
      value: "true",
    });
    expect(dispatch("  footer.mode   status ")).toEqual({
      _tag: "Apply",
      id: "footer.mode",
      value: "status",
    });
  });

  it("applies free-form values for descriptors without finite values", () => {
    expect(dispatch("image.outputDirectory ./out dir")).toEqual({
      _tag: "Apply",
      id: "image.outputDirectory",
      value: "./out dir",
    });
  });

  it("rejects unknown ids, missing values, and out-of-set values", () => {
    expect(dispatch("nope true")).toEqual({
      _tag: "Invalid",
      reason: "unknown-setting",
      id: "nope",
    });
    expect(dispatch("usage.enabled")).toEqual({
      _tag: "Invalid",
      reason: "missing-value",
      id: "usage.enabled",
    });
    expect(dispatch("usage.enabled TRUE")).toEqual({
      _tag: "Invalid",
      reason: "invalid-value",
      id: "usage.enabled",
      value: "TRUE",
      allowedValues: ["true", "false"],
    });
  });
});
