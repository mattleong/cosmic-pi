import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeSetStatusSafely } from "pi-cosmic-ui/boundary/host-status";

const STATUS_KEY = "pi-ask-user";

export interface DialogActivity {
  readonly id: string;
  readonly token: number;
  readonly phase: "open" | "hidden" | "closing";
}

export interface AskUserDialogBridge {
  readonly setActivity: (listener: ((event: DialogActivity) => void) | undefined) => void;
  readonly setRequest: (id: string) => void;
  readonly setManaged: (managed: boolean) => void;
  readonly markOpened: (token: number) => void;
  readonly setContext: (ctx: ExtensionContext | undefined) => void;
  readonly activate: (resume: () => void) => number;
  readonly markCollapsed: (token: number) => void;
  readonly resume: (token?: number) => boolean;
  readonly clear: (token?: number) => void;
}

const setStatus = makeSetStatusSafely(STATUS_KEY);

export function makeAskUserDialogBridge(): AskUserDialogBridge {
  let context: ExtensionContext | undefined;
  let nextToken = 1;
  let requestId: string | undefined;
  let listener: ((event: DialogActivity) => void) | undefined;
  let managed = false;
  let hidden = false;
  let active:
    | { readonly token: number; readonly id: string | undefined; readonly resume: () => void }
    | undefined;
  const publish = (phase: DialogActivity["phase"]) => {
    if (active?.id) listener?.({ id: active.id, token: active.token, phase });
  };
  const status = () =>
    setStatus(context, !managed && hidden ? "questions hidden · /ask-user to resume" : undefined);
  return {
    setActivity: (next) => {
      listener = next;
    },
    setRequest: (id) => {
      requestId = id;
    },
    setManaged: (next) => {
      managed = next;
      status();
    },
    markOpened: (token) => {
      if (active?.token === token) publish("open");
    },
    setContext: (next) => {
      if (context && context !== next) setStatus(context, undefined);
      context = next;
      if (!active) setStatus(context, undefined);
    },
    activate: (resume) => {
      const token = nextToken++;
      active = { token, id: requestId, resume };
      hidden = false;
      setStatus(context, undefined);
      return token;
    },
    markCollapsed: (token) => {
      if (active?.token !== token) return;
      hidden = true;
      publish("hidden");
      status();
    },
    resume: (token) => {
      if (!active || (token !== undefined && active.token !== token)) return false;
      try {
        active.resume();
        hidden = false;
        publish("open");
        setStatus(context, undefined);
        return true;
      } catch {
        return false;
      }
    },
    clear: (token) => {
      if (token !== undefined && active?.token !== token) return;
      publish("closing");
      active = undefined;
      requestId = undefined;
      hidden = false;
      setStatus(context, undefined);
    },
  };
}
