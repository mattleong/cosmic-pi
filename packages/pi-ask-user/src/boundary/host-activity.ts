import * as Effect from "effect/Effect";
import { stripTerminalControls } from "pi-cosmic-core";
import {
  registerActivityProvider,
  type ActivityEvents,
  type ActivityItem,
  type ActivityProviderRegistration,
} from "pi-cosmic-ui/activity";
import type { QuestionnaireActivity } from "../questionnaire/service.ts";
import type { AskUserRequest, QuestionnaireOwner } from "../questionnaire/protocol.ts";
import type { OwnedFormRequest, ExtensionFormOwner } from "../questionnaire/form-protocol.ts";
import type { AskUserDialogBridge } from "./host-ui.ts";

interface Row {
  readonly item: ActivityItem;
  readonly cancel?: Effect.Effect<void>;
  readonly token?: number | undefined;
}

/** A synchronous projection of service and mounted-dialog transitions, never draft storage. */
export function makeQuestionnaireActivity(options: {
  readonly bridge: AskUserDialogBridge;
  readonly register?: typeof registerActivityProvider;
  readonly isCurrent: () => boolean;
  readonly run: (effect: Effect.Effect<void>, signal: AbortSignal) => Promise<void>;
}) {
  const cancelAction = {
    id: "cancel",
    label: "Cancel",
    confirmation: "Cancel this questionnaire? Draft answers will be discarded.",
  };
  const rows = new Map<string, Row>();
  let registration: ActivityProviderRegistration | undefined;
  let revision = 0;
  let live = true;
  const current = () => live && options.isCurrent();
  const publish = () => {
    if (current()) registration?.publish();
  };
  const set = (id: string, row: Row) => {
    rows.set(id, { ...row, item: Object.freeze({ ...row.item, revision: String(++revision) }) });
    publish();
  };
  const transition = (operation: () => void) =>
    Effect.try(() => {
      if (current()) operation();
    }).pipe(Effect.ignore);
  const admitted = (
    id: string,
    request: AskUserRequest | OwnedFormRequest,
    cancel: Effect.Effect<void>,
    owner?: QuestionnaireOwner | ExtensionFormOwner,
  ) =>
    transition(() => {
      const item: ActivityItem = {
        id,
        kind: "question",
        title: stripTerminalControls(
          "questions" in request
            ? request.questions.map((question) => question.title).join(" / ")
            : owner && "extensionId" in owner
              ? owner.label
              : "Extension form",
        ),
        status: "pending",
        revision: "",
        summary: "queued",
        detail:
          "questions" in request
            ? request.questions.map((question) => question.prompt).join("\n\n")
            : "Private extension request. Answers return only to the requesting extension.",
        actions: [cancelAction],
      };
      set(id, {
        cancel,
        item: owner
          ? {
              ...item,
              parent:
                "extensionId" in owner
                  ? { providerId: owner.extensionId, itemId: owner.operationId }
                  : { providerId: "pi-subagents", itemId: owner.runId },
            }
          : item,
      });
    });
  const observer: QuestionnaireActivity = {
    admitted,
    presenting: (id) =>
      transition(() => {
        options.bridge.setRequest(id);
        const row = rows.get(id);
        if (row) set(id, { ...row, item: { ...row.item, summary: "opening" } });
      }),
    settled: (id, outcome) =>
      transition(() => {
        const row = rows.get(id);
        if (!row) return;
        set(id, {
          item: {
            ...row.item,
            status: outcome === "submitted" ? "done" : outcome,
            inputTarget: undefined,
            blockedReason: undefined,
            summary: outcome,
            actions: [],
          },
        });
        const settled = [...rows.values()].filter((entry) => !entry.cancel);
        for (const old of settled.slice(0, Math.max(0, settled.length - 16)))
          rows.delete(old.item.id);
        publish();
      }),
    removed: (id) =>
      transition(() => {
        rows.delete(id);
        publish();
      }),
  };
  return {
    observer,
    activate: (events: ActivityEvents, sessionId: string) => {
      options.bridge.setActivity((event) => {
        if (!current()) return;
        const row = rows.get(event.id);
        if (!row?.cancel) return;
        set(event.id, {
          ...row,
          token: event.phase === "closing" ? undefined : event.token,
          item: {
            ...row.item,
            status: "needs-input",
            inputTarget: "user",
            blockedReason: undefined,
            summary: event.phase,
            actions:
              event.phase === "hidden"
                ? [{ id: "resume", label: "Resume" }, cancelAction]
                : [cancelAction],
          },
        });
      });
      registration = (options.register ?? registerActivityProvider)(events, {
        sessionId,
        providerId: "pi-ask-user",
        snapshot: () => (current() ? [...rows.values()].map((row) => row.item) : []),
        onAvailability: (available) => options.bridge.setManaged(available),
        invoke: (id, action, expected, signal) =>
          Promise.resolve().then(() => {
            const row = rows.get(id);
            if (
              signal.aborted ||
              !current() ||
              !row ||
              row.item.revision !== expected ||
              !row.item.actions?.some((item) => item.id === action)
            )
              throw new Error("Questionnaire action is no longer available.");
            if (action === "resume" && row.token !== undefined) {
              if (!options.bridge.resume(row.token))
                throw new Error("Questionnaire is no longer mounted.");
              return;
            }
            if (action === "cancel" && row.cancel) return options.run(row.cancel, signal);
            throw new Error("Questionnaire action is unavailable.");
          }),
      });
      registration.publish();
    },
    dispose: () => {
      if (!live) return;
      live = false;
      options.bridge.setActivity(undefined);
      registration?.dispose();
      options.bridge.setManaged(false);
      rows.clear();
    },
  };
}

export type QuestionnaireActivityBridge = ReturnType<typeof makeQuestionnaireActivity>;
