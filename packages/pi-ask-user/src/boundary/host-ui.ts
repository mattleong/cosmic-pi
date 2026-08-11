import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeSetStatusSafely } from "pi-cosmic-ui/boundary/host-status";

const STATUS_KEY = "pi-ask-user";

export interface ActiveQuestionnaireController {
  readonly resume: () => void;
}

export interface AskUserDialogBridge {
  readonly setContext: (ctx: ExtensionContext | undefined) => void;
  readonly activate: (controller: ActiveQuestionnaireController) => number;
  readonly markCollapsed: (token: number) => void;
  readonly resume: () => boolean;
  readonly clear: (token?: number) => void;
}

const setStatus = makeSetStatusSafely(STATUS_KEY);

export function makeAskUserDialogBridge(): AskUserDialogBridge {
  let context: ExtensionContext | undefined;
  let nextToken = 1;
  let active:
    | { readonly token: number; readonly controller: ActiveQuestionnaireController }
    | undefined;
  return {
    setContext: (next) => {
      if (context && context !== next) setStatus(context, undefined);
      context = next;
      if (!active) setStatus(context, undefined);
    },
    activate: (controller) => {
      const token = nextToken++;
      active = { token, controller };
      setStatus(context, undefined);
      return token;
    },
    markCollapsed: (token) => {
      if (active?.token !== token) return;
      setStatus(context, "questions hidden · /ask-user to resume");
    },
    resume: () => {
      if (!active) return false;
      try {
        active.controller.resume();
        setStatus(context, undefined);
        return true;
      } catch {
        return false;
      }
    },
    clear: (token) => {
      if (token !== undefined && active?.token !== token) return;
      active = undefined;
      setStatus(context, undefined);
    },
  };
}
