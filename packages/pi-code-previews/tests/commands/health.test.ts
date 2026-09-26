import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extensionApiFixture } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { registerHealthCommand } from "../../src/commands/health";
import { effectTest, step } from "../support/effect-test";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

effectTest("closing health keeps its panel geometry and an overlay stacked above it", function* () {
  let command: Command | undefined;
  registerHealthCommand(
    extensionApiFixture({
      registerCommand: (_name: string, registered: Command) => {
        command = registered;
      },
    }),
  );
  const host = fakeCustomSurfaceHost();
  const running = command?.handler("", host.ctx) ?? Promise.resolve();
  host.mount();
  // A plain component-sized overlay: no viewport options.
  assert.equal(host.overlayOptions, undefined);
  const [panel] = host.overlays;
  const questionnaire = { render: () => ["questionnaire"], invalidate() {} };
  const hidden = host.showUnrelated(questionnaire);
  hidden.setHidden(true);
  panel?.handleInput?.("x");
  yield* step(() => running);
  hidden.setHidden(false);
  assert.deepEqual(host.overlays, [questionnaire]);
  assert.equal(host.doneCalls, 1);
});
