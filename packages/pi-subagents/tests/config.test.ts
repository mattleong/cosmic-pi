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

describe("nesting configuration", () => {
  it("merges each declared field over the scope below it", () => {
    const global = { version: 6, nesting: { maxDepth: 5 } };
    const project = { version: 6, nesting: { maxActiveRuns: 8 } };
    expect(resolve(global, project).nesting).toEqual({
      maxDirectChildren: 12,
      maxDepth: 5,
      maxActiveRuns: 8,
    });
    expect(resolve(global, project, false).nesting).toEqual({
      maxDirectChildren: 12,
      maxDepth: 5,
      maxActiveRuns: 16,
    });
  });

  it("fails an invalid nesting limit closed with a diagnostic", () => {
    for (const [nesting, expected, diagnostics] of [
      // A fraction is floored.
      [{ maxActiveRuns: 2.5 }, { maxActiveRuns: 2 }, ["global.nesting.maxActiveRuns"]],
      // A value that isn't a number takes the field's most restrictive bound.
      [
        { maxDepth: "2", maxActiveRuns: 8 },
        { maxDepth: 0, maxActiveRuns: 8 },
        ["global.nesting.maxDepth"],
      ],
      [{ maxDirectChildren: null }, { maxDirectChildren: 1 }, ["global.nesting.maxDirectChildren"]],
      ["deep", { maxDirectChildren: 1, maxDepth: 0, maxActiveRuns: 1 }, ["global.nesting"]],
      // An unknown key is ignored.
      [{ maxActiveRuns: 8, depth: 2 }, { maxActiveRuns: 8 }, ["global.nesting.<unknown>"]],
    ] as const) {
      const config = resolve({ version: 6, nesting });
      expect(config.nesting).toEqual({
        maxDirectChildren: 12,
        maxDepth: 3,
        maxActiveRuns: 16,
        ...expected,
      });
      expect(config.diagnostics).toEqual(diagnostics);
    }
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
      invalidWorktreeCreate: [],
    });
    expect(resolve(global, project, false).hooks).toEqual({
      WorktreeCreate: [{ ...install, scope: "global" }],
      WorktreeRemove: [],
      invalidWorktreeCreate: [],
    });
    expect(resolve({ version: 6 }).hooks).toEqual({
      WorktreeCreate: [],
      WorktreeRemove: [],
      invalidWorktreeCreate: [],
    });
  });

  const malformedHooks = [
    { command: [] },
    { command: "pnpm install" },
    { command: ["pnpm", " "] },
    { command: ["pnpm"], shell: true },
    { command: ["pnpm"], timeout: "300" },
    { command: ["pnpm"], timeout: null },
    "pnpm install",
  ];

  it("drops a malformed WorktreeRemove hook while keeping the valid hooks beside it", () => {
    for (const scope of ["global", "project"])
      for (const hook of malformedHooks) {
        const decoded = subagentConfigDecoder(scope)({
          version: 6,
          hooks: { WorktreeRemove: [hook, prune] },
        });
        expect(decoded.file.hooks).toEqual({ WorktreeRemove: [prune] });
        expect(decoded.diagnostics).toContain(`${scope}.hooks.WorktreeRemove[0]`);
        expect(decoded.invalidWorktreeCreate).toEqual([]);
      }
  });

  it("blocks WorktreeCreate setup on any malformed declaration", () => {
    for (const scope of ["global", "project"])
      for (const hook of malformedHooks) {
        const decoded = subagentConfigDecoder(scope)({
          version: 6,
          hooks: { WorktreeCreate: [install, hook] },
        });
        expect(decoded.invalidWorktreeCreate).toEqual([`${scope}.hooks.WorktreeCreate[1]`]);
        expect(decoded.diagnostics).toContain(`${scope}.hooks.WorktreeCreate[1]`);
      }
    for (const [hooks, invalid] of [
      ["pnpm install", "global.hooks"],
      [{ WorktreeCreate: install }, "global.hooks.WorktreeCreate"],
      [
        { WorktreeCreate: Array.from({ length: 17 }, () => install) },
        "global.hooks.WorktreeCreate[16+]",
      ],
    ] as const) {
      const decoded = subagentConfigDecoder("global")({ version: 6, hooks });
      expect(decoded.invalidWorktreeCreate).toEqual([invalid]);
      expect(decoded.diagnostics).toEqual([invalid]);
    }
  });

  it("ignores unknown events and an invalid WorktreeRemove list without blocking setup", () => {
    for (const [hooks, diagnostic] of [
      [{ PostToolUse: [install], WorktreeCreate: [install] }, "global.hooks.<unknown>"],
      [{ WorktreeRemove: prune, WorktreeCreate: [install] }, "global.hooks.WorktreeRemove"],
    ] as const) {
      const decoded = subagentConfigDecoder("global")({ version: 6, hooks });
      expect(decoded.file.hooks).toEqual({ WorktreeCreate: [install] });
      expect(decoded.invalidWorktreeCreate).toEqual([]);
      expect(decoded.diagnostics).toEqual([diagnostic]);
    }
  });

  it("floors a fractional hook timeout", () => {
    const decoded = subagentConfigDecoder("global")({
      version: 6,
      hooks: { WorktreeCreate: [{ command: ["pnpm"], timeout: 299.9 }] },
    });
    expect(decoded.file.hooks).toEqual({ WorktreeCreate: [{ command: ["pnpm"], timeout: 299 }] });
    expect(decoded.invalidWorktreeCreate).toEqual([]);
    expect(decoded.diagnostics).toEqual(["global.hooks.WorktreeCreate[0].timeout"]);
  });

  it("reports the removed workspace command and include fields as unknown", () => {
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
