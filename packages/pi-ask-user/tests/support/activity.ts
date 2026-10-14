import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ActivitySnapshotSchema } from "pi-cosmic-ui/activity";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
import { createQuestionnaireActivity } from "../../src/boundary/host-activity.ts";
import { createAskUserDialogBridge } from "../../src/boundary/host-ui.ts";

export const makeActivityFixture = () => {
  const bridge = createAskUserDialogBridge();
  const host = fakeActivityHost("session");
  let current = true;
  const activity = createQuestionnaireActivity({
    bridge,
    isCurrent: () => current,
    run: (effect, signal) => Effect.runPromise(effect, { signal }),
  });
  activity.activate(host.events, "session");
  return {
    bridge,
    activity,
    items: () => Schema.decodeUnknownSync(ActivitySnapshotSchema)(host.get()?.items ?? []),
    invoke: (id: string, action: string, revision: string) =>
      Effect.tryPromise((signal) => host.capability()!.invoke!(id, action, revision, signal)),
    replace: () => {
      current = false;
    },
  };
};
