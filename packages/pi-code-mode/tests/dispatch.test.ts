import { describe, expect, it } from "vitest";
import { dispatchCodeModeSettings } from "../src/settings/dispatch.ts";

const IDS = ["enabled", "timeoutMs"];

describe("code mode settings dispatch", () => {
  it("opens the interactive surface for empty arguments", () => {
    expect(dispatchCodeModeSettings("", IDS)).toEqual({ _tag: "OpenInteractive" });
    expect(dispatchCodeModeSettings("   ", IDS)).toEqual({ _tag: "OpenInteractive" });
  });

  it("reserves help and status verbs", () => {
    expect(dispatchCodeModeSettings("help", IDS)).toEqual({ _tag: "Help" });
    expect(dispatchCodeModeSettings("status", IDS)).toEqual({ _tag: "Status" });
    expect(dispatchCodeModeSettings("diagnostics", IDS)).toEqual({ _tag: "Status" });
  });

  it("defaults to the global scope and honors explicit scopes", () => {
    expect(dispatchCodeModeSettings("enabled false", IDS)).toEqual({
      _tag: "Apply",
      scope: "global",
      id: "enabled",
      value: "false",
    });
    expect(dispatchCodeModeSettings("global timeoutMs 60000", IDS)).toEqual({
      _tag: "Apply",
      scope: "global",
      id: "timeoutMs",
      value: "60000",
    });
    expect(dispatchCodeModeSettings("project enabled true", IDS)).toEqual({
      _tag: "Apply",
      scope: "project",
      id: "enabled",
      value: "true",
    });
  });

  it("maps the inherit literal to a scoped clear", () => {
    expect(dispatchCodeModeSettings("project timeoutMs inherit", IDS)).toEqual({
      _tag: "Clear",
      scope: "project",
      id: "timeoutMs",
    });
    expect(dispatchCodeModeSettings("enabled inherit", IDS)).toEqual({
      _tag: "Clear",
      scope: "global",
      id: "enabled",
    });
  });

  it("rejects unknown settings and missing values", () => {
    expect(dispatchCodeModeSettings("nope true", IDS)).toEqual({
      _tag: "Invalid",
      reason: "unknown-setting",
      id: "nope",
    });
    expect(dispatchCodeModeSettings("enabled", IDS)).toEqual({
      _tag: "Invalid",
      reason: "missing-value",
      id: "enabled",
    });
    expect(dispatchCodeModeSettings("project", IDS)).toEqual({
      _tag: "Invalid",
      reason: "missing-value",
      id: "project",
    });
  });
});
