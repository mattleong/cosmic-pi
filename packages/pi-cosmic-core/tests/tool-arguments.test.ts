import { StringEnum, validateToolArguments } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  omitBlankOptionalArguments,
  replacementField,
  toolArgumentPreparer,
} from "../src/schema/tool-arguments.ts";

const entry = {
  type: "object",
  properties: {
    task: { type: "string" },
    name: { type: "string" },
    profile: { type: "string" },
  },
  required: ["task"],
};

const parameters = {
  type: "object",
  properties: {
    action: { type: "string" },
    note: { type: "string" },
    limit: { type: "number" },
    agents: { type: "array", items: entry },
    options: {
      type: "object",
      properties: { mode: { type: "string" }, label: { type: "string" } },
      required: ["mode"],
    },
  },
  required: ["action", "agents"],
};

const omit = omitBlankOptionalArguments(parameters);

describe("omitBlankOptionalArguments", () => {
  it("drops optional properties that are empty, only whitespace, or a null their schema rejects", () => {
    expect(omit({ action: "start", note: " \n\t", limit: null, agents: [] })).toEqual({
      action: "start",
      agents: [],
    });
  });

  it("keeps a null that the optional property's schema accepts, as Pi does", () => {
    const nullable = {
      type: "object",
      properties: {
        parent: { anyOf: [{ type: "string" }, { type: "null" }] },
        note: { type: "string" },
      },
    };
    expect(omitBlankOptionalArguments(nullable)({ parent: null, note: null })).toEqual({
      parent: null,
    });
  });

  it("keeps whitespace-only text in the named fields but drops their empty strings", () => {
    const keeping = omitBlankOptionalArguments(parameters, ["note", "agents.name"]);
    expect(
      keeping({ action: "start", note: "\n", agents: [{ task: "Map", name: " ", profile: " " }] }),
    ).toEqual({ action: "start", note: "\n", agents: [{ task: "Map", name: " " }] });
    expect(keeping({ action: "start", note: "", agents: [] })).toEqual({
      action: "start",
      agents: [],
    });
  });

  it("keeps required properties for validation to report", () => {
    expect(omit({ action: "  ", agents: null, options: { mode: "" } })).toEqual({
      action: "  ",
      agents: null,
      options: { mode: "" },
    });
  });

  it("applies through nested objects and array items", () => {
    expect(
      omit({
        action: "start",
        agents: [
          { task: "Map", name: "", profile: "scout" },
          { task: " ", name: "Review", profile: null },
        ],
        options: { mode: "fast", label: "" },
      }),
    ).toEqual({
      action: "start",
      agents: [
        { task: "Map", profile: "scout" },
        { task: " ", name: "Review" },
      ],
      options: { mode: "fast" },
    });
  });

  it("keeps meaningful optional values and undeclared properties", () => {
    const args = { action: "start", agents: [], limit: 0, note: "x", extra: null };
    expect(omit(args)).toEqual(args);
  });

  it("returns a copy and leaves the input unchanged", () => {
    const args = { action: "start", note: "", agents: [{ task: "Map", name: null }] };
    const snapshot = structuredClone(args);
    const prepared = omit(args);
    expect(args).toEqual(snapshot);
    expect(prepared).not.toBe(args);
  });
});

/** The listed issues of an `[invalid_arguments]` error, or none when preparation succeeds. */
const issuesOf = (
  preparer: (args: Record<string, Schema.Json>) => object,
  args: Record<string, Schema.Json>,
): ReadonlyArray<string> => {
  try {
    preparer(args);
    return [];
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : "";
    return message.split("\n").filter((line) => line.startsWith("- "));
  }
};

const StartParameters = Type.Object(
  {
    agents: Type.Array(
      Type.Object(
        {
          task: Type.String({ minLength: 1 }),
          name: Type.Optional(Type.String()),
          isolation: Type.Optional(StringEnum(["none", "worktree"] as const)),
        },
        { additionalProperties: false },
      ),
    ),
    limit: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);
type StartArgs = Static<typeof StartParameters>;
const prepare = toolArgumentPreparer("agent_start", StartParameters, {
  aliases: { prompt: "task" },
});

describe("toolArgumentPreparer", () => {
  it("drops blank optionals and coerces as Pi does, so Pi's validation accepts the result", () => {
    const prepared = prepare({ agents: [{ task: 42, name: " ", isolation: null }], limit: "3" });
    expect(prepared).toEqual({ agents: [{ task: "42" }], limit: 3 });
    const tool = { name: "agent_start", description: "", parameters: StartParameters };
    expect(
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call",
        name: "agent_start",
        arguments: prepared,
      }),
    ).toEqual(prepared);
  });

  it("rejects blank required text and names its path", () => {
    expect(() => prepare({ agents: [{ task: " \n" }] })).toThrow(
      /\[invalid_arguments\][\s\S]*agents\[0\]\.task must contain non-whitespace text/u,
    );
  });

  it("names the enum's path, allowed values, and received value", () => {
    const [issue = ""] = issuesOf(prepare, { agents: [{ task: "Edit", isolation: "sandbox" }] });
    expect(issue).toContain("agents[0].isolation");
    expect(issue).toMatch(/none[\s\S]*worktree/u);
    expect(issue).toContain("sandbox");
  });

  it("names unknown fields with their replacement and the accepted fields", () => {
    const [issue = ""] = issuesOf(prepare, { agents: [{ prompt: "Map", task: "Map" }] });
    expect(issue).toContain("agents[0]");
    expect(issue).toMatch(/prompt[\s\S]*use "task"/u);
    expect(issue).toMatch(/task[\s\S]*name[\s\S]*isolation/u);
    const [plural = ""] = issuesOf(prepare, { agents: [{ task: "Map" }], limits: 2 });
    expect(plural).toMatch(/limits[\s\S]*use "limit"/u);
  });

  it("names missing required fields", () => {
    const [issue = ""] = issuesOf(prepare, { limit: 1 });
    expect(issue).toMatch(/\bagents\b[\s\S]*required/u);
  });

  it("accepts whitespace-only text in the fields it keeps", () => {
    const keeping = toolArgumentPreparer("agent_start", StartParameters, {
      keepWhitespace: ["agents.name"],
    });
    expect(keeping({ agents: [{ task: "Map", name: "\n" }] })).toEqual({
      agents: [{ task: "Map", name: "\n" }],
    });
    expect(() => keeping({ agents: [{ task: " ", name: " " }] })).toThrow(/agents\[0\]\.task/u);
  });

  it("echoes only bounded arguments", () => {
    const task = "x".repeat(5_000);
    const error = (() => {
      try {
        prepare({ agents: [{ task, isolation: "sandbox" }] });
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("Received: ");
    expect(message).not.toContain(task);
    expect(message.length).toBeLessThan(1_500);
  });

  it("rejects non-object arguments, and empty arguments by their missing required fields", () => {
    expect(() => prepare([])).toThrow(/arguments must be a JSON object/u);
    // Pi substitutes `{}` for malformed tool-call JSON before this hook runs.
    expect(() => prepare({})).toThrow(/\[invalid_arguments\][\s\S]*\bagents is required/u);
  });

  it("suggests resending malformed tool-call JSON only when no arguments arrived", () => {
    expect(() => prepare({})).toThrow(/malformed or truncated/u);
    expect(() => prepare({ limit: 1 })).not.toThrow(/malformed or truncated/u);
    expect(() => prepare({ limit: 1 })).toThrow(/\[invalid_arguments\]/u);
  });

  it("runs the tool's inspection on arguments without blank optionals", () => {
    const inspected: Array<unknown> = [];
    const inspecting = toolArgumentPreparer("agent_start", StartParameters, {
      inspect: (args) => {
        inspected.push(args);
        if (args.limit === 0) throw new Error("[invalid_limit] limit must be positive.");
      },
    });
    const prepared: StartArgs = inspecting({ agents: [{ task: "Map", name: "" }] });
    expect(prepared).toEqual({ agents: [{ task: "Map" }] });
    expect(inspected).toEqual([{ agents: [{ task: "Map" }] }]);
    expect(() => inspecting({ agents: [], limit: 0 })).toThrow(/invalid_limit/u);
  });
});

const ShapeParameters = Type.Object({
  shapes: Type.Array(
    Type.Union([
      Type.Object({ kind: StringEnum(["circle"] as const), radius: Type.Number() }),
      Type.Object(
        { kind: Type.Literal("square"), side: Type.Number() },
        { additionalProperties: false },
      ),
    ]),
  ),
});
const prepareShapes = toolArgumentPreparer("draw", ShapeParameters);
const issues = (args: Record<string, Schema.Json>): ReadonlyArray<string> =>
  issuesOf(prepareShapes, args);

describe("toolArgumentPreparer with a union", () => {
  it("reports only the branch that a received enum or const property selects", () => {
    const reported = issues({
      shapes: [
        { kind: "circle", radius: "wide" },
        { kind: "square", side: 2, radius: 1 },
      ],
    });
    expect(reported).toHaveLength(2);
    expect(reported[0]).toMatch(/shapes\[0\]\.radius/u);
    expect(reported[1]).toMatch(/^- shapes\[1\][^.[][\s\S]*radius/u);
    expect(reported.join("\n")).not.toMatch(/anyOf|\.kind|\.side/u);
  });

  it("lists every allowed value once when no branch matches", () => {
    const reported = issues({ shapes: [{ kind: "hexagon", side: 1 }] });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("shapes[0].kind");
    expect(reported[0]).toMatch(/circle[\s\S]*square/u);
    expect(reported[0]).toContain("hexagon");
  });

  it("selects by a property only when every branch declares it as an enum or const", () => {
    const Leveled = Type.Object({
      entry: Type.Union([
        Type.Object({ kind: Type.Literal("a"), level: StringEnum(["low", "high"] as const) }),
        Type.Object({ kind: Type.Literal("b"), size: Type.Number() }),
      ]),
    });
    const leveled = toolArgumentPreparer("level", Leveled);
    const reported = issuesOf(leveled, { entry: { kind: "a", level: "mid" } });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("entry.level");
    expect(reported[0]).toMatch(/low[\s\S]*high/u);
    expect(reported.join("\n")).not.toMatch(/entry\.kind|entry\.size/u);
  });

  it("reports every branch's issues when the union has no common discriminant", () => {
    const Loose = Type.Object({
      entry: Type.Union([
        Type.Object({ level: StringEnum(["low", "high"] as const) }),
        Type.Object({ size: Type.Number() }),
      ]),
    });
    const loose = toolArgumentPreparer("loose", Loose);
    const reported = issuesOf(loose, { entry: { level: "mid" } }).join("\n");
    expect(reported).toContain("entry.level");
    expect(reported).toContain("entry.size");
  });
});

describe("replacementField", () => {
  it("prefers an accepted alias, then camelCase, plural, and singular spellings", () => {
    const accepted = ["task", "runIds", "isolation"];
    expect(replacementField("worktree", accepted, { worktree: "isolation" })).toBe("isolation");
    expect(replacementField("run_id", accepted)).toBe("runIds");
    expect(replacementField("prompt", accepted)).toBeUndefined();
    expect(replacementField("prompt", accepted, { prompt: "missing" })).toBeUndefined();
  });
});
