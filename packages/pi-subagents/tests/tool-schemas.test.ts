import { describe, expect, it } from "vitest";
import {
  claimsOperationError,
  ClaimsParameters,
  AwaitParameters,
  LifecycleParameters,
  ListParameters,
  ModelsParameters,
  RenameParameters,
  ReplyParameters,
  SendParameters,
  StartParameters,
  StatusParameters,
  type SubagentClaimsInput,
} from "../src/tools/schema.ts";
import { SUBAGENT_TOOL_NAMES } from "../src/run/tool-policy.ts";

/**
 * Pi's tool-call pipeline drops arguments for tools whose advertised schema has no root
 * `type: "object"` (a pure anyOf union at the root). Every registered subagent tool must
 * therefore keep an object-rooted parameter schema; per-action field requirements live in
 * runtime validation, never in a root Type.Union.
 */
const TOOL_PARAMETERS = {
  subagent_models: ModelsParameters,
  subagent_start: StartParameters,
  subagent_list: ListParameters,
  subagent_status: StatusParameters,
  subagent_await: AwaitParameters,
  subagent_send: SendParameters,
  subagent_reply: ReplyParameters,
  subagent_lifecycle: LifecycleParameters,
  subagent_rename: RenameParameters,
  subagent_claims: ClaimsParameters,
} as const;

describe("subagent tool parameter schemas", () => {
  it("registers an object-rooted schema for every tool", () => {
    expect(Object.keys(TOOL_PARAMETERS)).toEqual([...SUBAGENT_TOOL_NAMES]);
    for (const [name, parameters] of Object.entries(TOOL_PARAMETERS)) {
      expect(parameters.type, name).toBe("object");
    }
  });
});

describe("claimsOperationError", () => {
  const valid: ReadonlyArray<SubagentClaimsInput> = [
    { action: "list", runIds: ["agent-1"] },
    { action: "grant", runId: "agent-1", paths: ["src/a.ts"] },
    { action: "revoke", runId: "agent-1", paths: ["src/a.ts"] },
    { action: "resume_admission", runId: "agent-1" },
  ];

  it.each(valid)("accepts $action operations", (operation) => {
    expect(claimsOperationError(operation)).toBeUndefined();
  });

  it("names the missing field for each action", () => {
    expect(claimsOperationError({ action: "list" })).toBe(
      'subagent_claims action="list" requires runIds.',
    );
    expect(claimsOperationError({ action: "grant", paths: ["src/a.ts"] })).toBe(
      'subagent_claims action="grant" requires runId.',
    );
    expect(claimsOperationError({ action: "revoke", runId: "agent-1" })).toBe(
      'subagent_claims action="revoke" requires a non-empty paths array.',
    );
    expect(claimsOperationError({ action: "resume_admission" })).toBe(
      'subagent_claims action="resume_admission" requires runId.',
    );
  });

  it("rejects cross-field combinations the previous union rejected", () => {
    expect(claimsOperationError({ action: "list", runIds: ["a"], runId: "a" })).toBe(
      'subagent_claims action="list" takes runIds only.',
    );
    expect(claimsOperationError({ action: "grant", runId: "a", paths: ["p"], runIds: ["a"] })).toBe(
      'subagent_claims action="grant" takes runId and paths only.',
    );
    expect(claimsOperationError({ action: "resume_admission", runId: "a", paths: ["p"] })).toBe(
      'subagent_claims action="resume_admission" takes runId only.',
    );
  });
});
