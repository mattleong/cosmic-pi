import { describe, expect, it } from "vitest";
import { decodeSubagentConfig, subagentConfigDecoder } from "../src/config/schema.ts";
import { resolveTestConfig as resolve } from "./fixtures/profile-settings-inspection.ts";

describe("writer workspace configuration", () => {
  it("defaults existing documents to shared checkout", () => {
    expect(resolve({ version: 6 }).writerWorkspaceMode).toBe("shared-checkout");
  });

  it("preserves an explicitly saved worktree preference", () => {
    expect(resolve({ version: 6, writerWorkspaceMode: "worktree" }).writerWorkspaceMode).toBe(
      "worktree",
    );
  });

  it("inherits the global preference and only honors trusted project overrides", () => {
    const global = { version: 6, writerWorkspaceMode: "shared-checkout" };
    const project = { version: 6, writerWorkspaceMode: "worktree" };
    expect(resolve(global).writerWorkspaceMode).toBe("shared-checkout");
    expect(resolve(global, { version: 6 }).writerWorkspaceMode).toBe("shared-checkout");
    expect(resolve(global, project).writerWorkspaceMode).toBe("worktree");
    expect(resolve(global, project, false).writerWorkspaceMode).toBe("shared-checkout");
  });

  it("reports malformed preferences without retaining their values", () => {
    const decoded = decodeSubagentConfig({ version: 6, writerWorkspaceMode: "private-value" });
    expect(decoded.file.writerWorkspaceMode).toBeUndefined();
    expect(decoded.diagnostics).toContain("config.writerWorkspaceMode");
    expect(JSON.stringify(decoded)).not.toContain("private-value");
  });
});

describe("workspace setup configuration", () => {
  const setup = { command: ["pnpm", "install", "--offline"], timeoutSeconds: 300 };

  it("takes a setup command only from a trusted project document", () => {
    expect(resolve({ version: 6 }, { version: 6, workspaceSetup: setup }).workspaceSetup).toEqual(
      setup,
    );
    expect(
      resolve({ version: 6 }, { version: 6, workspaceSetup: setup }, false).workspaceSetup,
    ).toBeUndefined();
  });

  it("rejects a global setup command and malformed project commands", () => {
    expect(
      subagentConfigDecoder("global")({ version: 6, workspaceSetup: setup }).diagnostics,
    ).toContain("global.workspaceSetup");
    for (const workspaceSetup of [
      { command: [] },
      { command: "pnpm install" },
      { command: ["pnpm"], timeoutSeconds: 0 },
      { command: ["pnpm"], shell: true },
    ])
      expect(
        subagentConfigDecoder("project")({ version: 6, workspaceSetup }).diagnostics,
      ).toContain("project.workspaceSetup");
  });
});
