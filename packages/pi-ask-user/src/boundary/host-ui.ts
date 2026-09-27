import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeSetStatusSafely } from "pi-cosmic-ui/boundary/host-status";

const STATUS_KEY = "pi-ask-user";

export interface DialogActivity {
  readonly id: string;
  readonly token: number;
  readonly phase: "open" | "hidden" | "closing";
}

const setStatus = makeSetStatusSafely(STATUS_KEY);

export function makeAskUserDialogBridge() {
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
    setStatus(
      context,
      !managed && hidden ? "Questionnaire hidden · /ask-user to show it" : undefined,
    );
  return {
    setActivity: (next: ((event: DialogActivity) => void) | undefined) => {
      listener = next;
    },
    setRequest: (id: string) => {
      requestId = id;
    },
    setManaged: (next: boolean) => {
      managed = next;
      status();
    },
    markOpened: (token: number) => {
      if (active?.token === token) publish("open");
    },
    setContext: (next: ExtensionContext | undefined) => {
      if (context && context !== next) setStatus(context, undefined);
      context = next;
      if (!active) setStatus(context, undefined);
    },
    activate: (resume: () => void) => {
      const token = nextToken++;
      active = { token, id: requestId, resume };
      hidden = false;
      setStatus(context, undefined);
      return token;
    },
    markCollapsed: (token: number) => {
      if (active?.token !== token) return;
      hidden = true;
      publish("hidden");
      status();
    },
    resume: (token?: number) => {
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
    clear: (token?: number) => {
      if (token !== undefined && active?.token !== token) return;
      publish("closing");
      active = undefined;
      requestId = undefined;
      hidden = false;
      setStatus(context, undefined);
    },
  };
}

export type AskUserDialogBridge = ReturnType<typeof makeAskUserDialogBridge>;
