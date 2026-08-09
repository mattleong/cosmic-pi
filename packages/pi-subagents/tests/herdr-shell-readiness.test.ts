import { describe, expect, it } from "vitest";
import { hasAvailableHerdrShell } from "../src/backend/herdr-shell-readiness.ts";

const shell = (name = "zsh") => ({
  paneId: "w:p1",
  shellPid: 4242,
  foregroundProcessGroupId: 4242,
  foregroundProcesses: [{ pid: 4242, name }],
});

describe("Herdr pane shell readiness", () => {
  it("accepts a recognized interactive shell that exclusively owns the foreground", () => {
    expect(hasAvailableHerdrShell(shell("/bin/-zsh"))).toBe(true);
    expect(hasAvailableHerdrShell(shell("C:\\Program Files\\PowerShell\\pwsh.exe"))).toBe(true);
  });

  it("rejects a missing shell, foreground command, process group mismatch, or ambiguous process list", () => {
    expect(hasAvailableHerdrShell({ paneId: "w:p1", foregroundProcesses: [] })).toBe(false);
    expect(
      hasAvailableHerdrShell({ ...shell(), foregroundProcesses: [{ pid: 4242, name: "node" }] }),
    ).toBe(false);
    expect(hasAvailableHerdrShell({ ...shell(), foregroundProcessGroupId: 9999 })).toBe(false);
    expect(
      hasAvailableHerdrShell({
        ...shell(),
        foregroundProcesses: [
          { pid: 4242, name: "zsh" },
          { pid: 4243, name: "git" },
        ],
      }),
    ).toBe(false);
  });
});
