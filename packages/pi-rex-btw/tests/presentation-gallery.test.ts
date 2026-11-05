import { initTheme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Str from "effect/String";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import {
  applyPresentationSettings,
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  writeGallerySection,
} from "pi-code-previews/testing";
import { Text } from "@earendil-works/pi-tui";
import {
  extensionContextFixture,
  plainTheme,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import rexBtw from "../src/extension.ts";
import { ORIENTATION, orientationLine } from "../src/parent/application.ts";
import {
  conversationText,
  failureText,
  PARENT_TOOL,
  type ParentReadFailure,
  type ParentToolDetails,
} from "../src/parent/contract.ts";
import { registerParentConversationTool } from "../src/parent/tool.ts";
import type { ParentConversation } from "../src/parent/transcript.ts";

const parent = { id: "01a1a579-f3f7-7000-a118-5bf07d3e800a", path: "/sessions/parent.jsonl" };
const today = "2026-11-04T06:18:36.000Z";

const conversation = (overrides: Partial<ParentConversation>): ParentConversation => ({
  parentId: parent.id,
  requested: 15,
  earlier: true,
  compacted: false,
  items: [
    {
      role: "user",
      at: today,
      text: "Deploy the cart service to staging now?",
      tools: [],
    },
    {
      role: "assistant",
      at: today,
      text: "I'll check the tests first.",
      tools: [
        {
          name: "bash",
          input: '{"command":"pnpm test --filter cart"}',
          subject: "pnpm test --filter cart",
          outcome: "failed",
          output: "FAIL src/cart.test.ts > applies a discount",
        },
        {
          name: "read",
          input: '{"path":"src/cart.ts"}',
          subject: "src/cart.ts",
          outcome: "done",
          output: "",
        },
      ],
    },
    {
      role: "note",
      source: "pi-intercom-message",
      at: today,
      text: "From the web session: the endpoint moved to `/v2/items`.",
      tools: [],
    },
    {
      role: "assistant",
      at: today,
      text: "The discount test fails because `applyDiscount` rounds **before** summing:\n\n- fix the rounding\n- rerun the tests",
      tools: [
        {
          name: "edit",
          input: '{"path":"src/cart.ts","oldText":"round(","newText":"Math.round("}',
          subject: "src/cart.ts",
          outcome: "pending",
          output: "",
        },
      ],
    },
  ],
  ...overrides,
});

const succeeded = (details: ParentConversation): AgentToolResult<ParentToolDetails> => ({
  content: [{ type: "text", text: conversationText(details) }],
  details,
});

const failed = (failure: ParentReadFailure["failure"]): AgentToolResult<ParentToolDetails> => {
  const details = { failure, requested: 15 };
  return { content: [{ type: "text", text: failureText(details) }], details, isError: true };
};

const scenarios = [
  { title: "read the latest messages", args: {}, result: succeeded(conversation({})) },
  {
    title: "read a short conversation from its start",
    args: { messages: 20 },
    result: succeeded(conversation({ requested: 20, earlier: false })),
  },
  {
    title: "read after the parent compacted",
    args: {},
    result: succeeded(
      conversation({
        compacted: true,
        items: [
          {
            role: "summary",
            text: "The user asked to deploy the cart service; tests were failing.",
            tools: [],
          },
          ...conversation({}).items.slice(2),
        ],
      }),
    ),
  },
  {
    title: "read a parent with no messages yet",
    args: {},
    result: succeeded(conversation({ items: [], earlier: false })),
  },
  { title: "the parent's file is gone", args: {}, result: failed("missing") },
  { title: "the parent's file can't be read", args: {}, result: failed("unreadable") },
] as const;

/**
 * `/btw` notices, drawn one column in as Pi draws them: its help, and a session whose conversation
 * a pane couldn't read, where no pane opens and the notice says why.
 */
const refusalLines = (): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    vi.stubEnv("REX_SESSION", "session:s");
    vi.stubEnv("REX_BLOCK", "block:b");
    vi.stubEnv("REX_BIN_DIR", "/nonexistent-rex-bin");
    const lines: string[] = [];
    try {
      const cases = [
        ["/btw help · overview", "help", undefined],
        ["/btw notice · a session that was never saved", "what changed?", undefined],
        [
          "/btw notice · a session with no messages yet",
          "what changed?",
          "/nonexistent/session.jsonl",
        ],
      ] as const;
      for (const [label, args, sessionFile] of cases) {
        const notices: string[] = [];
        const host = recordingExtensionHost({}, { registerFlag() {}, getFlag: () => undefined });
        const ctx = extensionContextFixture({
          cwd: "/project",
          mode: "tui",
          hasUI: true,
          ui: { notify: (message: string) => void notices.push(message) },
          sessionManager: {
            getSessionId: () => parent.id,
            getSessionFile: () => sessionFile,
          },
        });
        rexBtw(host.pi);
        yield* Effect.promise(() => Promise.resolve(host.emit("session_start", ctx)));
        yield* Effect.promise(() => Promise.resolve(host.commands.get("btw")?.handler(args, ctx)));
        yield* Effect.promise(() => Promise.resolve(host.emit("session_shutdown", ctx)));
        for (const width of [100, 57])
          lines.push(
            `── ${label} · ${width} cols`,
            ...Arr.flatMap(notices, (notice) =>
              Arr.map(new Text(plainTheme.fg("warning", notice), 1, 0).render(width), Str.trimEnd),
            ),
            "",
          );
      }
    } finally {
      vi.unstubAllEnvs();
    }
    return lines;
  });

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  beforeAll(() => initTheme("dark", false));

  it.effect("renders the BTW child's parent conversation tool and orientation line", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const) {
        const restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
        try {
          const { tools } = captureRegistrations((pi) =>
            registerParentConversationTool(pi, parent, {
              run: () => Promise.reject(new Error("not executed")),
            }),
          );
          const tool = Option.getOrThrow(Arr.findFirst(tools, ({ name }) => name === PARENT_TOOL));
          lines.push(
            ...galleryFrames(tool, { title: `${style} · reading`, args: {}, phase: "running" }),
          );
          for (const scenario of scenarios)
            lines.push(
              ...galleryFrames(tool, {
                title: `${style} · ${scenario.title}`,
                args: scenario.args,
                result: scenario.result,
                isError: scenario.result.isError === true,
              }),
            );
        } finally {
          restore();
        }
      }
      const orientations = [
        ["child that sees its parent", ORIENTATION.sees],
        ["child of an unsaved parent", ORIENTATION.blind],
      ] as const;
      for (const [label, message] of orientations)
        for (const width of [100, 57])
          lines.push(
            `── orientation line above the editor · ${label} · ${width} cols`,
            ...orientationLine(message, plainTheme).render(width),
            "",
          );
      lines.push(...(yield* refusalLines()));
      yield* writeGallerySection(directory, "pi-rex-btw", lines);
    }),
  );
});
