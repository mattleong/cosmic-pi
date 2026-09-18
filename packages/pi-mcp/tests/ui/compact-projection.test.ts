import { expect, it } from "vitest";
import { projectMcpCompactSummary } from "../../src/protocol.ts";
import { mcpCompactSummary } from "../../src/ui/compact-summary.ts";

it("shares standalone semantics without relaxing remote outcome requirements", () => {
  const args = { action: "tools.list", server: "catalog" };
  for (const outcome of ["completed", "unknown", "not-sent"] as const) {
    for (const isError of [false, true]) {
      const result = {
        content: [],
        details: { action: "tools.list", outcome, isError, data: {}, notices: [] },
      };
      const pure = projectMcpCompactSummary({ phase: "settled", args, result, isError: false });
      const standalone = mcpCompactSummary({
        phase: "settled",
        args,
        result,
        context: {
          args,
          state: {},
          toolCallId: "test",
          cwd: "/",
          invalidate() {},
          lastComponent: undefined,
          argsComplete: true,
          executionStarted: true,
          expanded: false,
          isPartial: false,
          isError: false,
          showImages: true,
        },
      });
      expect(pure).toEqual(standalone);
      if (isError) expect(pure).toBeUndefined();
      else if (outcome === "completed") expect(pure?.outcome).toBe("success");
      else {
        expect(pure?.outcome).toBe(outcome === "unknown" ? "uncertain" : "warning");
        expect(pure?.issues?.coverage).toBe("unknown");
      }
    }
  }
});

it("declines retained replies with incomplete or invalid origin evidence", () => {
  for (const origin of [
    { outcome: "completed" },
    { outcome: "completed", isError: false, outputValidation: "invalid" },
  ]) {
    expect(
      projectMcpCompactSummary({
        phase: "settled",
        args: { action: "result.read" },
        result: {
          details: {
            action: "result.read",
            outcome: "completed",
            isError: false,
            data: { origin },
            notices: [],
          },
        },
        isError: false,
      }),
    ).toBeUndefined();
  }
});
