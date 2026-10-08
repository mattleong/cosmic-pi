import type * as Schema from "effect/Schema";
import type { AgentToolResult, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { extensionApiFixture } from "pi-cosmic-core/testing";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  writeGallerySection,
  withPresentationSettings,
  type GalleryScenario,
} from "../testing";
import { defaultCodePreviewSettings } from "../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../src/config/state";
import { ALL_CODE_PREVIEW_TOOLS } from "../src/tools/names";
import { WEB_ACCESS_TOOLS, isWebAccessTool } from "../src/third-party/web-access/identity";
import {
  CodePreviewPresentationOwner,
  createCodePreviewRendererResolver,
} from "../src/application/tool-renderers";
import { nativeCall as callRecord, nativeReceipt, scriptResult } from "./support/native-codemode";
import { builtinToolInfo, inertScheduler } from "./support/renderer-host";

/** Registered builtin renderers in one collapsed style. */
function registered(style: "compact" | "preview") {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    tools: [...ALL_CODE_PREVIEW_TOOLS],
    toolCallCollapsedStyle: style,
    toolCallTiming: false,
  });
  const names = [
    ...ALL_CODE_PREVIEW_TOOLS,
    ...WEB_ACCESS_TOOLS,
    "mcp__docs__lookup",
    "read_mcp_resource",
    "list_mcp_resources",
    "list_mcp_resource_templates",
  ];
  const metadata = names.map((name) => {
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
    names.map((name) => [
      name,
      captured.resolveToolRenderers(
        name,
        name === "mcp__docs__lookup" ? nativeMcpCall : isWebAccessTool(name) ? webCall : undefined,
      )!,
    ]),
  );
}

/** Opaque third-party content; the adapter preserves it and adds exact raw expansion. */
const webCall: ToolRenderers = {
  renderCall: (args) => new Text(JSON.stringify(args), 0, 0),
  renderResult: (result) =>
    new Text(result.content.find((part) => part.type === "text")?.text.slice(0, 200) ?? "", 0, 0),
};

/** The shape of Pi's own MCP call: its `server/tool` label, then the arguments. */
const nativeMcpCall: ToolRenderers = {
  renderCall: (args, _theme, context) => {
    const fields = Object.entries(Predicate.isObject(args) ? args : {});
    const entries = fields.map(([key, value]) => `${key}=${JSON.stringify(value)}`);
    const lines = fields.map(([key, value]) => `  ${key}: ${String(value)}`);
    return new Text(
      context.expanded
        ? ["docs/lookup", ...lines].join("\n")
        : ["docs/lookup", ...entries].join(" "),
      0,
      0,
    );
  },
};

const text = <Details>(value: string, details?: Details): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: value }],
  details: details ?? {},
});
const docsLookup = { server: "docs", tool: "lookup" };
/** Live before-write evidence; replayed details carry only its size. */
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

const scenarios: ReadonlyArray<
  Omit<GalleryScenario, "args"> & {
    readonly tool: string;
    readonly args: object;
    readonly timing?: true;
    readonly narrow?: true;
  }
> = [
  {
    tool: "tool_search",
    title: "native tool search pending long query",
    args: { query: "Find tools for " + "project documentation ".repeat(30), limit: 8 },
    phase: "pending",
    narrow: true,
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
    args: { code: "// SOURCE_HEAD " + "padding ".repeat(250) + " SOURCE_TAIL" },
    phase: "pending",
    narrow: true,
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
          index === 0 ? "Older failure" : index === 256 ? "Recent failure" : undefined,
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
        edits: [{ oldText: "old".repeat(200), newText: "new" }],
      }),
      nativeArgumentCall("bash", { command: "pnpm validate; ".repeat(40) }),
      nativeArgumentCall("background_task", {
        action: "start",
        name: "Verify previews",
        command: "pnpm validate; ".repeat(40),
      }),
      nativeArgumentCall("mcp__docs__lookup", { query: "x".repeat(400) }),
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
      nativeArgumentCall(`mcp__${"x".repeat(49)}__c2936b33`, { query: "Truncated identity" }),
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
        uri: "docs://guide/" + "chapter/".repeat(40),
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
      `Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\nIndex docs-main has no page for that query\n${"diagnostic\n".repeat(3)}…8000 tokens truncated…\n\n[Full output: /tmp/mcp-error.txt (read it with offset/limit)]`,
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
    args: { path: "/project/src/a.ts", content: writeSource.replace("2", "20") },
    phase: "running",
  },
  {
    tool: "write",
    title: "write overwrite",
    args: { path: "/project/src/a.ts", content: writeSource.replace("2", "20") },
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
      writeBefore(writeSource.replaceAll("\n", "\r\n").replace(/\r\n$/u, "")),
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
  },
  {
    tool: "edit",
    title: "edit without a diff",
    args: editArgs,
    result: text("Successfully replaced text in /project/src/a.ts."),
  },
];

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders builtin tool scenarios in both collapsed styles", () =>
    Effect.gen(function* () {
      const saved = codePreviewSettings;
      const lines: string[] = [];
      try {
        for (const style of ["compact", "preview"] as const) {
          const tools = registered(style);
          for (const scenario of scenarios)
            lines.push(
              ...withPresentationSettings({ toolCallTiming: scenario.timing ?? false }, () =>
                galleryFrames(
                  tools.get(scenario.tool)!,
                  {
                    ...scenario,
                    title: `${style} · ${scenario.title}`,
                  },
                  scenario.narrow
                    ? [
                        { expanded: false, width: 16 },
                        { expanded: false, width: 60 },
                        { expanded: true, width: 40 },
                      ]
                    : undefined,
                ),
              ),
            );
        }
      } finally {
        setCodePreviewSettings(saved);
      }
      yield* writeGallerySection(directory, "pi-code-previews", lines);
    }),
  );
});
