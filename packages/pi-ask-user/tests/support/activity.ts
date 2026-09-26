import * as Effect from "effect/Effect";
import type { ActivityProviderOptions } from "pi-cosmic-ui/activity";
import { makeQuestionnaireActivity } from "../../src/boundary/host-activity.ts";
import { makeAskUserDialogBridge } from "../../src/boundary/host-ui.ts";

/** Activates questionnaire Activity for one session and captures its registered provider. */
export const makeActivityFixture = () => {
  const bridge = makeAskUserDialogBridge();
  let current = true;
  let provider!: ActivityProviderOptions;
  const activity = makeQuestionnaireActivity({
    bridge,
    isCurrent: () => current,
    run: (effect, signal) => Effect.runPromise(effect, { signal }),
    register: (_events, options) => {
      provider = options;
      return { publish: () => {}, dispose: () => {}, isAvailable: () => true };
    },
  });
  activity.activate({ emit: () => {}, on: () => () => {} }, "session");
  const invoke = (id: string, action: string, revision: string) =>
    Effect.tryPromise((signal) => provider.invoke(id, action, revision, signal));
  return {
    bridge,
    activity,
    provider,
    invoke,
    replace: () => {
      current = false;
    },
  };
};
