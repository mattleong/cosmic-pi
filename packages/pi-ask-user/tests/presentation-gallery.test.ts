import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyPresentationSettings,
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  galleryMessageFrames,
  galleryTranscriptFrames,
  withPresentationSettings,
  writeGallerySection,
  GALLERY_VIEWS,
  type GalleryMessageScenario,
  type GalleryScenario,
} from "pi-code-previews/testing";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { ASYNC_MESSAGE_TYPE } from "../src/boundary/host-delivery.ts";
import type { AsyncQuestionnaireSnapshot } from "../src/questionnaire/async-model.ts";
import { formatAsyncSnapshot } from "../src/questionnaire/format.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type {
  AskUserAsyncControl,
  AskUserAsyncRequest,
  AskUserQuestion,
  AskUserRequest,
} from "../src/questionnaire/schema.ts";
import { registerAskUserTool } from "../src/tools/ask-user.ts";
import {
  registerAsyncAskUserMessageRenderer,
  registerAsyncAskUserTools,
  renderAskUserAsyncMessage,
} from "../src/tools/ask-user-async.ts";
import { noExecution } from "./support/questionnaire.ts";
import { DOWN, ENTER, RIGHT, SPACE, makeDialog, typeText } from "./support/dialog.ts";
import { stripTerminalControls } from "pi-cosmic-core/security";
import type { AskUserDialog } from "../src/ui/dialog.ts";

const text = (value: string) => [{ type: "text" as const, text: value }];

const environment: AskUserQuestion = {
  key: "environment",
  title: "Environment",
  prompt: "Which environment should receive this release first?",
  mode: "single",
  choices: [
    {
      value: "staging",
      label: "Staging (Recommended)",
      description: "Catches integration problems before customers see them.",
    },
    { value: "production", label: "Production", description: "Ships now; monitor closely." },
  ],
};
const checks: AskUserQuestion = {
  key: "checks",
  title: "Checks",
  prompt: "Which checks must pass before merging?",
  mode: "multiple",
  choices: [
    { value: "unit", label: "Unit tests", description: "Fast and already reliable." },
    { value: "lint", label: "Lint", description: "Catches style drift." },
    { value: "types", label: "Type check", description: "Slower on large packages." },
  ],
};
const library: AskUserQuestion = {
  key: "library",
  title: "Library",
  prompt: "Which date library should the parser use?",
  mode: "single",
  choices: [
    { value: "date-fns", label: "date-fns", description: "Small, modular functions." },
    { value: "luxon", label: "Luxon", description: "Rich time zone support." },
  ],
};
const summary: AskUserQuestion = {
  key: "summary",
  title: "Summary",
  prompt: "How should the changelog describe this release?",
  mode: "text",
};

const chosen = {
  key: "environment",
  kind: "choices",
  values: ["staging"],
  labels: ["Staging (Recommended)"],
} as const;
const custom = {
  key: "library",
  kind: "custom",
  text: "Keep the built-in Intl API",
  note: "Avoid a new dependency",
} as const;
const oneChoice: AskUserOutcome = { outcome: "submitted", answers: [chosen] };
const severalChoices: AskUserOutcome = {
  outcome: "submitted",
  answers: [
    { key: "checks", kind: "choices", values: ["unit", "lint"], labels: ["Unit tests", "Lint"] },
  ],
};
const customWithNote: AskUserOutcome = { outcome: "submitted", answers: [custom] };
const everyKind: AskUserOutcome = {
  outcome: "submitted",
  answers: [
    chosen,
    {
      key: "checks",
      kind: "choices",
      values: ["unit", "types"],
      labels: ["Unit tests", "Type check"],
    },
    custom,
    {
      key: "summary",
      kind: "text",
      text: "Faster startup and smaller bundles.",
      note: "Mention the 30% gain",
    },
  ],
};
const store: AskUserQuestion = {
  key: "store",
  title: "Persistence",
  prompt: "Which persistence layer should the cart use?",
  mode: "single",
  choices: [
    {
      value: "sqlite",
      label: "SQLite",
      description: "Local file storage with minimal setup.",
      preview: "```ts\nconst db = new Database('cart.sqlite');\n```",
    },
    {
      value: "postgres",
      label: "Postgres",
      description: "Shared database for scaled deployments.",
    },
    { value: "memory", label: "In-memory", description: "Resets on restart." },
  ],
};
const features: AskUserQuestion = {
  key: "features",
  title: "Features",
  prompt: "Which cart features should ship first?",
  mode: "multiple",
  choices: [
    { value: "quantity", label: "Quantity editing", description: "Update item quantities." },
    { value: "discounts", label: "Discount codes", description: "Apply promotional savings." },
    { value: "saved", label: "Saved carts", description: "Restore carts across visits." },
    { value: "inventory", label: "Inventory checks", description: "Check stock at checkout." },
  ],
};
const notes: AskUserQuestion = {
  key: "notes",
  title: "Notes",
  prompt: "Anything else the implementer should know?",
  mode: "text",
};
const cartPlan: AskUserOutcome = {
  outcome: "submitted",
  answers: [
    { key: "store", kind: "choices", values: ["sqlite"], labels: ["SQLite"] },
    {
      key: "features",
      kind: "choices",
      values: ["quantity", "discounts", "inventory"],
      labels: ["Quantity editing", "Discount codes", "Inventory checks"],
    },
    { key: "notes", kind: "text", text: "Keep prices in integer cents." },
  ],
};
const longWritten: AskUserOutcome = {
  outcome: "submitted",
  answers: [
    {
      key: "summary",
      kind: "text",
      text: "Startup is faster because the parser loads lazily, and bundles are smaller.\nThe settings page also remembers the last tab you opened.",
      note: "Mention the 30% startup gain and credit the contributors who measured it.",
    },
  ],
};
const chosenWithCustom: AskUserOutcome = { outcome: "submitted", answers: [chosen, custom] };
const cancelled: AskUserOutcome = { outcome: "cancelled", answers: [] };

const asyncRequest: AskUserAsyncRequest = {
  questions: [environment, library],
  independentWork: "Update the changelog and run the unit tests.",
  blockedWork: "Deploying the release.",
};
type SnapshotFields = Pick<
  AsyncQuestionnaireSnapshot,
  "status" | "presentation" | "delivery" | "outcome"
>;
const snapshot = (requestId: string, fields: SnapshotFields): AsyncQuestionnaireSnapshot => ({
  requestId,
  deliveryId: `${requestId}-answer`,
  independentWork: asyncRequest.independentWork,
  blockedWork: asyncRequest.blockedWork,
  titles: Arr.map(asyncRequest.questions, ({ key, title }) => ({ key, title })),
  ...fields,
});
const open = snapshot("ask-1", { status: "pending", presentation: "open", delivery: "pending" });
const queued = snapshot("ask-2", {
  status: "pending",
  presentation: "queued",
  delivery: "pending",
});
const settled = { presentation: "settled" } as const;
const answered = (delivery: AsyncQuestionnaireSnapshot["delivery"]) =>
  snapshot("ask-1", { ...settled, status: "submitted", delivery, outcome: chosenWithCustom });

type ToolName = "ask_user" | "ask_user_async" | "ask_user_async_control";
type ToolArgs = AskUserRequest | AskUserAsyncRequest | AskUserAsyncControl;
interface ToolScenario extends GalleryScenario {
  readonly tool: ToolName;
  /** Also drawn collapsed at desktop width, where a collapsed row can say more. */
  readonly wide?: boolean;
}
const WIDE_COLLAPSED = [{ expanded: false, width: 180 }] as const;

const executed = (
  tool: ToolName,
  title: string,
  args: ToolArgs,
  register: (pi: ExtensionAPI) => void,
) =>
  Effect.promise(() =>
    Option.getOrThrow(
      Arr.findFirst(captureRegistrations(register).tools, (entry) => entry.name === tool),
    ).execute("gallery", args, undefined, undefined, extensionContextFixture()),
  ).pipe(Effect.map((result): ToolScenario => ({ tool, title, args, result })));

const asked = (title: string, args: AskUserRequest, outcome: AskUserOutcome) =>
  executed("ask_user", title, args, (pi) =>
    registerAskUserTool(pi, () => Promise.resolve(outcome)),
  );
const started = (title: string, result: AsyncQuestionnaireSnapshot) =>
  executed("ask_user_async", title, asyncRequest, (pi) =>
    registerAsyncAskUserTools(pi, () => Promise.resolve(result), noExecution),
  );
const controlled = (
  title: string,
  args: AskUserAsyncControl,
  requests: ReadonlyArray<AsyncQuestionnaireSnapshot>,
) =>
  executed("ask_user_async_control", title, args, (pi) =>
    registerAsyncAskUserTools(pi, noExecution, () => Promise.resolve({ requests })),
  );
const failed = (tool: ToolName, title: string, args: ToolArgs, message: string) =>
  Effect.succeed<ToolScenario>({
    tool,
    title,
    args,
    isError: true,
    result: { content: text(message), details: {} },
  });
const live = (tool: ToolName, title: string, args: ToolArgs, partial?: ToolScenario["result"]) =>
  Effect.succeed<ToolScenario>({ tool, title, args, phase: "running", result: partial });

const generation = "5f0c2d8e-3b1a-4c7e-9d2f-6a8b0e1c4d57";
const message = (
  title: string,
  outcome: AskUserOutcome,
  requestId: string,
): GalleryMessageScenario => {
  const delivered = snapshot(requestId, {
    ...settled,
    status: outcome.outcome,
    delivery: "sending",
    outcome,
  });
  return {
    title,
    message: {
      role: "custom",
      customType: ASYNC_MESSAGE_TYPE,
      content: formatAsyncSnapshot(delivered),
      display: true,
      details: {
        generation,
        deliveryId: delivered.deliveryId,
        requestId,
        outcome,
        titles: delivered.titles,
      },
      timestamp: 0,
    },
  };
};
const messages = [
  message("answers submitted", chosenWithCustom, "ask-1"),
  message("questionnaire cancelled", cancelled, "ask-2"),
];

const registerAll = (pi: ExtensionAPI) => {
  registerAskUserTool(pi, noExecution);
  registerAsyncAskUserTools(pi, noExecution, noExecution);
  registerAsyncAskUserMessageRenderer(pi);
};

const deploy: AskUserQuestion = {
  key: "deploy",
  title: "Deploy",
  prompt: "Deploy the cart service to staging now?",
  mode: "single",
  choices: [
    { value: "yes", label: "Yes", description: "Deploy immediately." },
    { value: "no", label: "No", description: "Wait for review." },
  ],
};

interface DialogScenario {
  readonly title: string;
  readonly request: AskUserRequest;
  /** Keys pressed before the frame is drawn. */
  readonly keys: ReadonlyArray<string>;
  readonly widths?: ReadonlyArray<number>;
}

const dialogScenarios: ReadonlyArray<DialogScenario> = [
  { title: "one question", request: { questions: [deploy] }, keys: [] },
  { title: "one question · help expanded", request: { questions: [deploy] }, keys: ["?"] },
  {
    title: "one question · custom answer row",
    request: { questions: [deploy] },
    keys: [DOWN, DOWN],
  },
  { title: "one multiple-choice question", request: { questions: [checks] }, keys: ["1", "3"] },
  { title: "one text question · writing", request: { questions: [summary] }, keys: ["Faster"] },
  {
    title: "several questions",
    request: { questions: [environment, checks, library, summary] },
    keys: [],
    widths: [100, 57, 40],
  },
  {
    title: "several questions · choice with a preview",
    request: { questions: [store, features, notes] },
    keys: [],
    widths: [180, 57],
  },
  {
    title: "several questions · writing an answer",
    request: { questions: [store, features, notes] },
    keys: ["1", "1", "2", "4", DOWN, DOWN, ENTER, "Keep prices in integer cents"],
    widths: [180, 57],
  },
  {
    title: "several questions · help expanded",
    request: { questions: [environment, checks, library, summary] },
    keys: ["?"],
  },
  {
    title: "several questions · first answered, toggling choices",
    request: { questions: [environment, checks, library, summary] },
    keys: [ENTER, SPACE, DOWN, DOWN],
  },
  {
    title: "several questions · writing a note",
    request: { questions: [environment, checks, library, summary] },
    keys: ["n", "Prefer the canary first"],
  },
  {
    title: "several questions · a saved note",
    request: { questions: [environment, checks, library, summary] },
    keys: ["n", "Prefer the canary first, then widen the rollout after an hour", ENTER],
  },
  {
    title: "several questions · review with one unanswered",
    request: { questions: [environment, checks, library] },
    keys: ["1", "1", RIGHT, RIGHT],
  },
  {
    title: "several questions · review ready to submit",
    request: { questions: [environment, checks, library] },
    keys: ["1", "1", RIGHT, "2"],
  },
];

const pressKeys = (dialog: AskUserDialog, keys: ReadonlyArray<string>) => {
  for (const key of keys)
    if (key.length > 1 && !Str.startsWith("\x1b")(key)) typeText(dialog, key);
    else dialog.handleInput(key);
};

const dialogFrames = (): string[] =>
  Arr.flatMap(dialogScenarios, ({ title, request, keys, widths = [100, 57] }) => {
    const { dialog } = makeDialog(request);
    dialog.focused = true;
    pressKeys(dialog, keys);
    return Arr.flatMap(widths, (width) => [
      `── dialog · ${title} · ${width} cols`,
      ...Arr.map(dialog.render(width), (line) => Str.trimEnd(stripTerminalControls(line))),
      "",
    ]);
  });

const directory = galleryDirectory(process.env) ?? "";

const titled = <A extends { readonly title: string }>(entries: ReadonlyArray<A>, title: string) =>
  Option.getOrThrow(Arr.findFirst(entries, (entry) => entry.title === title));

describe.skipIf(!directory)("presentation gallery", () => {
  beforeAll(() => initTheme("dark", false));

  it.effect("renders questionnaire states in both collapsed styles", () =>
    Effect.gen(function* () {
      const scenarios = yield* Effect.all([
        live("ask_user", "opening the questionnaire", {
          questions: [environment, checks, library, summary],
        }),
        live(
          "ask_user",
          "questions shown, needs your input",
          { questions: [environment, checks, library, summary] },
          { content: [], details: { questionnaire: "open" } },
        ),
        asked("one choice selected", { questions: [environment] }, oneChoice),
        asked("several choices selected", { questions: [checks] }, severalChoices),
        asked("custom answer with a note", { questions: [library] }, customWithNote),
        asked(
          "every answer kind with notes",
          { questions: [environment, checks, library, summary] },
          everyKind,
        ),
        asked("a long written answer over two lines", { questions: [summary] }, longWritten),
        asked("several short answers", { questions: [store, features, notes] }, cartPlan).pipe(
          Effect.map((scenario) => ({ ...scenario, wide: true })),
        ),
        asked("questionnaire cancelled", { questions: [environment, library] }, cancelled),
        failed(
          "ask_user",
          "questionnaire could not open",
          { questions: [environment] },
          "Couldn't open the questionnaire.",
        ),
        Effect.succeed<ToolScenario>({
          tool: "ask_user",
          title: "answers whose details could not be read",
          args: { questions: [environment] },
          result: {
            content: text(
              "The user submitted these answers:\n- environment: staging (Staging (Recommended))",
            ),
            details: { outcome: "submitted" },
          },
        }),
        live("ask_user_async", "opening the questionnaire", asyncRequest),
        started("questionnaire open", open),
        started("questionnaire queued behind another", queued),
        controlled("questionnaire hidden by the user", { action: "status", requestId: "ask-1" }, [
          { ...open, presentation: "hidden" },
        ]),
        controlled("hidden and queued questionnaires", { action: "status" }, [
          { ...open, presentation: "hidden" },
          queued,
        ]),
        live("ask_user_async_control", "awaiting answers", { action: "await", requestId: "ask-1" }),
        live(
          "ask_user_async_control",
          "awaiting answers with a partial update",
          { action: "await", requestId: "ask-1" },
          { content: [], details: undefined },
        ),
        live(
          "ask_user_async_control",
          "awaiting answers on screen",
          { action: "await", requestId: "ask-1" },
          { content: [], details: { questionnaire: "open" } },
        ),
        live(
          "ask_user_async_control",
          "awaiting a hidden questionnaire",
          { action: "await", requestId: "ask-1" },
          { content: [], details: { questionnaire: "hidden" } },
        ),
        live(
          "ask_user_async_control",
          "awaiting a queued questionnaire",
          { action: "await", requestId: "ask-2" },
          { content: [], details: { questionnaire: "queued" } },
        ),
        controlled("answers awaited", { action: "await", requestId: "ask-1" }, [
          answered("waiter"),
        ]),
        controlled("questionnaire cancelled", { action: "cancel", requestId: "ask-2" }, [
          snapshot("ask-2", {
            ...settled,
            status: "cancelled",
            delivery: "waiter",
            outcome: cancelled,
          }),
        ]),
        controlled("questionnaire failed", { action: "await", requestId: "ask-3" }, [
          snapshot("ask-3", { ...settled, status: "failed", delivery: "waiter" }),
        ]),
        controlled("one questionnaire open and one queued", { action: "status" }, [open, queued]),
        controlled("only queued questionnaires", { action: "status" }, [
          queued,
          { ...queued, requestId: "ask-4", deliveryId: "ask-4-answer" },
        ]),
        controlled("finished and waiting questionnaires", { action: "status" }, [
          snapshot("ask-1", { ...settled, status: "submitted", delivery: "sent" }),
          snapshot("ask-2", { ...settled, status: "cancelled", delivery: "sent" }),
          snapshot("ask-3", { status: "pending", presentation: "open", delivery: "pending" }),
        ]),
        controlled("answers saved but not delivered", { action: "status", requestId: "ask-1" }, [
          answered("failed"),
        ]),
        controlled("no questionnaires", { action: "status" }, []),
        failed(
          "ask_user_async_control",
          "request no longer retained",
          { action: "await", requestId: "ask-9" },
          "That questionnaire is no longer available. Use status without a requestId to list retained requests; it may have expired or belonged to an earlier session or branch.",
        ),
      ]);
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const) {
        const restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
        try {
          const { tools, messageRenderers } = captureRegistrations(registerAll);
          for (const { tool, wide, ...scenario } of scenarios)
            lines.push(
              ...galleryFrames(
                Option.getOrThrow(Arr.findFirst(tools, (entry) => entry.name === tool)),
                {
                  ...scenario,
                  title: `${style} · ${tool} · ${scenario.title}`,
                },
                wide ? [...GALLERY_VIEWS, ...WIDE_COLLAPSED] : GALLERY_VIEWS,
              ),
            );
          expect(messageRenderers.get(ASYNC_MESSAGE_TYPE)).toBe(renderAskUserAsyncMessage);
          const render = renderAskUserAsyncMessage;
          for (const scenario of messages)
            lines.push(
              ...galleryMessageFrames(render, {
                ...scenario,
                title: `${style} · answer message · ${scenario.title}`,
              }),
            );
          const opened = titled(scenarios, "questionnaire open");
          for (const background of ["border", "on", "off"] as const)
            withPresentationSettings({ toolCallBackground: background }, () => {
              const tool = Option.getOrThrow(
                Arr.findFirst(
                  captureRegistrations(registerAll).tools,
                  (entry) => entry.name === "ask_user_async",
                ),
              );
              lines.push(
                ...galleryTranscriptFrames(
                  `${style} · ${background} · transcript: an async questionnaire beside its answers`,
                  [
                    { name: tool.name, tool, args: opened.args, result: opened.result! },
                    { render, message: titled(messages, "answers submitted").message },
                    { render, message: titled(messages, "questionnaire cancelled").message },
                  ],
                ),
              );
            });
        } finally {
          restore();
        }
      }
      lines.push(...dialogFrames());
      yield* writeGallerySection(directory, "pi-ask-user", lines);
    }),
  );
});
