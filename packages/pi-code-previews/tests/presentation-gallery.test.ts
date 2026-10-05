import type * as Schema from "effect/Schema";
import type { AgentToolResult, ToolInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { extensionApiFixture, opaqueFixture } from "pi-cosmic-core/testing";
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
import {
  CodePreviewPresentationOwner,
  createCodePreviewRendererResolver,
} from "../src/application/tool-renderers";

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
    "mcp__docs__lookup",
    "read_mcp_resource",
    "list_mcp_resources",
    "list_mcp_resource_templates",
  ];
  const metadata: ToolInfo[] = names.map((name) => {
    const tool: ToolInfo = {
      name,
      description: name,
      parameters: opaqueFixture({ type: "object" }),
      exposure: "direct",
      sourceInfo: {
        source: "builtin",
        path:
          name.startsWith("mcp__") || name.endsWith("mcp_resource") || name.startsWith("list_mcp_")
            ? "builtin:mcp"
            : `builtin:${name}`,
        scope: "temporary",
        origin: "top-level",
      },
    };
    if (name === "mcp__docs__lookup") tool.namespace = { name: "mcp__docs" };
    return tool;
  });
  const owner = new CodePreviewPresentationOwner();
  owner.publish("/project", new Set(ALL_CODE_PREVIEW_TOOLS), {
    defer: () => () => undefined,
    schedule: () => () => undefined,
  });
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
        name === "mcp__docs__lookup" ? nativeMcpCall : undefined,
      )!,
    ]),
  );
}

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
/** Live before-write evidence; replayed details carry only its size. */
const writeBefore = (content: string | undefined) => ({
  codePreviewBeforeWrite: content === undefined ? undefined : { kind: "content", content },
});
const writeSource = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";

interface NativeGalleryDetails {
  calls: unknown[];
  fullOutputPath?: string;
}
const nativeResult = (
  status: "completed" | "failed",
  calls: unknown[] = [],
  output = "Script output",
  fullOutputPath?: string,
): AgentToolResult<unknown> => {
  const details: NativeGalleryDetails = { calls };
  if (fullOutputPath) details.fullOutputPath = fullOutputPath;
  return {
    content: [
      { type: "text", text: `Script ${status}\nWall time 0.1 seconds\nOutput:\n` },
      { type: "text", text: output },
    ],
    details,
  };
};
const nativeCall = (status: string, error?: string) => {
  const call = { id: "private/1", name: "read", args: '{"path":"/project/source.ts"}', status };
  return error ? { ...call, error } : call;
};

type NativeArgumentCallInput = Schema.JsonObject;
const nativeArgumentCall = (name: string, args: NativeArgumentCallInput) => {
  const json = JSON.stringify(args);
  return {
    ...nativeCall("ok"),
    id: `private/${name}`,
    name,
    args: json.length > 200 ? `${json.slice(0, 197)}...` : json,
  };
};

const scenarios: ReadonlyArray<
  Omit<GalleryScenario, "args"> & {
    readonly tool: string;
    readonly args: object;
    readonly timing?: true;
    readonly narrow?: true;
  }
> = [
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
    result: {
      content: [{ type: "text", text: "Historical output" }],
      details: { calls: [{ old: true }] },
    },
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
    result: {
      content: [{ type: "text", text: "Searching documentation" }],
      details: { server: "docs", tool: "lookup" },
    },
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP neutral returned output",
    args: { query: "Getting started" },
    result: {
      content: [{ type: "text", text: "Guide\nInstallation\nUsage" }],
      details: { server: "docs", tool: "lookup" },
    },
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP error and recovery",
    args: { query: "Getting started" },
    isError: true,
    result: {
      content: [
        { type: "text", text: "Lookup failed\nRetry with another query; retained recovery detail" },
      ],
      details: { server: "docs", tool: "lookup" },
    },
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP saved clipping",
    args: {},
    result: {
      content: [
        {
          type: "text",
          text: "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\nHEAD\nTAIL\n\n[Full output: /tmp/mcp-output.txt (read it with offset/limit)]",
        },
      ],
      details: { server: "docs", tool: "lookup", fullOutputPath: "/tmp/mcp-output.txt" },
    },
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP unsaved clipping",
    args: {},
    result: {
      content: [
        {
          type: "text",
          text: "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\nHEAD\nTAIL\n\n[Could not save the full output: ENOSPC]",
        },
      ],
      details: { server: "docs", tool: "lookup" },
    },
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP long error inside Pi's truncation envelope",
    args: { query: "Getting started" },
    isError: true,
    result: {
      content: [
        {
          type: "text",
          text: `Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\nIndex docs-main has no page for that query\n${"diagnostic\n".repeat(3)}…8000 tokens truncated…\n\n[Full output: /tmp/mcp-error.txt (read it with offset/limit)]`,
        },
      ],
      details: { server: "docs", tool: "lookup", fullOutputPath: "/tmp/mcp-error.txt" },
    },
  },
  {
    tool: "mcp__docs__lookup",
    title: "MCP long single-line output",
    args: { query: "Getting started" },
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            items: Array.from({ length: 80 }, (_, id) => ({ id, title: `Item ${id}` })),
          }),
        },
      ],
      details: { server: "docs", tool: "lookup" },
    },
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
      details: { server: "docs", tool: "lookup" },
    },
  },
  {
    tool: "read_mcp_resource",
    title: "MCP read resource",
    args: { server: "docs", uri: "docs://guide" },
    result: {
      content: [{ type: "text", text: "Resource contents" }],
      details: { server: "docs", tool: "read_mcp_resource" },
    },
  },
  {
    tool: "list_mcp_resources",
    title: "MCP resource pagination and partial server failure",
    args: {},
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            resources: [{ server: "docs", uri: "docs://guide", name: "Guide" }],
            nextCursor: "next",
            errors: [{ server: "offline", error: "Connection unavailable\nDiagnostic evidence" }],
          }),
        },
      ],
      details: { server: "", tool: "list_mcp_resources" },
    },
  },
  {
    tool: "list_mcp_resource_templates",
    title: "MCP empty template listing",
    args: { server: "docs" },
    result: {
      content: [{ type: "text", text: '{"resourceTemplates":[]}' }],
      details: { server: "docs", tool: "list_mcp_resource_templates" },
    },
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
    result: {
      content: [
        {
          type: "text",
          text: "a.ts:3: // TODO fix the retry\nb.ts:9: // TODO remove after launch\n\n[2 matches limit reached. Use limit=4 for more, or refine pattern]",
        },
      ],
      details: { matchLimitReached: 2 },
    },
  },
  {
    tool: "bash",
    title: "bash truncated output with agent notes",
    args: { command: "cat build.log" },
    result: {
      content: [
        {
          type: "text",
          text: "step 49\nstep 50\n\n[Showing lines 49-50 of 50. Full output: /tmp/pi-bash-1.log]",
        },
      ],
      details: { truncation: { truncated: true }, fullOutputPath: "/tmp/pi-bash-1.log" },
    },
  },
  {
    tool: "read",
    title: "read oversized first line",
    args: { path: "/project/dist/app.js", offset: 40 },
    result: {
      content: [
        {
          type: "text",
          text: "[Line 40 is 61.2KB, exceeds 50.0KB limit. Use bash: sed -n '40p' /project/dist/app.js | head -c 51200]",
        },
      ],
      details: { truncation: { truncated: true, firstLineExceedsLimit: true } },
    },
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
  {
    tool: "edit",
    title: "edit proposal",
    args: {
      path: "/project/src/a.ts",
      edits: [{ oldText: "export const b = 2;", newText: "export const b = 20;" }],
    },
    phase: "pending",
  },
  {
    tool: "edit",
    title: "edit applied",
    args: {
      path: "/project/src/a.ts",
      edits: [{ oldText: "export const b = 2;", newText: "export const b = 20;" }],
    },
    result: text("Successfully replaced text in /project/src/a.ts.", {
      diff: " 1 export const a = 1;\n-2 export const b = 2;\n+2 export const b = 20;\n 3 export const c = 3;",
    }),
  },
  {
    tool: "edit",
    title: "edit without a diff",
    args: {
      path: "/project/src/a.ts",
      edits: [{ oldText: "export const b = 2;", newText: "export const b = 20;" }],
    },
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
