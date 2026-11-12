import { describe, expect, it } from "vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { groupedDetail, type ActivityDetailBlock } from "../src/activity/grouped-detail.ts";
import { groupedActivityTree } from "../src/activity/grouped-tree.ts";
import { plainTheme } from "pi-cosmic-core/testing";
import { activityRow } from "./support/activity.ts";

const blockText = (block: ActivityDetailBlock): string =>
  block.kind === "fields"
    ? Arr.join(
        Arr.map(block.fields, (field) => `${field.label} ${field.value}`),
        "\n",
      )
    : block.text;

describe("grouped activity detail", () => {
  it("sanitizes technical identifiers for display without rewriting their identity", () => {
    const row = activityRow("item\u001b]52;c;payload\u0007", "running", undefined, {
      title: "Work",
      providerId: "provider\u001b[2J",
      revision: "revision\r\ntoken=private-value",
    });
    const blocks = groupedDetail({
      selected: Option.getOrUndefined(
        Arr.findFirst(groupedActivityTree([row]), (entry) => entry.type === "member"),
      ),
      theme: plainTheme,
      focused: false,
      now: undefined,
      loaded: undefined,
      loading: false,
      actionPage: 0,
      technical: true,
      actions: [],
      children: [],
    });
    const text = Arr.join(Arr.map(blocks, blockText), "\n");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\r");
    expect(text).not.toContain("private-value");
    expect(row.id).toBe("item\u001b]52;c;payload\u0007");
    expect(row.revision).toBe("revision\r\ntoken=private-value");
  });

  it("shows provider identity only behind the technical disclosure", () => {
    const row = activityRow("task", "failed", undefined, { kind: "command", title: "Build" });
    const selected = Option.getOrUndefined(
      Arr.findFirst(groupedActivityTree([row]), (entry) => entry.type === "member"),
    );
    const text = (technical: boolean) =>
      Arr.join(
        Arr.map(
          groupedDetail({
            selected,
            theme: plainTheme,
            focused: true,
            now: undefined,
            loaded: {
              sections: [{ title: "Output", body: "compile error" }],
              technical: [{ label: "PID", value: "4242" }],
            },
            loading: false,
            actionPage: 0,
            technical,
            actions: [],
            children: [],
          }),
          blockText,
        ),
        "\n",
      );
    expect(text(false)).toContain("compile error");
    expect(text(false)).not.toContain("4242");
    expect(text(true)).toContain("4242");
  });
});
