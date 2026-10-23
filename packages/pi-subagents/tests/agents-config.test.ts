import { describe, expect, it } from "vitest";
import { subagentConfigDecoder } from "../src/config/schema.ts";
import { lookupCustomAgent } from "../src/profiles/agents.ts";
import {
  resolveTestConfig as resolve,
  type ConfigDocumentValue,
} from "./fixtures/profile-settings-inspection.ts";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Rec from "effect/Record";

const agent = (fields: Readonly<Record<string, ConfigDocumentValue>> = {}) => ({
  description: "Reviews auth changes.",
  instructions: "Review only authentication code.",
  ...fields,
});

const document = (agents: ConfigDocumentValue) => ({ version: 6, agents });

const names = (config: ReturnType<typeof resolve>) => Arr.map(config.agents, (entry) => entry.name);

describe("custom agent configuration", () => {
  it("decodes agents with their routed profile and overrides", () => {
    const config = resolve(
      document({
        "auth-reviewer": agent({
          profile: "reviewer",
          effort: "xhigh",
          context: "fresh",
          writeIntent: "writer",
          isolation: "worktree",
          tools: { allow: ["read", "grep"], deny: ["bash"] },
        }),
        helper: agent(),
      }),
    );
    expect(config.diagnostics).toEqual([]);
    expect(config.agents).toEqual([
      {
        name: "auth-reviewer",
        source: "global",
        description: "Reviews auth changes.",
        instructions: "Review only authentication code.",
        profile: "reviewer",
        effort: "xhigh",
        context: "fresh",
        writeIntent: "writer",
        isolation: "worktree",
        tools: { allow: ["read", "grep"], deny: ["bash"] },
      },
      expect.objectContaining({ name: "helper", profile: "generalist" }),
    ]);
  });

  it("rejects names outside the grammar and names that collide with profile IDs", () => {
    const decoded = subagentConfigDecoder("global")(
      document({
        Upper: agent(),
        "1st": agent(),
        "-dash": agent(),
        [`a${Fn.pipe("b", Str.repeat(48))}`]: agent(),
        worker: agent(),
        fine: agent(),
      }),
    );
    expect(decoded.diagnostics).toEqual([
      "global.agents[0].name",
      "global.agents[1].name",
      "global.agents[2].name",
      "global.agents[3].name",
      "global.agents[4].name",
    ]);
    expect(Rec.keys(decoded.file.agents ?? {})).toEqual(["fine"]);
  });

  it("fails a read-only agent that sets isolation closed by name", () => {
    const config = resolve(
      document({
        reader: agent({ writeIntent: "read-only", isolation: "worktree" }),
        good: agent({ isolation: "worktree" }),
      }),
    );
    expect(config.diagnostics).toEqual(["global.agents[0].isolation"]);
    expect(names(config)).toEqual(["good"]);
  });

  it("fails entries with unknown keys or out-of-bounds fields closed by name", () => {
    const invalid = [
      agent({ model: "opus" }),
      agent({ tools: { allow: ["read"], only: ["grep"] } }),
      agent({ description: "" }),
      agent({ instructions: "   " }),
      agent({ instructions: Fn.pipe("é", Str.repeat(65_537)) }),
      agent({ profile: "designer" }),
      agent({ effort: "default" }),
      agent({ tools: { deny: ["bad,name"] } }),
      { description: "Missing instructions." },
    ];
    const entries = Rec.fromEntries(Arr.map(invalid, (entry, index) => [`bad-${index}`, entry]));
    const config = resolve(document({ ...entries, good: agent() }));
    expect(config.diagnostics).toEqual(Arr.map(invalid, (_, index) => `global.agents[${index}]`));
    expect(names(config)).toEqual(["good"]);
    for (const name of Rec.keys(entries))
      expect(lookupCustomAgent(config, name)).toEqual({ kind: "invalid", scope: "global" });
    expect(lookupCustomAgent(config, "missing")).toEqual({ kind: "unknown" });
  });

  it("accepts instructions up to 128 KiB of UTF-8", () => {
    const config = resolve(
      document({ big: agent({ instructions: Fn.pipe("é", Str.repeat(65_536)) }) }),
    );
    expect(names(config)).toEqual(["big"]);
  });

  it("cuts a description longer than 200 characters, with a diagnostic, and keeps the agent", () => {
    const config = resolve(
      document({ verbose: agent({ description: Fn.pipe("d", Str.repeat(201)) }), good: agent() }),
    );
    expect(names(config)).toEqual(["verbose", "good"]);
    expect(config.diagnostics).toEqual(["global.agents[0].description"]);
    const description = config.agents[0]?.description ?? "";
    expect(description.length).toBeLessThanOrEqual(200);
    expect(Fn.pipe(description, Str.startsWith(Fn.pipe("d", Str.repeat(150))))).toBe(true);
  });

  it("allows at most 32 agents per document", () => {
    const many = (count: number) =>
      Rec.fromEntries(Array.from({ length: count }, (_, index) => [`agent-${index}`, agent()]));
    expect(names(resolve(document(many(32))))).toHaveLength(32);
    const tooMany = resolve(document(many(33)));
    expect(tooMany.diagnostics).toEqual(["global.agents[32+]"]);
    expect(tooMany.agents).toEqual([]);
    expect(lookupCustomAgent(tooMany, "agent-0")).toEqual({ kind: "invalid", scope: "global" });
  });

  it("replaces a same-named global agent wholesale with the trusted project's entry", () => {
    const global = document({
      shared: agent({ profile: "reviewer", tools: { deny: ["bash"] } }),
      "global-only": agent(),
    });
    const project = document({
      shared: agent({ description: "Project reviewer.", instructions: "Project rules." }),
      "project-only": agent(),
    });
    const config = resolve(global, project);
    expect(names(config)).toEqual(["shared", "global-only", "project-only"]);
    expect(config.agents[0]).toEqual({
      name: "shared",
      source: "project",
      description: "Project reviewer.",
      instructions: "Project rules.",
      profile: "generalist",
    });
  });

  it("ignores an untrusted project's agents", () => {
    const config = resolve(document({ mine: agent() }), document({ theirs: agent() }), false);
    expect(names(config)).toEqual(["mine"]);
    expect(config.agents[0]?.source).toBe("global");
  });

  it("fails a name closed when the project's same-named entry is invalid", () => {
    const config = resolve(
      document({ shared: agent(), other: agent() }),
      document({ shared: agent({ unknown: true }) }),
    );
    expect(names(config)).toEqual(["other"]);
    expect(lookupCustomAgent(config, "shared")).toEqual({ kind: "invalid", scope: "project" });
  });

  it("hides every global agent behind an invalid project agents object", () => {
    const config = resolve(document({ shared: agent() }), document(["not", "an", "object"]));
    expect(config.diagnostics).toContain("project.agents");
    expect(config.agents).toEqual([]);
    expect(lookupCustomAgent(config, "shared")).toEqual({ kind: "invalid", scope: "project" });
  });
});
