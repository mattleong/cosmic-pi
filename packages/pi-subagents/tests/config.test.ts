import { describe, expect, it } from "vitest";
import { subagentConfigDecoder } from "../src/config/schema.ts";
import { resolveTestConfig as resolve } from "./fixtures/profile-settings-inspection.ts";

describe("writer workspace configuration", () => {
  it("inherits the global preference and only honors trusted project overrides", () => {
    const global = { version: 6, writerWorkspaceMode: "shared-checkout" };
    const project = { version: 6, writerWorkspaceMode: "worktree" };
    expect(resolve(global).writerWorkspaceMode).toBe("shared-checkout");
    expect(resolve(global, { version: 6 }).writerWorkspaceMode).toBe("shared-checkout");
    expect(resolve(global, project).writerWorkspaceMode).toBe("worktree");
    expect(resolve(global, project, false).writerWorkspaceMode).toBe("shared-checkout");
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

describe("workspace verification configuration", () => {
  const verify = { command: ["pnpm", "validate"], timeoutSeconds: 900 };

  it("takes a verification command only from a trusted project document", () => {
    const project = { version: 6, workspaceSetup: { command: ["pnpm", "install"] } };
    expect(resolve({ version: 6 }, project).workspaceVerify).toBeUndefined();
    expect(
      resolve({ version: 6 }, { ...project, workspaceVerify: verify }).workspaceVerify,
    ).toEqual(verify);
    expect(
      resolve({ version: 6 }, { version: 6, workspaceVerify: verify }, false).workspaceVerify,
    ).toBeUndefined();
  });

  it("rejects a global verification command and malformed project commands", () => {
    expect(
      subagentConfigDecoder("global")({ version: 6, workspaceVerify: verify }).diagnostics,
    ).toContain("global.workspaceVerify");
    for (const workspaceVerify of [
      { command: [] },
      { command: ["pnpm", " "] },
      { command: "pnpm test" },
      { command: ["pnpm"], timeoutSeconds: 0 },
      { command: ["pnpm"], timeoutSeconds: 3_601 },
      { command: ["pnpm"], timeoutSeconds: 1.5 },
      { command: ["pnpm"], shell: true },
    ])
      expect(
        subagentConfigDecoder("project")({ version: 6, workspaceVerify }).diagnostics,
      ).toContain("project.workspaceVerify");
  });
});
