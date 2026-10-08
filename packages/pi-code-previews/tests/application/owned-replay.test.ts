import {
  initTheme,
  type ExtensionAPI,
  type SourceInfo,
  type ToolDefinition,
  type ToolInfo,
  type ToolRenderers,
  type ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { beforeAll, expect, it } from "vitest";
import { extensionApiFixture, opaqueFixture } from "pi-cosmic-core/testing";
import { registerCodePreviewReplay } from "../../index";
import {
  createToolPresentationHarness,
  drawToolRow,
  hostToolRow,
  withPresentationSettings,
} from "../../testing";

beforeAll(() => initTheme("dark", false));
const source: SourceInfo = {
  source: "local",
  path: "/extensions/owned.ts",
  scope: "user",
  origin: "top-level",
};
const args = { value: "COMPLETE_INPUT" };
const result = {
  content: [
    { type: "text" as const, text: "COMPLETE_OUTPUT recovery /tmp/evidence.txt" },
    { type: "image" as const, data: "image-preserved", mimeType: "image/png" },
  ],
  details: undefined,
  isError: false,
};
const fixture = () => {
  let resolver: ToolRendererResolver | undefined;
  let tools: ToolInfo[] = [];
  let commands: ReturnType<ExtensionAPI["getCommands"]> = [
    { name: "owner", description: "fixture", source: "extension", sourceInfo: source },
  ];
  let broken = false;
  let observed: typeof result.content | undefined;
  const pi = extensionApiFixture({
    registerToolRenderer: (value: ToolRendererResolver) => {
      resolver = value;
    },
    getAllTools: () => {
      if (broken) throw new Error("metadata unavailable");
      return tools;
    },
    getCommands: () => commands,
  });
  const replay = registerCodePreviewReplay(pi, { command: "owner", tools: ["owned"] });
  const tool: ToolDefinition<any, any, any> = {
    name: "owned",
    label: "Owned",
    description: "fixture",
    parameters: opaqueFixture({ type: "object" }),
    execute: () => {
      throw new Error("Replay must never execute");
    },
    renderCall: (input) => new Text(`OWNED_CALL ${JSON.stringify(input)}`, 0, 0),
    renderResult: (value) => {
      observed = value.content;
      return new Text(
        value.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
        0,
        0,
      );
    },
  };
  const stage = () => {
    const wrapped = replay.shell(tool, {
      compactSummary: () => ({ subject: "OWNED_SUMMARY", outcome: "returned" }),
    });
    tools = [
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        exposure: "direct",
        sourceInfo: source,
      },
    ];
    return wrapped;
  };
  return {
    replay,
    stage,
    resolve: (downstream?: ToolRenderers) => resolver!("owned", () => downstream),
    tool,
    get observed() {
      return observed;
    },
    foreign() {
      tools = tools.map((entry) => ({ ...entry, sourceInfo: { ...source, path: "/foreign.ts" } }));
    },
    duplicateTool() {
      tools.push(...tools);
    },
    missingAnchor() {
      commands = [];
    },
    duplicateAnchor() {
      commands.push(...commands);
    },
    brokenMetadata() {
      broken = true;
    },
  };
};

for (const style of ["preview", "compact"] as const)
  for (const mode of ["on", "off", "border"] as const)
    it(`the same cold row adopts complete owned presentation (${style}/${mode})`, () => {
      withPresentationSettings(
        { toolCallCollapsedStyle: style, toolCallBackground: mode, toolCallTiming: false },
        () => {
          const h = fixture();
          const row = hostToolRow("owned", args, h.resolve(), { result });
          expect(row.render(160).join("\n")).not.toContain("OWNED_CALL");
          const wrapped = h.stage();
          expect(wrapped.execute).toBe(h.tool.execute);
          h.replay.publish();
          h.replay.finishStartup();
          const frames = [true, false, true].map((expanded) => ({
            expanded,
            text: drawToolRow(row, expanded, 160),
          }));
          for (const { text } of frames.filter((frame) => frame.expanded)) {
            expect(text).toContain("OWNED_CALL");
            expect(text).toContain("COMPLETE_INPUT");
            expect(text).toContain("COMPLETE_OUTPUT recovery /tmp/evidence.txt");
          }
          for (const { text } of frames.filter((frame) => !frame.expanded && style === "compact"))
            expect(text).toContain("OWNED_SUMMARY");
          expect(h.observed).toBe(result.content);
          h.replay.retire();
          row.setExpanded(true);
          expect(row.render(160).join("\n")).toContain("OWNED_CALL");
        },
      );
    });

for (const failure of [
  "foreign",
  "duplicateTool",
  "missingAnchor",
  "duplicateAnchor",
  "brokenMetadata",
] as const)
  it(`does not adopt unverified ${failure} ownership`, () => {
    const h = fixture();
    const row = createToolPresentationHarness(h.resolve()!);
    row.call(args);
    row.result(result);
    h.stage();
    h[failure]();
    h.replay.publish();
    row.call(args, { expanded: true });
    expect(row.render().join("\n")).not.toContain("OWNED_CALL");
    expect(row.render().join("\n")).toContain("COMPLETE_OUTPUT");
    h.replay.retire();
  });

it("never replaces downstream renderers and falls through after the first startup", () => {
  const h = fixture();
  const downstream: ToolRenderers = { renderCall: () => new Text("FOREIGN", 0, 0) };
  expect(h.resolve(downstream)?.renderCall).toBe(downstream.renderCall);
  const wrapped = h.stage();
  h.replay.publish();
  expect(h.resolve(wrapped)?.renderCall).toBe(wrapped.renderCall);
  expect(h.resolve()).toBeUndefined();
  h.replay.retire();
});

it("a published facade can first draw after startup finishes without borrowing later settings", () => {
  withPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }, () => {
    const h = fixture();
    const cold = h.resolve()!;
    h.stage();
    h.replay.publish();
    h.replay.finishStartup();
    withPresentationSettings({ toolCallCollapsedStyle: "preview" }, () => {
      h.stage();
      h.replay.publish();
      const row = createToolPresentationHarness(cold);
      row.call(args);
      row.result(result);
      expect(row.render().join("\n")).toContain("OWNED_SUMMARY");
    });
    h.replay.retire();
  });
});

for (const close of ["finishStartup", "retire"] as const)
  it(`${close} before publication permanently leaves raw history`, () => {
    const h = fixture();
    const row = createToolPresentationHarness(h.resolve()!);
    row.call(args);
    row.result(result);
    h.stage();
    h.replay[close]();
    h.replay.publish();
    row.call(args, { expanded: true });
    expect(row.render().join("\n")).not.toContain("OWNED_CALL");
    expect(row.render().join("\n")).toContain("COMPLETE_OUTPUT");
    expect(h.resolve()).toBeUndefined();
  });

it("hosts without renderer resolvers still wrap normal definitions", () => {
  const replay = registerCodePreviewReplay(extensionApiFixture({}), {
    command: "owner",
    tools: ["owned"],
  });
  const h = fixture();
  const wrapped = replay.shell(h.tool);
  expect(wrapped.execute).toBe(h.tool.execute);
  replay.publish();
  replay.finishStartup();
  replay.retire();
});
