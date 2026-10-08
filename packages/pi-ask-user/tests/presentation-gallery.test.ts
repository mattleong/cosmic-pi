import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyPresentationSettings,
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  galleryMessageFrames,
  writeGallerySection,
  type GalleryMessageScenario,
  type GalleryScenario,
} from "pi-code-previews/testing";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
} from "../src/tools/ask-user-async.ts";
import { noExecution } from "./support/questionnaire.ts";

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
}

/** Runs the registered tool's own execute over a stubbed questionnaire service. */
const executed = (
  tool: ToolName,
  title: string,
  args: ToolArgs,
  register: (pi: ExtensionAPI) => void,
) =>
  Effect.promise(() =>
    captureRegistrations(register)
      .tools.find((entry) => entry.name === tool)!
      .execute("gallery", args, undefined, undefined, opaqueFixture({})),
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
/** Pi's own result when execute rejects: the error message and empty details. */
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
      details: { generation, deliveryId: delivered.deliveryId, requestId, outcome },
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

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders questionnaire states in both collapsed styles", () =>
    Effect.gen(function* () {
      const scenarios = yield* Effect.all([
        live("ask_user", "waiting for answers", {
          questions: [environment, checks, library, summary],
        }),
        asked("one choice selected", { questions: [environment] }, oneChoice),
        asked("several choices selected", { questions: [checks] }, severalChoices),
        asked("custom answer with a note", { questions: [library] }, customWithNote),
        asked(
          "every answer kind with notes",
          { questions: [environment, checks, library, summary] },
          everyKind,
        ),
        asked("questionnaire cancelled", { questions: [environment, library] }, cancelled),
        failed(
          "ask_user",
          "questionnaire could not open",
          { questions: [environment] },
          "Couldn't open the questionnaire.",
        ),
        live("ask_user_async", "opening the questionnaire", asyncRequest),
        started("questionnaire open", open),
        started("questionnaire queued behind another", queued),
        controlled("questionnaire hidden by the user", { action: "status", requestId: "ask-1" }, [
          { ...open, presentation: "hidden" },
        ]),
        live("ask_user_async_control", "awaiting answers", { action: "await", requestId: "ask-1" }),
        live(
          "ask_user_async_control",
          "awaiting answers with a partial update",
          { action: "await", requestId: "ask-1" },
          { content: [], details: undefined },
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
        controlled("questionnaires waiting for answers", { action: "status" }, [open, queued]),
        // Status without a requestId lists metadata only; the service strips each outcome.
        controlled("finished and waiting questionnaires", { action: "status" }, [
          snapshot("ask-1", { ...settled, status: "submitted", delivery: "sent" }),
          snapshot("ask-2", { ...settled, status: "cancelled", delivery: "sent" }),
          snapshot("ask-3", { status: "pending", presentation: "open", delivery: "pending" }),
        ]),
        controlled("answers saved but not delivered", { action: "status", requestId: "ask-1" }, [
          answered("failed"),
        ]),
        controlled("no questionnaires retained", { action: "status" }, []),
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
          // Registration captures the collapsed style, so it follows the settings above.
          const { tools, messageRenderers } = captureRegistrations(registerAll);
          for (const { tool, ...scenario } of scenarios)
            lines.push(
              ...galleryFrames(tools.find((entry) => entry.name === tool)!, {
                ...scenario,
                title: `${style} · ${tool} · ${scenario.title}`,
              }),
            );
          const render = messageRenderers.get(ASYNC_MESSAGE_TYPE)!;
          for (const scenario of messages)
            lines.push(
              ...galleryMessageFrames(render, {
                ...scenario,
                title: `${style} · answer message · ${scenario.title}`,
              }),
            );
        } finally {
          restore();
        }
      }
      yield* writeGallerySection(directory, "pi-ask-user", lines);
    }),
  );
});
