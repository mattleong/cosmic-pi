// Ambient environment capture is a Node boundary invariant.
import { describe, expect, it } from "vitest";
import { captureHerdrEnvironment } from "../src/boundary/herdr-environment.ts";

describe("shared Herdr environment capture", () => {
  it("pins one bounded immutable source for both CLI and harness construction", () => {
    const pinned = {
      XDG_CONFIG_HOME: "/private/xdg-config-a",
      XDG_STATE_HOME: "/private/xdg-state-a",
      HERDR_SOCKET_PATH: "/private/herdr-a.sock",
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "workspace-a",
      HERDR_TAB_ID: "tab-a",
      HERDR_PANE_ID: "pane-a",
      PI_CODING_AGENT_DIR: "/private/pi-a",
      CLAUDE_CONFIG_DIR: "/private/claude-a",
      CODEX_HOME: "/private/codex-a",
      OPENAI_API_KEY: "private-key",
    };
    const source: NodeJS.ProcessEnv = {
      HOME: "/private/home",
      PATH: "/usr/bin:/bin",
      ...pinned,
      UNRELATED_SECRET: "must-not-cross",
    };
    const captured = captureHerdrEnvironment(source);

    source.HERDR_SOCKET_PATH = "/private/herdr-b.sock";
    source.HERDR_PANE_ID = "pane-b";
    source.PI_CODING_AGENT_DIR = "/private/pi-b";

    expect(Object.isFrozen(captured)).toBe(true);
    expect(captured).toMatchObject(pinned);
    expect(captured.UNRELATED_SECRET).toBeUndefined();
  });
});
