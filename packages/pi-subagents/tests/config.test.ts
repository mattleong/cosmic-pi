import { describe, expect, it } from "vitest";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { resolveTestConfig as resolve } from "./fixtures/profile-settings-inspection.ts";

describe("writer workspace configuration", () => {
  it.each([4, 5, 6])("defaults existing version %s documents to shared checkout", (version) => {
    expect(resolve({ version }).writerWorkspaceMode).toBe("shared-checkout");
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

describe("feature switch configuration", () => {
  it.each([4, 5, 6])("leaves ultracode off for version %s documents by default", (version) => {
    expect(resolve({ version })).toMatchObject({
      ultracode: false,
      featureSources: { ultracode: "default" },
    });
  });

  it("resolves ultracode with trusted Project over Global", () => {
    const global = { version: 6, ultracode: true };
    expect(resolve(global)).toMatchObject({
      ultracode: true,
      featureSources: { ultracode: "global" },
    });
    expect(resolve(global, { version: 6 }).ultracode).toBe(true);
    expect(resolve(global, { version: 6, ultracode: false })).toMatchObject({
      ultracode: false,
      featureSources: { ultracode: "project" },
    });
    expect(resolve(global, { version: 6, ultracode: false }, false).ultracode).toBe(true);
    expect(resolve({ version: 6 }, { version: 6, ultracode: true }).ultracode).toBe(true);
  });

  it("reports non-boolean ultracode values without retaining them", () => {
    for (const value of ["true", 1, null, { enabled: true }]) {
      const decoded = decodeSubagentConfig({ version: 6, ultracode: value });
      expect(decoded.file.ultracode).toBeUndefined();
      expect(decoded.diagnostics).toContain("config.ultracode");
    }
  });

  it.each(["automaticProfileRouting", "scriptedWorkflows"])(
    "ignores all retired v6 %s values without an effective field",
    (key) => {
      for (const value of [true, false, null, 0, "off", [], { enabled: "private-value" }]) {
        const raw = { version: 6, [key]: value };
        const decoded = decodeSubagentConfig(raw);
        expect(decoded.diagnostics).toEqual([]);
        expect(decoded.file).toEqual({ version: 6 });
        expect(resolve(raw)).toEqual(resolve({ version: 6 }));
        expect(resolve({ version: 6 }, raw)).toEqual(resolve({ version: 6 }));
      }
    },
  );

  it("never reads the retired routing value", () => {
    let reads = 0;
    const raw = {
      version: 6,
      get automaticProfileRouting() {
        reads += 1;
        throw new Error("The retired value must not be read.");
      },
    };
    expect(decodeSubagentConfig(raw).diagnostics).toEqual([]);
    expect(reads).toBe(0);
  });
});
