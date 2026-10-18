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

describe("worktree hook configuration", () => {
  const install = { command: ["pnpm", "install", "--offline"], timeout: 300 };
  const prune = { command: ["./scripts/prune-cache"] };
  const copy = { command: ["./scripts/copy-env"] };

  it("runs global hooks before a trusted project's and ignores an untrusted project's", () => {
    const global = { version: 6, hooks: { WorktreeCreate: [install] } };
    const project = { version: 6, hooks: { WorktreeCreate: [copy], WorktreeRemove: [prune] } };
    expect(resolve(global, project).hooks).toEqual({
      WorktreeCreate: [
        { ...install, scope: "global" },
        { ...copy, scope: "project" },
      ],
      WorktreeRemove: [{ ...prune, scope: "project" }],
    });
    expect(resolve(global, project, false).hooks).toEqual({
      WorktreeCreate: [{ ...install, scope: "global" }],
      WorktreeRemove: [],
    });
    expect(resolve({ version: 6 }).hooks).toEqual({ WorktreeCreate: [], WorktreeRemove: [] });
  });

  it("rejects unknown events, unknown keys, and malformed hooks in either scope", () => {
    for (const scope of ["global", "project"])
      for (const hooks of [
        { PostToolUse: [install] },
        { WorktreeCreate: install },
        { WorktreeCreate: [{ command: [] }] },
        { WorktreeCreate: [{ command: "pnpm install" }] },
        { WorktreeCreate: [{ command: ["pnpm", " "] }] },
        { WorktreeCreate: [{ command: ["pnpm"], timeout: 0 }] },
        { WorktreeCreate: [{ command: ["pnpm"], timeout: 3_601 }] },
        { WorktreeCreate: [{ command: ["pnpm"], timeout: 1.5 }] },
        { WorktreeRemove: [{ command: ["pnpm"], shell: true }] },
        { WorktreeCreate: Array.from({ length: 17 }, () => install) },
      ])
        expect(subagentConfigDecoder(scope)({ version: 6, hooks }).diagnostics).toContain(
          `${scope}.hooks`,
        );
  });

  it("rejects the removed workspace command and include fields", () => {
    for (const removed of [
      { workspaceSetup: { command: ["pnpm", "install"] } },
      { workspaceVerify: { command: ["pnpm", "test"] } },
      { workspaceInclude: [".env"] },
    ])
      expect(subagentConfigDecoder("project")({ version: 6, ...removed }).diagnostics).toContain(
        "project.<unknown>",
      );
  });
});
