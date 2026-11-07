import * as Schema from "effect/Schema";
import {
  generateDiffString,
  type AgentToolResult,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { renderExpansionAffordance, renderToolHeader } from "pi-cosmic-ui/tool";
import { previewHeadingText } from "../src/preview/heading-wrap";
import * as Predicate from "effect/Predicate";
import { extensionApiFixture, extensionContextFixture, plainTheme } from "pi-cosmic-core/testing";
import { stripAnsi } from "pi-cosmic-core";
import { registerCodePreviewsCommand } from "../src/commands/register";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  authoredTextLines,
  captureCodePreviewPresentationPolicy,
  expandedAuthoredText,
  expandedBody,
  expandedDetails,
  expandedFields,
  expandedText,
  withCodePreviewMessageShell,
} from "../index";
import {
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  galleryMessageFrames,
  writeGallerySection,
  withPresentationSettings,
  type GalleryScenario,
  type GalleryView,
} from "../testing";
import { defaultCodePreviewSettings } from "../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../src/config/state";
import type { CodePreviewSettings } from "../src/config/schema";
import { ALL_CODE_PREVIEW_TOOLS } from "../src/tools/names";
import { withCodePreviewRenderers } from "../src/tools/cooperative-tools";
import { setCodePreviewToolStatus } from "../src/tools/status";
import { createSettingsCategoryItems } from "../src/settings/ui/index";
import { WEB_ACCESS_TOOLS, isWebAccessTool } from "../src/third-party/web-access/identity";
import {
  CodePreviewPresentationOwner,
  createCodePreviewRendererResolver,
} from "../src/application/tool-renderers";
import { nativeCall as callRecord, nativeReceipt, scriptResult } from "./support/native-codemode";
import { builtinToolInfo, inertScheduler } from "./support/renderer-host";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
} from "../src/application/capability";
import * as Match from "effect/Match";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as Rec from "effect/Record";

function registered(style: "compact" | "preview", background?: "border") {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    tools: [...ALL_CODE_PREVIEW_TOOLS],
    toolCallCollapsedStyle: style,
    toolCallTiming: false,
    ...(background && { toolCallBackground: background }),
  });
  const names = [
    ...ALL_CODE_PREVIEW_TOOLS,
    ...WEB_ACCESS_TOOLS,
    "mcp__docs__lookup",
    "read_mcp_resource",
    "list_mcp_resources",
    "list_mcp_resource_templates",
  ];
  const metadata = Arr.map(names, (name) => {
    const tool = builtinToolInfo(name);
    if (isWebAccessTool(name))
      tool.sourceInfo = {
        source: "npm:pi-web-access@0.36.0",
        origin: "package",
        scope: "user",
        baseDir: "/agent/npm/node_modules/pi-web-access",
        path: "/agent/npm/node_modules/pi-web-access/dist/index.js",
      };
    if (name === "mcp__docs__lookup") tool.namespace = { name: "mcp__docs" };
    return tool;
  });
  const owner = new CodePreviewPresentationOwner();
  owner.publish("/project", new Set(ALL_CODE_PREVIEW_TOOLS), inertScheduler);
  const captured = captureRegistrations((registration) => {
    const pi = extensionApiFixture({
      ...registration,
      getAllTools: () => metadata,
      getCommands: () => [],
    });
    pi.registerToolRenderer(createCodePreviewRendererResolver(pi, () => owner, new Set()));
  });
  return new Map<string, ToolRenderers>(
    Arr.map(names, (name) => [
      name,
      captured.resolveToolRenderers(
        name,
        name === "mcp__docs__lookup"
          ? nativeMcpCall
          : name === "source_check"
            ? webResultOnly
            : isWebAccessTool(name)
              ? webCall
              : undefined,
      )!,
    ]),
  );
}

const cartBefore = Arr.join(
  [
    "export function subtotal(items: LineItem[]): number {",
    "  return items.reduce((total, item) => total + item.price, 0);",
    "}",
    "",
    "export function applyDiscount(total: number, percent: number): number {",
    "  return total - total * (percent / 100);",
    "}",
  ],
  "\n",
);
const cartAfter = Fn.pipe(
  cartBefore,
  Str.replace(
    "}\n\nexport function applyDiscount",
    "}\n\nexport function itemCount(items: LineItem[]): number {\n  return items.length;\n}\n\nexport function applyDiscount",
  ),
);

/** Lines longer than a phone's code column, so the 57-column scenarios show how code wraps. */
const cartTestSource = Arr.join(
  [
    "import { test } from 'node:test';",
    "",
    "test('subtotal sums prices multiplied by quantities', () => {",
    "  assert.equal(subtotal([{ sku: 'a', price: 5, quantity: 2 }, { sku: 'b', price: 3, quantity: 1 }]), 13);",
    "});",
  ],
  "\n",
);

const webResult: NonNullable<ToolRenderers["renderResult"]> = (result) =>
  new Text(
    Fn.pipe(
      Option.getOrUndefined(Arr.findFirst(result.content, (part) => part.type === "text"))?.text ??
        "",
      Str.slice(0, 200),
    ),
    0,
    0,
  );

const webCall: ToolRenderers = {
  renderCall: (args) => new Text(JSON.stringify(args), 0, 0),
  renderResult: webResult,
};

/** A third-party renderer without its own call heading, so the adapter draws the heading. */
const webResultOnly: ToolRenderers = { renderResult: webResult };

const nativeMcpCall: ToolRenderers = {
  renderCall: (args, _theme, context) => {
    const fields = Rec.toEntries(Predicate.isObject(args) ? args : {});
    const entries = Arr.map(fields, ([key, value]) => `${key}=${JSON.stringify(value)}`);
    const lines = Arr.map(fields, ([key, value]) => `  ${key}: ${String(value)}`);
    return new Text(
      context.expanded
        ? Arr.join(["docs/lookup", ...lines], "\n")
        : Arr.join(["docs/lookup", ...entries], " "),
      0,
      0,
    );
  },
};

const text = <Details>(
  value: string,
  details?: Details,
): AgentToolResult<Details | Record<string, never>> => ({
  content: [{ type: "text", text: value }],
  details: details ?? {},
});
const docsLookup = { server: "docs", tool: "lookup" };
const writeBefore = (content: string | undefined) => ({
  codePreviewBeforeWrite: content === undefined ? undefined : { kind: "content", content },
});
const writeSource = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";
const editArgs = {
  path: "/project/src/a.ts",
  edits: [{ oldText: "export const b = 2;", newText: "export const b = 20;" }],
};

const nativeResult = (
  status: "completed" | "failed",
  calls: unknown[] = [],
  output = "Script output",
  fullOutputPath?: string,
) =>
  scriptResult(
    status,
    { calls, ...(fullOutputPath && { fullOutputPath }) },
    { type: "text", text: output },
  );
const nativeCall = (status: string, error?: string) =>
  callRecord({ args: '{"path":"/project/source.ts"}', status, ...(error && { error }) });
const nativeArgumentCall = (name: string, args: Schema.JsonObject) =>
  callRecord({ id: `private/${name}`, name, args: nativeReceipt(args) });

/** A cooperating tool whose summary comes from its arguments, to show shared row states. */
const StatusDemoArgs = Schema.Struct({
  subject: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.Literal(true)),
  waiting: Schema.optionalKey(Schema.Literal(true)),
  /** Open, but its request waits its turn in a queue. */
  queued: Schema.optionalKey(Schema.Literal(true)),
  outcome: Schema.optionalKey(Schema.Literals(["queued", "paused", "returned"])),
  metadata: Schema.optionalKey(Schema.String),
  /** The summary's first counter, which a heading shows beside its glyph. */
  counter: Schema.optionalKey(Schema.String),
  /** Facts the expanded row shows in its `Details` section. */
  details: Schema.optionalKey(Schema.Array(Schema.String)),
  /** A state the collapsed result states above its output, as a task's `running` does. */
  state: Schema.optionalKey(Schema.String),
  expandLabel: Schema.optionalKey(Schema.Union([Schema.String, Schema.Literal(false)])),
  /** An issue the row shows, which carries its state when expanded. */
  issue: Schema.optionalKey(Schema.String),
  issueSeverity: Schema.optionalKey(Schema.Literals(["info", "warning", "attention"])),
  /** Detail the issue keeps for expansion. */
  issueDetail: Schema.optionalKey(Schema.String),
  /** In compact style, `expandLabel` reveals only the subject (`expandsSubjectOnly`). */
  subjectOnly: Schema.optionalKey(Schema.Literal(true)),
  /** The collapsed preview draws no result body; only the heading summarizes it. */
  summaryOnly: Schema.optionalKey(Schema.Literal(true)),
  /** The collapsed result body ends with its own affordance for clipped output. */
  clipped: Schema.optionalKey(Schema.Literal(true)),
  messageIcon: Schema.optionalKey(Schema.Literal("received")),
});
const statusDemoArgs = Fn.flow(
  Schema.decodeUnknownOption(StatusDemoArgs),
  Option.getOrElse((): typeof StatusDemoArgs.Type => ({})),
);
const statusDemo = (style = captureCodePreviewPresentationPolicy().toolCallCollapsedStyle) =>
  withCodePreviewRenderers<unknown, unknown, object>(
    { name: "status_demo", label: "Status demo" },
    {
      // A preview heading hangs its continuation rows, as tool headings draw theirs.
      renderCall: (args, theme) =>
        previewHeadingText(() =>
          renderToolHeader(
            { title: "Status demo", subtitle: statusDemoArgs(args).subject ?? "" },
            theme,
          ),
        ),
      renderResult: (result, _options, theme, context) => {
        const output = result.content[0]?.type === "text" ? result.content[0].text : "";
        const { state, summaryOnly, clipped } = statusDemoArgs(context.args);
        if (summaryOnly) return new Container();
        const shown = clipped
          ? `${Str.split(output, "\n")[0] ?? ""}\n${renderExpansionAffordance("2 more lines", false, theme)}`
          : output;
        return new Text(state === undefined ? shown : `${state}\n${shown}`, 0, 0);
      },
    },
    {
      compactSummary: ({ args: raw, phase }) => {
        const args = statusDemoArgs(raw);
        const metadata = args.metadata ?? args.state;
        return {
          subject: args.subject ?? "",
          ...(args.path && { pathSubject: true }),
          ...(args.waiting && { waiting: true }),
          ...(args.queued && { queued: true }),
          ...(args.counter !== undefined && { counters: [args.counter] }),
          ...(metadata !== undefined && { metadata: [metadata] }),
          ...(args.expandLabel !== undefined && { expandLabel: args.expandLabel }),
          // A preview heading wraps, so it shows the whole subject such a label would reveal.
          ...(args.subjectOnly &&
            (style === "compact" ? { expandsSubjectOnly: true } : { expandLabel: false })),
          ...(args.messageIcon && { messageIcon: args.messageIcon }),
          ...(args.issue !== undefined && {
            issues: [
              {
                severity: args.issueSeverity ?? "warning",
                code: "demo",
                message: args.issue,
                ...(args.issueDetail !== undefined && { detail: args.issueDetail }),
              },
            ],
          }),
          ...(phase === "settled" && {
            outcome: args.outcome ?? (args.issueSeverity === "warning" ? "warning" : "returned"),
          }),
        };
      },
      expandedContent: {
        renderCall: () => new Container(),
        renderResult: (result, _options, theme, context) => {
          const lines = Arr.filter(
            Arr.map(result.content, (part) => (part.type === "text" ? part.text : "[image]")),
            Str.isNonEmpty,
          );
          const details = statusDemoArgs(context.args).details ?? [];
          return expandedBody(
            lines.length === 0 ? undefined : expandedText(theme, "Output", lines),
            expandedFields(
              theme,
              Arr.map(Arr.take(details, 1), (line) => ({ label: "Route", lines: [line] })),
            ),
            expandedDetails(theme, details),
          );
        },
      },
    },
  );

const messageText = (content: string | ReadonlyArray<{ readonly type: string }>) =>
  Predicate.isString(content)
    ? content
    : Arr.join(
        Arr.map(content, (part) =>
          "text" in part && Predicate.isString(part.text) ? part.text : "",
        ),
        "\n",
      );

const statusDemoMessage = withCodePreviewMessageShell((message, _options, theme) => ({
  name: "status_message",
  label: "Status message",
  summary: {
    subject: "release notes",
    outcome: "returned",
    messageIcon: "received",
  },
  collapsed: () => new Text(messageText(message.content), 0, 0),
  expanded: () =>
    expandedText(theme, "Message", [messageText(message.content), "The full note continues here."]),
  expandLabel: "message",
}));

/** A command too long for a collapsed heading beside its outcome. */
const LONG_COMMAND =
  "pnpm vitest run --reporter=dot tests/task-service.test.ts tests/log-buffer.test.ts";

/** A message whose heading subject is long prose or a long path, which a collapsed heading cuts. */
const longSubjectMessage = (subject: string, path: boolean) =>
  withCodePreviewMessageShell((message, _options, theme) => ({
    name: "status_message",
    label: "Image ready",
    summary: {
      subject,
      ...(path && { pathSubject: true }),
      metadata: ["PNG · 70 bytes"],
      outcome: "success",
    },
    collapsed: () => new Text(messageText(message.content), 0, 0),
    expanded: () => expandedText(theme, "Details", [subject, messageText(message.content)]),
    expandLabel: "details",
  }));

/** A 449-character command, longer than any heading row, ending in a flag a cut would lose. */
const EXTREME_COMMAND = `node scripts/verify.ts ${Arr.join(
  Arr.map(Arr.range(0, 19), (index) => `--include=package-${index}`),
  " ",
)} --security-check`;

/** A long heredoc script, which a compact heading flattens and cuts. */
const HEREDOC_COMMAND = Arr.join(
  [
    "cat > release-notes.md <<'EOF'",
    "# Release 2.4.0",
    "",
    ...Arr.map(
      Arr.range(1, 12),
      (index) => `- Change ${index}: tightened the review loop for package ${index}`,
    ),
    "EOF",
    "echo Wrote release-notes.md",
  ],
  "\n",
);

/** Collapsed and expanded at a phone's width and a very wide terminal. */
const EXTREME_VIEWS: readonly GalleryView[] = [
  { expanded: false, width: 57 },
  { expanded: false, width: 180 },
  { expanded: true, width: 57 },
  { expanded: true, width: 180 },
];

/** A finished task's notice: its long command is the subject and its outcome the only fact. */
const outcomeMessage = (subject: string, outcome: string) =>
  withCodePreviewMessageShell((message, _options, theme) => ({
    name: "background_task",
    label: "Background task",
    summary: { subject, metadata: [outcome], outcome: "success" },
    collapsed: () => new Text(messageText(message.content), 0, 0),
    expanded: () => expandedText(theme, "Output", [messageText(message.content)]),
    expandLabel: "output",
  }));

/** A message whose counters are alternatives, widest first, as a run's report counts them. */
const countedMessage = withCodePreviewMessageShell((message, _options, theme) => ({
  name: "status_message",
  label: "Agent report",
  summary: {
    subject: "auth-review",
    counters: ["2 finished · 1 failed · 1 with warnings", "2 finished · 1 failed", "2 finished"],
    outcome: "warning",
  },
  collapsed: () => new Text(messageText(message.content), 0, 0),
  expanded: () => expandedText(theme, "Report", [messageText(message.content)]),
  expandLabel: "report",
}));

/** A message from a sender whose long name wraps its expanded heading, then the sender's IDs. */
const namedSenderMessage = (sender: string) =>
  withCodePreviewMessageShell((message, _options, theme) => ({
    name: "session_message",
    label: "Session message",
    summary: { subject: sender, outcome: "returned", messageIcon: "received" },
    collapsed: () => new Text(messageText(message.content), 0, 0),
    expanded: () =>
      expandedBody(
        expandedAuthoredText(theme, undefined, messageText(message.content)),
        expandedDetails(theme, ["session-7f3a · ~/dev/web"]),
      ),
    expandLabel: "details",
  }));

/** An agent's report under a long run name, whose words a wrapped heading labels `Report`. */
const reportMessage = withCodePreviewMessageShell((message, _options, theme) => ({
  name: "agent_report",
  label: "Agent report",
  summary: { subject: "billing-ledger-reconciliation-review-follow-up-v2", outcome: "success" },
  collapsed: () => new Text(messageText(message.content), 0, 0),
  expanded: () =>
    expandedBody(
      expandedAuthoredText(theme, undefined, messageText(message.content)),
      expandedDetails(theme, ["run-7f3a"]),
    ),
  expandLabel: "details",
  bodyLabel: "Report",
}));

/** A task notice whose labeled facts include a command too long for the value column. */
const longFieldMessage = withCodePreviewMessageShell((message, _options, theme) => ({
  name: "background_task",
  label: "Background task",
  summary: { subject: "verify", metadata: ["finished in 2s"], outcome: "success" },
  collapsed: () => new Text(messageText(message.content), 0, 0),
  expanded: () =>
    expandedBody(
      expandedFields(theme, [
        { label: "Command", lines: [EXTREME_COMMAND] },
        { label: "Notify", lines: ["when it finishes"] },
      ]),
      expandedText(theme, "Output", [messageText(message.content)]),
    ),
  expandLabel: "output",
}));

/** A message whose collapsed words end in their own affordance, so the shell adds no second one. */
const longStatusMessage = withCodePreviewMessageShell((message, _options, theme) => ({
  name: "status_message",
  label: "Status message",
  summary: { subject: "from release-bot", outcome: "returned", messageIcon: "received" },
  collapsed: () => ({
    render: (width) =>
      authoredTextLines(messageText(message.content), width, theme, { expanded: false, indent: 0 }),
    invalidate: () => undefined,
  }),
  expanded: () => expandedText(theme, "Message", Str.split(messageText(message.content), "\n")),
  expandLabel: "message",
}));

const scenarios: ReadonlyArray<
  Omit<GalleryScenario, "args"> & {
    readonly tool: string;
    readonly args: object;
    readonly timing?: true;
    readonly narrow?: true;
    /** Views other than the gallery's, such as a very wide one for an extreme input. */
    readonly views?: readonly GalleryView[];
    /** Also rendered with framed tool rows to show where the duration sits. */
    readonly border?: true;
    /** Presentation settings the scenario is drawn with, such as a preview turned off. */
    readonly settings?: Partial<CodePreviewSettings>;
  }
> = [
  {
    tool: "fallback",
    title: "tool without renderers",
    args: { query: "complete input", limit: 7 },
    result: text("complete output"),
  },
  {
    tool: "tool_search",
    title: "native tool search pending long query",
    args: {
      query: "Find tools for " + Fn.pipe("project documentation ", Str.repeat(30)),
      limit: 8,
    },
    phase: "pending",
    narrow: true,
  },
  {
    tool: "tool_search",
    title: "native tool search heading wraps a long query",
    args: {
      query:
        "Find tools that read, search, and summarize project documentation, architecture notes, and release checklists",
      limit: 8,
    },
    phase: "pending",
    views: EXTREME_VIEWS,
  },
  {
    tool: "tool_search",
    title: "native tool search running",
    args: { query: "project documentation" },
    result: text("Searching available tool metadata"),
    phase: "running",
  },
  {
    tool: "tool_search",
    title: "native tool search returned receipt is not current activation",
    args: { query: "project documentation", limit: 2 },
    result: text(
      "Loaded 2 tools. They are available from your next call:\n- docs_lookup: Search documentation\n- docs_list: List documentation",
      { loaded: ["docs_lookup", "docs_list"] },
    ),
  },
  {
    tool: "tool_search",
    title: "native tool search empty receipt",
    args: { query: "no matching metadata" },
    result: text("No matching tools found.", { loaded: [] }),
  },
  {
    tool: "tool_search",
    title: "native tool search error with complete recovery",
    args: { query: "docs", limit: 0, extra: "preserved input" },
    result: text(
      "Error: limit must be a positive integer\nRetry with a valid limit and keep this recovery text",
      { loaded: [] },
    ),
    isError: true,
  },
  {
    tool: "tool_search",
    title: "native tool search malformed receipt keeps raw evidence",
    args: { query: "docs" },
    result: text("Unknown native response\nComplete diagnostic and recovery evidence", {
      loaded: "unrecognized",
      fullOutputPath: "/unrelated-field-not-a-receipt",
    }),
  },
  {
    tool: "web_enable",
    title: "third-party web tools enabled",
    args: {},
    result: text("Web tools enabled", { enabled: ["web_search", "fetch_content"] }),
  },
  {
    tool: "web_search",
    title: "third-party search with partial failures",
    args: { queries: ["Effect v4 documentation", "Provider availability"] },
    result: text("Search output and provider diagnostics", {
      queryCount: 2,
      successfulQueries: 1,
      totalResults: 3,
    }),
    narrow: true,
  },
  {
    tool: "web_search",
    title: "third-party search curator waiting",
    args: { query: "Architecture" },
    phase: "running",
    result: text("Waiting for approval in the search curator", {
      phase: "waiting-for-approval",
      curatorUrl: "http://localhost:1234",
    }),
  },
  {
    tool: "web_search",
    title: "third-party search cancelled",
    args: { query: "Architecture" },
    result: text("Search cancelled with original recovery details", {
      cancelled: true,
      error: "Search cancelled",
    }),
  },
  {
    tool: "source_check",
    title: "third-party source evidence is not a verdict",
    args: { claim: "The provider supports cancellation" },
    result: text("Sources, cited passages, and manual review guidance", {
      sourceCount: 2,
      passageCount: 4,
      searchCount: 1,
    }),
  },
  {
    tool: "source_check",
    title: "third-party heading without its own renderer wraps a long claim",
    args: {
      claim: "The provider supports cancellation of streaming responses after the first token",
    },
    result: text("Sources, cited passages, and manual review guidance", {
      sourceCount: 2,
      passageCount: 4,
      searchCount: 1,
    }),
  },
  {
    tool: "fetch_content",
    title: "third-party fetch missing recovery",
    args: { url: "https://example.test/docs" },
    result: text("Bounded page excerpt", { urlCount: 1, successful: 1, truncated: true }),
  },
  {
    tool: "fetch_content",
    title: "third-party fetch domain error",
    args: { url: "https://example.test/docs" },
    result: text("Provider failed\nFull agent-directed recovery information", {
      error: "The provider is unavailable",
    }),
  },
  {
    tool: "get_search_content",
    title: "third-party stored-content pagination",
    args: { responseId: "private-reference", offset: 0, limit: 100 },
    result: text("Content page\nContinue with the stored-content reference", {
      contentLength: 500,
      returnedChars: 100,
      nextOffset: 100,
      truncated: true,
      responseId: "private-reference",
    }),
  },
  {
    tool: "fetch_content",
    title: "third-party unfamiliar details preserve raw output",
    args: { url: "https://example.test/docs", prompt: "Keep the exact prompt" },
    result: text("Unfamiliar output and complete recovery information", { version: "future" }),
  },
  {
    tool: "codemode",
    title: "native long single-line source",
    args: { code: "// SOURCE_HEAD " + Fn.pipe("padding ", Str.repeat(250)) + " SOURCE_TAIL" },
    phase: "pending",
    narrow: true,
  },
  {
    tool: "codemode",
    title: "native program ending in a line break draws no blank row",
    args: { code: "const total = 1 + 2;\ntext(String(total));\n" },
    result: nativeResult("completed", [], "3"),
  },
  {
    tool: "codemode",
    title: "native no-call output is discoverable",
    args: { code: "text('Output is available');" },
    result: nativeResult("completed", [], "Output is available"),
  },
  {
    tool: "codemode",
    title: "native MCP discovery intent without dispatches",
    args: {
      code: 'text(await searchTools("navigate_page", { namespace: "mcp__chrome_devtools", limit: 1 }));',
    },
    timing: true,
    durationMs: 27,
    result: nativeResult("completed", [], "Local tool schema and navigation parameters"),
  },
  {
    tool: "codemode",
    title: "native generic tool discovery intent",
    args: { code: 'text(await describeTool("read"));' },
    result: nativeResult("completed", [], "Local read tool schema"),
  },
  {
    tool: "codemode",
    title: "native MCP discovery intent with mixed MCP and regular dispatches",
    args: {
      code: 'text(await describeNamespace("mcp__docs")); text(await tools.read({ path: "source.ts" })); text(await tools.mcp__docs__lookup({ query: "Guide" }));',
    },
    timing: true,
    durationMs: 120,
    result: nativeResult(
      "completed",
      [nativeCall("ok"), nativeArgumentCall("mcp__docs__lookup", { query: "Guide" })],
      "Local tool schemas and dispatched call output",
    ),
  },
  {
    tool: "codemode",
    title: "native discovery intent preserves incomplete dispatch evidence",
    args: {
      code: 'text(await describeNamespace("mcp__docs")); text(await tools.read({ path: "source.ts" }));',
    },
    result: nativeResult("completed", [nativeCall("ok"), null], "Retained output and uncertainty"),
  },
  {
    tool: "codemode",
    title: "native discovery intent with unfamiliar outer metadata",
    args: { code: 'text(await describeNamespace("mcp__docs"));' },
    result: text("Unrecognized outer header\nComplete unfamiliar output", { calls: [] }),
  },
  {
    tool: "codemode",
    title: "native running without nested calls",
    args: { code: "await new Promise(resolve => setTimeout(resolve, 1000));" },
    phase: "running",
    result: { content: [], details: { calls: [] } },
  },
  {
    tool: "codemode",
    title: "native six mixed calls remain collapsed",
    args: { code: "await Promise.allSettled(checks);" },
    phase: "running",
    result: {
      content: [],
      details: {
        calls: Array.from({ length: 6 }, (_, index) => ({
          ...nativeCall(
            index === 0 ? "error" : index > 3 ? "running" : "ok",
            index === 0 ? "First check failed" : undefined,
          ),
          id: `private/${index}`,
          args: JSON.stringify({ path: `/project/check-${index}.ts` }),
        })),
      },
    },
  },
  {
    tool: "codemode",
    title: "native hidden failure survives a narrow tree",
    args: { code: "await Promise.allSettled(checks);" },
    phase: "running",
    narrow: true,
    result: {
      content: [],
      details: {
        calls: [
          {
            ...nativeArgumentCall("mcp__docs__lookup", { query: "Getting started" }),
            status: "error",
            error: "Lookup failed\nRetained diagnostic detail",
          },
          ...Array.from({ length: 5 }, (_, index) => ({
            ...nativeCall("running"),
            id: `private/active-${index}`,
            args: JSON.stringify({ path: `/project/active-${index}.ts` }),
          })),
        ],
      },
    },
  },
  {
    tool: "codemode",
    title: "native measured timing and cost",
    durationMs: 3400,
    args: { code: "await runChecks();" },
    timing: true,
    result: nativeResult("completed", [
      { ...nativeCall("ok"), durationMs: 3200 },
      {
        ...nativeCall("ok"),
        name: "models.classify",
        args: "provider/classifier",
        durationMs: 2600,
        cost: 0.03,
      },
      {
        ...nativeCall("ok"),
        name: "models.generateImages",
        args: "provider/image-model",
        durationMs: 9100,
        cost: 0.04,
      },
    ]),
  },
  {
    tool: "codemode",
    title: "native short program and MCP child timing",
    args: { code: "await Promise.allSettled(checks);" },
    timing: true,
    durationMs: 379,
    result: nativeResult("completed", [
      { ...nativeCall("ok"), durationMs: 137 },
      { ...nativeArgumentCall("mcp__atlassian__tool_call", {}), durationMs: 253 },
      { ...nativeArgumentCall("mcp__docs__lookup", {}), durationMs: 0 },
    ]),
  },
  {
    tool: "codemode",
    title: "native oversized ledger keeps bounded recent evidence",
    args: { code: "await runManyChecks();" },
    result: nativeResult(
      "completed",
      Array.from({ length: 257 }, (_, index) => ({
        ...nativeCall(
          index === 0 || index === 256 ? "error" : "ok",
          Match.value(index).pipe(
            Match.when(0, () => "Older failure"),
            Match.when(256, () => "Recent failure"),
            Match.orElse(() => undefined),
          ),
        ),
        id: `private/${index}`,
        args: JSON.stringify({ path: `/project/check-${index}.ts` }),
      })),
    ),
  },
  {
    tool: "codemode",
    title: "native mixed-invalid ledger preserves valid neighbors",
    args: { code: "await runChecks();" },
    result: nativeResult("completed", [
      nativeCall("ok"),
      { broken: true },
      nativeCall("error", "Retained failure"),
    ]),
  },
  {
    tool: "codemode",
    title: "native historical unfinished call is unconfirmed",
    args: { code: "void tools.read({path: 'source.ts'});" },
    result: nativeResult("completed", [nativeCall("running")]),
  },
  {
    tool: "codemode",
    title: "native program awaiting approval",
    args: { code: "text(await tools.read({path: 'source.ts'}));" },
    phase: "pending",
  },
  {
    tool: "codemode",
    title: "native nested call running",
    args: { code: "text(await tools.read({path: 'source.ts'}));" },
    phase: "running",
    result: { content: [], details: { calls: [nativeCall("running")] } },
  },
  {
    tool: "codemode",
    title: "native returned child is neutral",
    args: { code: "return await tools.read({path: 'source.ts'});" },
    result: nativeResult("completed", [nativeCall("ok")]),
  },
  {
    tool: "codemode",
    title: "native handled child error",
    args: { code: "try { await tools.read({path: 'source.ts'}); } catch { text('Handled'); }" },
    result: nativeResult("completed", [nativeCall("error", "File not found")], "Handled"),
  },
  {
    tool: "codemode",
    title: "native targets survive truncated argument previews",
    args: {
      code: "await tools.edit({path: 'src/file.ts', edits: [{oldText: largeText, newText: 'new'}]});\nawait tools.bash({command: longCommand});\nawait tools.background_task({action: 'start', name: 'Verify previews', command: longCommand});\nawait tools.mcp__docs__lookup({query: largeInput});",
    },
    result: nativeResult("completed", [
      nativeArgumentCall("edit", {
        path: "/project/src/file.ts",
        edits: [{ oldText: Fn.pipe("old", Str.repeat(200)), newText: "new" }],
      }),
      nativeArgumentCall("bash", { command: Fn.pipe("pnpm validate; ", Str.repeat(40)) }),
      nativeArgumentCall("background_task", {
        action: "start",
        name: "Verify previews",
        command: Fn.pipe("pnpm validate; ", Str.repeat(40)),
      }),
      nativeArgumentCall("mcp__docs__lookup", { query: Fn.pipe("x", Str.repeat(400)) }),
    ]),
  },
  {
    tool: "codemode",
    title: "native MCP registered aliases and ambiguous names",
    args: { code: "await tools.mcp__docs__lookup({query: 'Effect services'});" },
    narrow: true,
    result: nativeResult("completed", [
      nativeArgumentCall("mcp__docs__lookup", { query: "Effect services" }),
      nativeArgumentCall("mcp__docs__lookup_1234abcd", { query: "Registered alias" }),
      nativeArgumentCall("mcp__team__docs__lookup", { query: "Ambiguous identity" }),
      nativeArgumentCall(`mcp__${Fn.pipe("x", Str.repeat(49))}__c2936b33`, {
        query: "Truncated identity",
      }),
    ]),
  },
  {
    tool: "codemode",
    title: "native MCP resources retain observed targets",
    args: {
      code: "text(await tools.read_mcp_resource({server: 'docs', uri: 'docs://guide/start'}));\ntext(await tools.list_mcp_resources({server: 'docs'}));\ntext(await tools.list_mcp_resource_templates({}));",
    },
    result: nativeResult("completed", [
      nativeArgumentCall("read_mcp_resource", {
        server: "docs",
        uri: "docs://guide/" + Fn.pipe("chapter/", Str.repeat(40)),
      }),
      nativeArgumentCall("list_mcp_resources", { server: "docs" }),
      nativeArgumentCall("list_mcp_resource_templates", {}),
    ]),
  },
  {
    tool: "codemode",
    title: "native MCP handled sign-in failure preserves recovery",
    args: { code: "text(await tools.mcp__docs__lookup({query: 'Effect services'}));" },
    result: nativeResult(
      "completed",
      [
        {
          ...nativeArgumentCall("mcp__docs__lookup", { query: "Effect services" }),
          status: "error",
          error: "MCP server docs requires sign-in. Run /mcp to sign in.",
        },
      ],
      "The call returned an MCP error",
    ),
  },
  {
    tool: "codemode",
    title: "native MCP unexplained failure remains visible",
    args: { code: "text(await tools.mcp__docs__lookup({}));" },
    result: nativeResult("completed", [
      {
        ...nativeArgumentCall("mcp__docs__lookup", {}),
        status: "error",
        error: "MCP tool docs/lookup returned an error",
      },
    ]),
  },
  {
    tool: "codemode",
    title: "native script failure retains partial output",
    args: { code: "text('Partial output'); throw new Error('Failed to finish');" },
    isError: true,
    result: nativeResult(
      "failed",
      [],
      "Partial output\n\nScript error:\nError: Failed to finish\nNo tool calls were made",
    ),
  },
  {
    tool: "codemode",
    title: "native parallel results show structured output readably",
    args: {
      code: "const results = await Promise.all([\n  tools.bash({command: 'ls src'}),\n  tools.bash({command: 'wc -l src/*.ts'}),\n  tools.mcp__docs__lookup({query: 'cart'}),\n]);\nresults.forEach(text);",
    },
    timing: true,
    border: true,
    durationMs: 2100,
    result: nativeResult(
      "completed",
      [
        { ...nativeArgumentCall("bash", { command: "ls src" }), durationMs: 13 },
        { ...nativeArgumentCall("bash", { command: "wc -l src/*.ts" }), durationMs: 2000 },
        { ...nativeArgumentCall("mcp__docs__lookup", { query: "cart" }), durationMs: 5 },
      ],
      '==> text 1/3 <==\n{"output":"cart.test.ts\\ncart.ts\\n","truncated":false,"exit_code":0,"wall_time_seconds":0}\n==> text 2/3 <==\n{"output":"      16 src/cart.test.ts\\n      21 src/cart.ts\\n      37 total\\n","truncated":false,"exit_code":0,"wall_time_seconds":2}\n==> text 3/3 <==\n{"content":[{"type":"text","text":"Cart docs: LineItem, subtotal"}]}',
    ),
  },
  {
    tool: "codemode",
    title: "native thrown error after partial output",
    args: {
      code: "text(await tools.bash({command: 'echo partial'}));\nthrow new Error('demo failure');",
    },
    isError: true,
    timing: true,
    border: true,
    durationMs: 57,
    result: nativeResult(
      "failed",
      [{ ...nativeArgumentCall("bash", { command: "echo partial" }), durationMs: 5 }],
      '{"output":"partial\\n","truncated":false,"exit_code":0,"wall_time_seconds":0}\nScript error:\nError: demo failure\n    at <anonymous> (codemode.js:2:7)\n\nTool calls made before the failure (they are not undone): bash (ok)',
    ),
  },
  {
    tool: "codemode",
    title: "native failed script retains abort diagnostic",
    args: { code: "await tools.read({path: 'source.ts'});" },
    isError: true,
    result: nativeResult(
      "failed",
      [nativeCall("cancelled")],
      "Script error:\nScript aborted: stopped",
    ),
  },
  {
    tool: "codemode",
    title: "native uncaught nested failure stopped the program",
    args: { code: "text(await tools.read({path: 'source.ts'}));" },
    isError: true,
    result: nativeResult(
      "failed",
      [nativeCall("error", "ENOENT: no such file or directory, open '/project/source.ts'")],
      "Script error:\nError: ENOENT: no such file or directory, open '/project/source.ts'\n\nTool calls made before the failure (they are not undone): read (error)",
    ),
  },
  {
    tool: "codemode",
    title: "native completed script leaves cancelled child uncertain",
    args: { code: "tools.read({path: 'source.ts'}); return 1;" },
    result: nativeResult("completed", [nativeCall("cancelled")], "1"),
  },
  {
    tool: "codemode",
    title: "native malformed historical details",
    args: { code: "return 'Historical output';" },
    result: text("Historical output", { calls: [{ old: true }] }),
  },
  {
    tool: "codemode",
    title: "native recoverable output stays quiet",
    args: { code: "text('large output');" },
    result: nativeResult(
      "completed",
      [],
      "Warning: truncated output\nhead…tail\n[Full output: /tmp/native-output.txt (read with offset/limit)]",
      "/tmp/native-output.txt",
    ),
  },
  {
    tool: "codemode",
    title: "native recoverable output preserves child failures",
    args: {
      code: "try { await tools.read({path: 'missing.ts'}); } catch { text('large output'); }",
    },
    result: nativeResult(
      "completed",
      [nativeCall("error", "File not found")],
      "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\nhead…tail\n\n[Full output: /tmp/native-output.txt (read with offset/limit)]",
      "/tmp/native-output.txt",
    ),
  },
  {
    tool: "codemode",
    title: "native truncated output could not be saved",
    args: { code: "text('large output');" },
    result: nativeResult(
      "completed",
      [],
      "Warning: truncated output (original token count: 20)\nTotal output lines: 1\n\nhead…tail\n\n[Could not save the full output: No such directory]",
    ),
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP pending tool",
    args: { query: "Getting started" },
    phase: "pending",
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP progress",
    args: { query: "Getting started" },
    phase: "running",
    result: text("Searching documentation", docsLookup),
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP neutral returned output",
    args: { query: "Getting started" },
    result: text("Guide\nInstallation\nUsage", docsLookup),
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP error and recovery",
    args: { query: "Getting started" },
    isError: true,
    result: text("Lookup failed\nRetry with another query; retained recovery detail", docsLookup),
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP saved clipping",
    args: {},
    result: text(
      "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\nHEAD\nTAIL\n\n[Full output: /tmp/mcp-output.txt (read it with offset/limit)]",
      { server: "docs", tool: "lookup", fullOutputPath: "/tmp/mcp-output.txt" },
    ),
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP unsaved clipping",
    args: {},
    result: text(
      "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\nHEAD\nTAIL\n\n[Could not save the full output: ENOSPC]",
      docsLookup,
    ),
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP long error inside Pi's truncation envelope",
    args: { query: "Getting started" },
    isError: true,
    result: text(
      `Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\nIndex docs-main has no page for that query\n${Fn.pipe("diagnostic\n", Str.repeat(3))}…8000 tokens truncated…\n\n[Full output: /tmp/mcp-error.txt (read it with offset/limit)]`,
      { server: "docs", tool: "lookup", fullOutputPath: "/tmp/mcp-error.txt" },
    ),
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP long single-line output",
    args: { query: "Getting started" },
    result: text(
      JSON.stringify({
        items: Array.from({ length: 80 }, (_, id) => ({ id, title: `Item ${id}` })),
      }),
      docsLookup,
    ),
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP unclassified native result",
    args: { query: "Raw output" },
    result: {
      content: [{ type: "text", text: "Unclassified output retained in full" }],
      details: undefined,
    },
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP native image",
    args: {},
    result: {
      content: [
        { type: "text", text: "Image retained by Pi" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      details: docsLookup,
    },
  },
  {
    tool: "read_mcp_resource",
    title: "MCP read resource",
    args: { server: "docs", uri: "docs://guide" },
    result: text("Resource contents", { server: "docs", tool: "read_mcp_resource" }),
  },
  {
    tool: "list_mcp_resources",
    title: "MCP resource pagination and partial server failure",
    args: {},
    result: text(
      JSON.stringify({
        resources: [{ server: "docs", uri: "docs://guide", name: "Guide" }],
        nextCursor: "next",
        errors: [{ server: "offline", error: "Connection unavailable\nDiagnostic evidence" }],
      }),
      { server: "", tool: "list_mcp_resources" },
    ),
  },
  {
    tool: "list_mcp_resource_templates",
    title: "MCP empty template listing",
    args: { server: "docs" },
    result: text('{"resourceTemplates":[]}', {
      server: "docs",
      tool: "list_mcp_resource_templates",
    }),
  },
  {
    tool: "bash",
    title: "bash awaiting approval",
    args: { command: "rm -rf build" },
    phase: "pending",
  },
  {
    tool: "bash",
    title: "bash streaming output",
    args: { command: "pnpm test" },
    result: text("> vitest run\n\n RUN  v4.1.10 /project\n ✓ tests/a.test.ts (3 tests)"),
    phase: "running",
  },
  {
    tool: "bash",
    title: "bash success",
    args: { command: "pnpm lint" },
    result: text("Found 0 warnings and 0 errors."),
  },
  {
    tool: "bash",
    title: "bash long command beside its expansion tag",
    args: { command: "cd /Users/someone/dev/cosmic-pi && pnpm --filter pi-code-previews test" },
    result: text("Test Files  94 passed (94)\nTests  502 passed (502)"),
  },
  {
    tool: "bash",
    title: "bash hidden output, command as wide as a phone row wraps beside its tag",
    args: { command: "pnpm --filter pi-code-previews exec vitest run -u" },
    result: text("Test Files  94 passed (94)"),
    settings: { bashResultPreview: false },
  },
  {
    tool: "read",
    title: "read hidden content, heading as wide as a phone row wraps beside its tag",
    args: { path: "docs/architecture/tool-presentation.md" },
    result: text("# Tool presentation\n"),
    settings: { readContentPreview: false },
  },
  {
    tool: "bash",
    title: "bash long command wraps beneath its heading",
    args: {
      command:
        "pnpm vitest run --reporter=dot packages/pi-code-previews/tests/preview/compact-issues.test.ts",
    },
    result: text("2 passed"),
  },
  {
    tool: "bash",
    title: "bash multi-line command hangs beneath its heading",
    args: { command: "cd packages/pi-code-previews\npnpm typecheck && pnpm test" },
    result: text("Tests 1204 passed"),
  },
  {
    tool: "bash",
    title: "bash 449-character command keeps its tail",
    args: { command: EXTREME_COMMAND },
    result: text("ok"),
    views: EXTREME_VIEWS,
  },
  {
    tool: "bash",
    title: "bash heredoc shows once, labeled apart from its output",
    args: { command: HEREDOC_COMMAND },
    result: text("Wrote release-notes.md"),
    views: EXTREME_VIEWS,
  },
  {
    tool: "bash",
    title: "bash success ending in a newline draws no blank row",
    args: { command: "git --no-pager diff --stat && node --version" },
    result: text(" src/cart.ts | 4 ++++\n 1 file changed, 4 insertions(+)\nv22.22.1\n\n"),
  },
  {
    tool: "bash",
    title: "bash cancelled",
    args: { command: "pnpm dev" },
    result: text("Command aborted"),
    isError: true,
  },
  {
    tool: "read",
    title: "read success",
    args: { path: "/project/src/a.ts" },
    result: text("export const a = 1;\nexport const b = 2;\n"),
  },
  {
    tool: "read",
    title: "read lines wider than the code column",
    args: { path: "/project/src/cart.ts" },
    result: text(cartBefore),
  },
  {
    tool: "grep",
    title: "grep matches",
    args: { pattern: "TODO", path: "/project/src" },
    result: text("a.ts:3: // TODO fix the retry\nb.ts:9: // TODO remove after launch"),
  },
  {
    tool: "find",
    title: "find files",
    args: { pattern: "*.test.ts", path: "/project" },
    result: text("tests/a.test.ts\ntests/b.test.ts"),
  },
  {
    tool: "find",
    title: "absolute and relative listing paths retain their identity",
    args: { pattern: "*", path: "/project" },
    result: text("/\n/etc/hosts\netc/passwd"),
  },
  {
    tool: "find",
    title: "find with no matches",
    args: { pattern: "*.snap", path: "/project" },
    result: text("No files found matching pattern"),
  },
  {
    tool: "ls",
    title: "list an empty directory",
    args: { path: "/project/empty" },
    result: text("(empty directory)"),
  },
  {
    tool: "ls",
    title: "list a directory",
    args: { path: "/project" },
    result: text("src/\ntests/\npackage.json"),
  },
  {
    tool: "grep",
    title: "grep match limit with agent notes",
    args: { pattern: "TODO", path: "/project/src", limit: 2 },
    result: text(
      "a.ts:3: // TODO fix the retry\nb.ts:9: // TODO remove after launch\n\n[2 matches limit reached. Use limit=4 for more, or refine pattern]",
      { matchLimitReached: 2 },
    ),
  },
  {
    tool: "bash",
    title: "bash truncated output with agent notes",
    args: { command: "cat build.log" },
    result: text(
      "step 49\nstep 50\n\n[Showing lines 49-50 of 50. Full output: /tmp/pi-bash-1.log]",
      { truncation: { truncated: true }, fullOutputPath: "/tmp/pi-bash-1.log" },
    ),
  },
  {
    tool: "read",
    title: "read oversized first line",
    args: { path: "/project/dist/app.js", offset: 40 },
    result: text(
      "[Line 40 is 61.2KB, exceeds 50.0KB limit. Use bash: sed -n '40p' /project/dist/app.js | head -c 51200]",
      { truncation: { truncated: true, firstLineExceedsLimit: true } },
    ),
  },
  {
    tool: "bash",
    title: "bash test failure",
    args: { command: "pnpm test" },
    result: text(
      "> vitest run\n\n FAIL  tests/auth.test.ts > rejects expired tokens\nAssertionError: expected 401 to be 200\n ELIFECYCLE  Test failed.\n\nCommand exited with code 1",
    ),
    isError: true,
  },
  {
    tool: "bash",
    title: "bash missing file",
    args: { command: "cat does-not-exist.txt" },
    result: text(
      "cat: does-not-exist.txt: No such file or directory\n\nCommand exited with code 1",
    ),
    isError: true,
    border: true,
  },
  {
    tool: "bash",
    title: "bash permission denied",
    args: { command: "./scripts/deploy.sh" },
    result: text("bash: ./scripts/deploy.sh: Permission denied\n\nCommand exited with code 126"),
    isError: true,
  },
  {
    tool: "bash",
    title: "bash unknown command named",
    args: { command: "pnpx tsx build.ts" },
    result: text("bash: line 1: pnpx: command not found\n\nCommand exited with code 127"),
    isError: true,
  },
  {
    tool: "bash",
    title: "bash command not found",
    args: { command: "pnpx tsx build.ts" },
    result: text("Command exited with code 127"),
    isError: true,
  },
  {
    tool: "bash",
    title: "bash risky command",
    args: { command: "rm -rf build" },
    result: text("done"),
  },
  {
    tool: "read",
    title: "read missing file",
    args: { path: "/project/src/missing.ts" },
    result: text("ENOENT: no such file or directory, open '/project/src/missing.ts'"),
    isError: true,
  },
  {
    tool: "read",
    title: "read rejected for malformed JSON arguments",
    args: {},
    result: text(
      'Invalid arguments for tool "read": Expected \',\' or \'}\' after property value in JSON at position 28 (line 1 column 29)\n\nReceived arguments:\n{"path":"/project/src/a.ts" "offset":120}',
    ),
    isError: true,
    border: true,
  },
  {
    tool: "grep",
    title: "grep rejected for arguments that do not match its schema",
    args: { pattern: "TODO", limit: "many" },
    result: text(
      'Validation failed for tool "grep":\n  - limit: must be number\n\nReceived arguments:\n{\n  "pattern": "TODO",\n  "limit": "many"\n}',
    ),
    isError: true,
  },
  {
    tool: "read",
    title: "read numeric-string range",
    args: { path: "/project/src/a.ts", offset: "120", limit: "3" },
    result: text(
      "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n\n[37 more lines in file. Use offset=123 to continue.]",
    ),
  },
  {
    tool: "edit",
    title: "edit without a match",
    args: { path: "/project/src/a.ts", edits: [{ oldText: "a", newText: "b" }] },
    result: text(
      "Could not find the exact text in /project/src/a.ts. The old text must match exactly including all whitespace and newlines.",
    ),
    isError: true,
  },
  {
    tool: "edit",
    title: "edit with empty text to replace",
    args: { path: "/project/src/a.ts", edits: [{ oldText: "", newText: "b" }] },
    result: text("edits[0].oldText must not be empty in /project/src/a.ts."),
    isError: true,
  },
  {
    tool: "edit",
    title: "edit that changes nothing",
    args: { path: "/project/src/a.ts", oldText: "a", newText: "a" },
    result: text(
      "No changes made to /project/src/a.ts. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.",
    ),
    isError: true,
  },
  {
    tool: "edit",
    title: "edit on a missing file",
    args: { path: "/project/src/missing.ts", edits: [{ oldText: "a", newText: "b" }] },
    result: text("Could not edit file: /project/src/missing.ts. Error code: ENOENT."),
    isError: true,
  },
  {
    tool: "write",
    title: "write with a possible secret",
    args: {
      path: "/project/.env",
      content: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    },
    result: text("Successfully wrote 60 bytes to /project/.env"),
  },
  {
    tool: "write",
    title: "write running",
    args: { path: "/project/src/a.ts", content: Fn.pipe(writeSource, Str.replace("2", "20")) },
    phase: "running",
  },
  {
    tool: "write",
    title: "write overwrite",
    args: { path: "/project/src/a.ts", content: Fn.pipe(writeSource, Str.replace("2", "20")) },
    result: text("Successfully wrote to /project/src/a.ts", writeBefore(writeSource)),
  },
  {
    tool: "write",
    title: "write new file",
    args: { path: "/project/src/new.ts", content: writeSource },
    result: text("Successfully wrote to /project/src/new.ts", writeBefore(undefined)),
  },
  {
    tool: "write",
    title: "write new file with lines wider than the code column",
    args: { path: "/project/src/cart.test.ts", content: cartTestSource },
    result: text("Successfully wrote to /project/src/cart.test.ts", writeBefore(undefined)),
  },
  {
    tool: "write",
    title: "write without changes",
    args: { path: "/project/src/a.ts", content: writeSource },
    result: text("Successfully wrote to /project/src/a.ts", writeBefore(writeSource)),
  },
  {
    tool: "write",
    title: "write converting line endings",
    args: { path: "/project/src/a.ts", content: writeSource },
    result: text(
      "Successfully wrote to /project/src/a.ts",
      writeBefore(Fn.pipe(writeSource, Str.replaceAll("\n", "\r\n"), Str.replace(/\r\n$/u, ""))),
    ),
  },
  { tool: "edit", title: "edit proposal", args: editArgs, phase: "pending" },
  {
    tool: "edit",
    title: "edit applied",
    args: editArgs,
    result: text("Successfully replaced text in /project/src/a.ts.", {
      diff: " 1 export const a = 1;\n-2 export const b = 2;\n+2 export const b = 20;\n 3 export const c = 3;",
    }),
    border: true,
  },
  {
    tool: "edit",
    title: "edit applied with hidden context keeps the requested text",
    args: {
      path: "/project/src/a.ts",
      edits: [
        {
          oldText: "export const a = 1;\n// one\n// two\n// three\nexport const b = 2;",
          newText: "export const a = 10;\n// one\n// two\n// three\nexport const b = 20;",
        },
      ],
    },
    result: text("Successfully replaced 1 block(s) in /project/src/a.ts.", {
      diff: "-1 export const a = 1;\n+1 export const a = 10;\n 2 // one\n   ...\n-5 export const b = 2;\n+5 export const b = 20;",
    }),
  },
  {
    tool: "edit",
    title: "edit insertion numbers later context by its new line",
    args: {
      path: "/project/src/cart.ts",
      edits: [
        {
          oldText: "}\n\nexport function applyDiscount",
          newText:
            "}\n\nexport function itemCount(items: LineItem[]): number {\n  return items.length;\n}\n\nexport function applyDiscount",
        },
      ],
    },
    result: text("Successfully replaced 1 block(s) in /project/src/cart.ts.", {
      diff: generateDiffString(cartBefore, cartAfter).diff,
    }),
  },
  {
    tool: "edit",
    title: "edit diff counts the unchanged lines it hides",
    args: {
      path: "/project/src/config.ts",
      edits: [{ oldText: "export const option20 = 20;", newText: "export const option20 = 200;" }],
    },
    result: text("Successfully replaced 1 block(s) in /project/src/config.ts.", {
      diff: generateDiffString(
        Arr.join(
          Arr.makeBy(40, (index) => `export const option${index} = ${index};`),
          "\n",
        ),
        Arr.join(
          Arr.makeBy(40, (index) => `export const option${index} = ${index === 20 ? 200 : index};`),
          "\n",
        ),
      ).diff,
    }),
  },
  {
    tool: "edit",
    title: "edit without a diff",
    args: editArgs,
    result: text("Successfully replaced text in /project/src/a.ts."),
  },
  {
    tool: "status_demo",
    title: "open question waits on a person",
    args: {
      subject: "Which database should the migration target before the release?",
      waiting: true,
    },
    phase: "running",
    narrow: true,
  },
  {
    tool: "status_demo",
    title: "issue detail breaks a long path after its directory",
    args: {
      subject: "auth-review",
      issue: "auth-review: full report saved to a file",
      issueSeverity: "info",
      issueDetail:
        "28,200 of 152,310 characters kept. Report file: ~/.pi/agent/subagents/reports/session-1/agent-1-1-4f1c.md · 152,310 characters, 3,172 lines",
    },
    result: text("Report summary"),
  },
  {
    tool: "status_demo",
    title: "long subject beside its outcome fact",
    args: { subject: LONG_COMMAND, metadata: "finished in 1m 33s" },
    result: text("Test Files  2 passed (2)"),
  },
  {
    tool: "status_demo",
    title: "449-character subject beside its outcome fact",
    args: { subject: EXTREME_COMMAND, metadata: "finished in 399ms" },
    result: text("ok"),
    views: EXTREME_VIEWS,
  },
  {
    tool: "status_demo",
    title: "heading arrow wraps with the name it points at",
    args: { subject: "Message → billing-and-invoicing-migration-review-follow-up" },
    result: text("Sent"),
  },
  {
    tool: "status_demo",
    title: "affordance that reveals only the subject shows only where the heading cuts it",
    args: {
      subject: "A watercolor otter reading a newspaper on a riverbank at dawn",
      expandLabel: "prompt",
      subjectOnly: true,
    },
    phase: "running",
  },
  {
    tool: "status_demo",
    title: "queued request",
    args: { subject: "Release checklist", outcome: "queued", metadata: "queued" },
    result: text("Queued behind 2 earlier questionnaires"),
  },
  {
    tool: "status_demo",
    title: "routine running state kept on expansion",
    args: { subject: "dev server", state: "running" },
    result: text("VITE v6.3.5  ready in 412 ms"),
  },
  {
    tool: "status_demo",
    title: "paused run",
    args: { subject: "auth review", outcome: "paused", metadata: "paused" },
    result: text("Paused by the user"),
  },
  {
    tool: "status_demo",
    title: "paused run whose body doesn't state it keeps its state line",
    args: { subject: "auth review", outcome: "paused" },
    result: text("Reviewed 3 of 7 files"),
  },
  {
    tool: "status_demo",
    title: "a body listing paused work states the state, so no state line",
    args: { subject: "auth review", outcome: "paused" },
    result: text("0/1 finished · 1 paused\n‖ auth-review · paused"),
  },
  {
    tool: "status_demo",
    title: "a body that only mentions running keeps the running line",
    args: { subject: "dev server" },
    result: text("The dev server keeps running on port 5173"),
    phase: "running",
  },
  {
    tool: "status_demo",
    title: "a body counting running work states the state, so no running line",
    args: { subject: "subagents" },
    result: text("0/2 finished · 2 running"),
    phase: "running",
  },
  {
    tool: "status_demo",
    title: "an open call whose request is queued shows the queued glyph",
    args: { subject: "Release checklist", queued: true },
    result: text("Asked for answers to 4 questions"),
    phase: "running",
  },
  {
    tool: "status_demo",
    title: "an open queued call whose body says so has no state line",
    args: { subject: "Release checklist", queued: true },
    result: text("Queued behind 2 earlier questionnaires"),
    phase: "running",
  },
  {
    tool: "status_demo",
    title: "prose subject cut at a word",
    args: {
      subject:
        "Summarize the open review comments on the authentication refactor and list the blockers",
    },
    result: text("3 blockers"),
    narrow: true,
  },
  {
    tool: "status_demo",
    title: "path subject keeps its file name",
    args: {
      subject: "packages/pi-code-previews/src/preview/compact-header-layout-elision.ts",
      path: true,
    },
    result: text("Checked"),
    narrow: true,
  },
  {
    tool: "status_demo",
    title: "expansion adds nothing, so no affordance",
    args: { subject: "status all", metadata: "no questionnaires", expandLabel: false },
    result: text("No questionnaires"),
  },
  {
    tool: "status_demo",
    title: "summary-only row names what expansion reveals after its timing",
    args: {
      subject: "release check",
      metadata: "12 passed",
      expandLabel: "checks",
      summaryOnly: true,
    },
    result: text("12 checks passed\nlint, typecheck, unit, e2e, …"),
    durationMs: 2100,
    timing: true,
  },
  {
    tool: "status_demo",
    title: "empty partial update keeps the expansion affordance",
    args: { subject: "Which release should ship first?", waiting: true },
    result: text(""),
    phase: "running",
  },
  {
    tool: "status_demo",
    title: "a clipped body's own affordance closes the row after its timing",
    args: { subject: "build log", clipped: true, expandLabel: "log" },
    result: text("Compiled 48 modules\nWrote dist/app.js\nDone"),
    durationMs: 3400,
    timing: true,
  },
  {
    tool: "status_demo",
    title: "a receipt with a warning shows the warning, not a state line",
    args: {
      subject: "from release-bot",
      messageIcon: "received",
      issue: "Integration tests need docker, which isn't running",
      issueSeverity: "warning",
      state: "received",
    },
    result: text("Release notes are ready."),
  },
  {
    tool: "status_demo",
    title: "a paused run whose issue states it has no state line",
    args: {
      subject: "auth review",
      outcome: "paused",
      metadata: "paused",
      issue: "auth-review is paused",
      issueSeverity: "info",
    },
    result: text("Paused by the user"),
  },
  {
    tool: "status_demo",
    title: "a waiting row's state line uses its first counter",
    args: { subject: "Release checklist", waiting: true, counter: "needs your input" },
    result: text("Asked 4 questions"),
    phase: "running",
  },
  {
    tool: "status_demo",
    title: "long facts wrap between whole facts, never after a separator",
    args: {
      subject: "auth review",
      details: [
        "auth-review: agent-1 · reviewer → openai-codex/gpt-5.6-sol:high · 84k tokens · $0.61 · 4m 30s",
        "Saved to .pi/generated-images/openai-image-2026-09-27T10-00-00-000Z-ig_0a1b2c3d.png",
        "  task-0000000011 · /project/packages/pi-code-previews · pid 48633",
      ],
    },
    result: text("Reviewed 7 files"),
  },
  {
    tool: "bash",
    title: "bash streaming a long log shows its latest lines",
    args: { command: "pnpm test" },
    result: text(
      Arr.join(
        Arr.map(Arr.range(1, 12), (index) => `✓ tests/suite-${index}.test.ts (3 tests)`),
        "\n",
      ),
    ),
    phase: "running",
    border: true,
  },
  {
    tool: "bash",
    title: "bash output longer than the preview names the hidden lines",
    args: { command: "pnpm lint" },
    result: text(
      Arr.join(
        Arr.map(Arr.range(1, 14), (index) => `src/file-${index}.ts: ok`),
        "\n",
      ),
    ),
    border: true,
  },
  {
    tool: "read",
    title: "read longer than the preview names the hidden lines where they are hidden",
    args: { path: "/project/src/config.ts" },
    result: text(
      Arr.join(
        Arr.map(Arr.range(1, 30), (index) => `export const setting${index} = ${index};`),
        "\n",
      ),
    ),
    border: true,
  },
  {
    tool: "grep",
    title: "grep longer than the preview names the hidden matches where they are hidden",
    args: { pattern: "TODO", path: "/project/src" },
    result: text(
      Arr.join(
        Arr.map(Arr.range(1, 24), (index) => `file-${index}.ts:${index}: // TODO item ${index}`),
        "\n",
      ),
    ),
  },
  {
    tool: "grep",
    title: "grep with context lines names the hidden lines where they are hidden",
    args: { pattern: "TODO", path: "/project/src", context: 1 },
    result: text(
      Arr.join(
        Arr.flatMap(Arr.range(1, 8), (index) => [
          `file-${index}.ts-${index * 10 - 1}- const before = ${index};`,
          `file-${index}.ts:${index * 10}: // TODO item ${index}`,
          `file-${index}.ts-${index * 10 + 1}- const after = ${index};`,
        ]),
        "\n",
      ),
    ),
  },
  {
    tool: "grep",
    title: "grep reaching its default limit states the number",
    args: { pattern: "TODO", path: "/project/src" },
    result: text(
      "a.ts:3: // TODO fix the retry\nb.ts:9: // TODO remove after launch\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]",
      { matchLimitReached: 100 },
    ),
  },
  {
    tool: "find",
    title: "find longer than the preview names the hidden paths where they are hidden",
    args: { pattern: "*.ts", path: "/project/src" },
    result: text(
      Arr.join(
        Arr.map(Arr.range(1, 30), (index) => `module-${index}.ts`),
        "\n",
      ),
    ),
  },
  {
    tool: "ls",
    title: "ls longer than the preview names the hidden entries where they are hidden",
    args: { path: "/project/src" },
    result: text(
      Arr.join(
        Arr.map(Arr.range(1, 30), (index) => `entry-${index}.ts`),
        "\n",
      ),
    ),
  },
  {
    tool: "find",
    title: "find result limit with agent notes",
    args: { pattern: "*.ts", path: "/project/src", limit: 2 },
    result: text(
      "a.ts\nb.ts\n\n[2 results limit reached. Use limit=4 for more, or refine pattern]",
      { resultLimitReached: 2 },
    ),
  },
  {
    tool: "status_demo",
    title: "an expanded heading wraps its counter instead of cutting the subject",
    args: {
      subject: "Release checklist for the authentication refactor",
      waiting: true,
      counter: "needs your input",
    },
    result: text("Asked 4 questions"),
    phase: "running",
  },
  {
    tool: "grep",
    title: "grep in a deeply nested directory",
    args: {
      pattern: "renderExpansionAffordance",
      path: "/project/packages/pi-code-previews/src/tools/renderers/shared",
      glob: "*.ts",
    },
    result: text("builtin-expanded-content.ts:12: import { renderExpansionAffordance }"),
  },
  {
    tool: "edit",
    title: "edit a deeply nested file",
    args: {
      path: "/project/packages/pi-code-previews/src/tools/renderers/shared/builtin-expanded-content.ts",
      edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
    },
    result: text(
      "Successfully replaced text in /project/packages/pi-code-previews/src/tools/renderers/shared/builtin-expanded-content.ts.",
      { diff: "-1 const a = 1;\n+1 const a = 2;\n 2 const b = 2;" },
    ),
  },
  {
    tool: "find",
    title: "find in a deeply nested directory",
    args: {
      pattern: "*.test.ts",
      path: "/project/packages/pi-code-previews/tests/tools/renderers/shared",
    },
    result: text("cache-retirement.test.ts\npreview-text.test.ts"),
  },
  {
    tool: "read",
    title: "read a deeply nested file",
    args: {
      path: "/project/packages/pi-code-previews/src/tools/renderers/shared/builtin-expanded-content.ts",
      offset: 1,
      limit: 2,
    },
    result: text(
      "import * as Predicate from 'effect/Predicate';\nimport * as Arr from 'effect/Array';",
    ),
  },
];

/**
 * What a bare `/code-previews` shows, drawn as Pi draws a notice: one column in, wrapping at the
 * terminal edge with no hanging indent, so a line that's too long shows up flush-left.
 */
const commandOverviewFrames = Effect.fn("Gallery.commandOverviewFrames")(function* () {
  let run: ((args: string) => Promise<void>) | undefined;
  const notices: string[] = [];
  registerCodePreviewsCommand(
    extensionApiFixture({
      registerCommand: (_name, definition) => {
        run = (args) =>
          definition.handler(
            args,
            // Outside the TUI, health posts its report as a notice rather than a panel.
            extensionContextFixture({
              hasUI: true,
              mode: "rpc",
              ui: { notify: (message: string) => void notices.push(message) },
            }),
          );
      },
    }),
  );
  const invoke = run;
  if (invoke) {
    yield* Effect.promise(() => invoke(""));
    yield* Effect.promise(() => invoke("health"));
    // Settings status reads the session's settings, which an installed session capability admits.
    installCodePreviewSessionCapability({
      ...inertScheduler,
      run: () => Promise.reject(new Error("unexpected settings runtime call")),
    });
    yield* Effect.promise(() => invoke("settings status")).pipe(
      Effect.ensuring(Effect.sync(() => clearCodePreviewSessionCapability())),
    );
  }
  return Arr.flatMap(
    [
      ["help", notices[0] ?? ""],
      ["health", notices[1] ?? ""],
      ["settings status", notices[2] ?? ""],
    ] as const,
    ([command, notice]) =>
      Arr.flatMap([180, 57], (width) => [
        `── /code-previews ${command} · ${width} cols`,
        ...Arr.flatMap(Str.split(notice, "\n"), (line) =>
          Arr.map(Arr.chunksOf(Arr.fromIterable(` ${line}`), width), Arr.join("")),
        ),
        "",
      ]),
  );
});

/** `/code-previews settings` › Enabled tools, with two previews off and one tool owned elsewhere. */
function enabledToolsFrames(): string[] {
  const settings = {
    ...defaultCodePreviewSettings,
    tools: Arr.filter([...ALL_CODE_PREVIEW_TOOLS], (tool) => tool !== "tool_search"),
    readContentPreview: false,
    bashResultPreview: false,
  };
  setCodePreviewToolStatus("grep", {
    state: "skipped-conflict",
    owner: { source: "npm:pi-ripgrep", origin: "package", scope: "user", path: "" },
  });
  try {
    const items = createSettingsCategoryItems(
      () => settings,
      () => undefined,
      plainTheme,
    );
    const tools = Option.getOrThrow(Arr.findFirst(items, (item) => item.id === "tools"));
    const outputs = Option.getOrThrow(
      Arr.findFirst(items, (item) => item.id === "group:outputPreviews"),
    );
    return Arr.flatMap(
      [
        [tools, `Enabled tools (row value ${tools.currentValue})`],
        [outputs, `Output previews (row value ${outputs.currentValue})`],
      ] as const,
      ([item, title]) => {
        const submenu = item.submenu?.(item.currentValue, () => undefined);
        return Arr.flatMap([100, 57], (width) => [
          `── /code-previews settings › ${title} · ${width} cols`,
          ...Arr.map(submenu?.render(width) ?? [], (line) =>
            Fn.pipe(stripAnsi(line), Str.replace(/\s+$/u, "")),
          ),
          "",
        ]);
      },
    );
  } finally {
    setCodePreviewToolStatus("grep", { state: "installed" });
  }
}

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders builtin tool scenarios in both collapsed styles", () =>
    Effect.gen(function* () {
      const saved = codePreviewSettings;
      const lines: string[] = [];
      try {
        for (const [style, background] of [
          ["compact", undefined],
          ["preview", undefined],
          ["compact", "border"],
          ["preview", "border"],
        ] as const) {
          const tools = registered(style, background);
          tools.set("fallback", withCodePreviewRenderers({ name: "fallback" }, {}));
          tools.set("status_demo", statusDemo());
          const label = background ? `${style} ${background}` : style;
          for (const scenario of background
            ? Arr.filter(scenarios, (candidate) => candidate.border === true)
            : scenarios)
            lines.push(
              ...withPresentationSettings(
                { toolCallTiming: scenario.timing ?? false, ...scenario.settings },
                () =>
                  galleryFrames(
                    tools.get(scenario.tool)!,
                    {
                      ...scenario,
                      title: `${label} · ${scenario.title}`,
                    },
                    scenario.views ??
                      (scenario.narrow
                        ? [
                            { expanded: false, width: 16 },
                            { expanded: false, width: 57 },
                            { expanded: true, width: 40 },
                            { expanded: true, width: 57 },
                          ]
                        : undefined),
                  ),
              ),
            );
        }
        for (const style of ["compact", "preview"] as const)
          withPresentationSettings({ toolCallCollapsedStyle: style }, () =>
            lines.push(
              ...galleryMessageFrames(statusDemoMessage, {
                title: `${style} · message whose expansion reveals more`,
                message: {
                  role: "custom",
                  customType: "status_message",
                  content: "Release notes are ready for review.",
                  display: true,
                  timestamp: 0,
                },
              }),
              ...galleryMessageFrames(
                longSubjectMessage(
                  "A watercolor otter reading a newspaper on a riverbank at dawn",
                  false,
                ),
                {
                  title: `${style} · message heading cuts a long prose subject at a word`,
                  message: {
                    role: "custom",
                    customType: "status_message",
                    content: "Saved to otter.png",
                    display: true,
                    timestamp: 0,
                  },
                },
              ),
              ...galleryMessageFrames(
                longSubjectMessage(
                  "packages/pi-better-openai/generated/openai-image-2026-09-27T10-00-00-000Z.png",
                  true,
                ),
                {
                  title: `${style} · message heading keeps a long path's file name`,
                  message: {
                    role: "custom",
                    customType: "status_message",
                    content: "Saved to the project.",
                    display: true,
                    timestamp: 0,
                  },
                },
              ),
              ...galleryMessageFrames(outcomeMessage(LONG_COMMAND, "finished in 1m 33s"), {
                title: `${style} · message heading keeps its outcome beside a cut subject`,
                message: {
                  role: "custom",
                  customType: "background_task",
                  content: "Test Files  2 passed (2)",
                  display: true,
                  timestamp: 0,
                },
              }),
              ...galleryMessageFrames(outcomeMessage(EXTREME_COMMAND, "finished in 399ms"), {
                title: `${style} · message heading keeps its outcome beside a 449-character subject`,
                message: {
                  role: "custom",
                  customType: "background_task",
                  content: "ok",
                  display: true,
                  timestamp: 0,
                },
                views: EXTREME_VIEWS,
              }),
              ...galleryMessageFrames(countedMessage, {
                title: `${style} · message heading keeps the widest counter that fits`,
                message: {
                  role: "custom",
                  customType: "status_message",
                  content: "Two reviews finished; one failed.",
                  display: true,
                  timestamp: 0,
                },
              }),
              ...galleryMessageFrames(
                namedSenderMessage(
                  "checkout redesign review for the acme platform team and billing",
                ),
                {
                  title: `${style} · a wrapped message heading labels the message beneath it`,
                  message: {
                    role: "custom",
                    customType: "session_message",
                    content: "Can you rerun the web tests after my API change?",
                    display: true,
                    timestamp: 0,
                  },
                  views: EXTREME_VIEWS,
                },
              ),
              ...galleryMessageFrames(
                namedSenderMessage(
                  "billing-and-invoicing-migration-review-follow-up-for-the-legacy-ledger-export-v2",
                ),
                {
                  title: `${style} · a long hyphenated name breaks after a hyphen`,
                  message: {
                    role: "custom",
                    customType: "session_message",
                    content: "The refresh test fixtures moved to tests/auth/fixtures.",
                    display: true,
                    timestamp: 0,
                  },
                  views: EXTREME_VIEWS,
                },
              ),
              ...galleryMessageFrames(reportMessage, {
                title: `${style} · a wrapped report heading labels the report beneath it`,
                message: {
                  role: "custom",
                  customType: "agent_report",
                  content: "Found 3 stale references to the legacy ledger export.",
                  display: true,
                  timestamp: 0,
                },
                views: EXTREME_VIEWS,
              }),
              ...galleryMessageFrames(longFieldMessage, {
                title: `${style} · a field too long for the value column stacks beneath its label`,
                message: {
                  role: "custom",
                  customType: "background_task",
                  content: "ok",
                  display: true,
                  timestamp: 0,
                },
                views: EXTREME_VIEWS,
              }),
              ...galleryMessageFrames(longStatusMessage, {
                title: `${style} · clipped message keeps one affordance`,
                message: {
                  role: "custom",
                  customType: "status_message",
                  content: Arr.join(
                    Arr.map(Arr.range(1, 14), (line) => `Release note ${line}: one change.`),
                    "\n",
                  ),
                  display: true,
                  timestamp: 0,
                },
              }),
            ),
          );
      } finally {
        setCodePreviewSettings(saved);
      }
      lines.push(...enabledToolsFrames());
      lines.push(...(yield* commandOverviewFrames()));
      yield* writeGallerySection(directory, "pi-code-previews", lines);
    }),
  );
});
