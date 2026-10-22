import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { provideBuiltLayer } from "pi-cosmic-core/testing";
import {
  clearCodePreviewSessionCapability,
  captureCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
} from "../../../../src/application/capability";
import { CodePreviewSchedulerService } from "../../../../src/application/scheduler";
import { cachedDeferredPreview } from "../../../../src/tools/renderers/shared/cache";
import { plainTheme } from "../../../support/render";
import { renderContextFixture } from "../../../../testing";
import { defaultCodePreviewSettings } from "../../../../src/config/defaults";
import { setCodePreviewSettings } from "../../../../src/config/state";
import { createSimpleDiff } from "../../../../src/diff/structured";
import { acquireProjectionOwnership } from "../../../../src/shared/projection-ownership";
import { clearSyntaxProjection, installSyntaxRequests } from "../../../../src/syntax/projection";
import { editPreviewRenderers } from "../../../../src/tools/renderers/edit";
import { writePreviewRenderers } from "../../../../src/tools/renderers/write";

for (const transition of ["shutdown", "replacement"] as const)
  it.effect(
    `retained previews remain readable when ${transition} cancels their pending render`,
    () =>
      Effect.gen(function* () {
        const preview = yield* CodePreviewSchedulerService.use((scheduler) =>
          Effect.sync(() => {
            installCodePreviewSessionCapability({
              ...scheduler,
              run: () => Promise.reject(new Error("not used")),
            });
            return cachedDeferredPreview(
              {},
              "preview",
              ["source"],
              20_000,
              "loading",
              plainTheme,
              () => new Text("retained source"),
              () => assert.fail("a retired preview cannot invalidate its host"),
              captureCodePreviewSessionCapability(),
            );
          }),
        ).pipe(provideBuiltLayer(CodePreviewSchedulerService.layer));
        clearCodePreviewSessionCapability();
        if (transition === "replacement")
          installCodePreviewSessionCapability({
            run: () => Promise.reject(new Error("not used")),
            defer: () => assert.fail("a retained row cannot borrow its replacement's scheduler"),
            schedule: () => assert.fail("a retained row cannot animate through its replacement"),
          });
        for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow;
        assert.match(preview.render(80).join("\n"), /retained source/u);
      }).pipe(Effect.ensuring(Effect.sync(() => clearCodePreviewSessionCapability()))),
  );

for (const { kind, draw, owned } of [
  { kind: "write-result", draw: true, owned: true },
  { kind: "edit-call", draw: true, owned: true },
  { kind: "edit-call", draw: false, owned: false },
  { kind: "write-call", draw: false, owned: false },
] as const)
  it.effect(
    `${owned ? "retired" : "unowned"} ${kind} (${draw ? "pending" : "undrawn"}) preserves its source without using replacement syntax`,
    () => {
      const syntaxOwner = acquireProjectionOwnership("replacement");
      return Effect.gen(function* () {
        setCodePreviewSettings({
          ...defaultCodePreviewSettings,
          writeCollapsedLines: 100,
          editCollapsedLines: "all",
        });
        const oldText = `${"const oldValue = 1;\n".repeat(500)}OLD_END\n`;
        const newText = `${"const newValue = 2;\n".repeat(500)}NEW_END\n`;
        const context = renderContextFixture({
          args: { path: "/project/source.ts", content: newText, edits: [{ oldText, newText }] },
          isPartial: false,
          invalidate: () => assert.fail("retired diff invalidated its original host"),
        });
        const preview = yield* CodePreviewSchedulerService.use((scheduler) =>
          Effect.sync(() => {
            if (owned)
              installCodePreviewSessionCapability({
                ...scheduler,
                run: () => Promise.reject(new Error("not used")),
              });
            else clearCodePreviewSessionCapability();
            const renderers =
              kind === "write-result" || kind === "write-call"
                ? writePreviewRenderers("/project")
                : editPreviewRenderers("/project");
            const result = {
              content: [],
              details: {
                diff: createSimpleDiff(oldText, newText),
                codePreviewBeforeWrite: { kind: "content", content: oldText },
              },
            };
            const component =
              kind === "edit-call" || kind === "write-call"
                ? renderers.renderCall?.(context.args, plainTheme, context)
                : renderers.renderResult?.(
                    result,
                    { expanded: false, isPartial: false },
                    plainTheme,
                    context,
                  );
            assert.ok(component);
            if (draw) component.render(100);
            return component;
          }),
        ).pipe(provideBuiltLayer(CodePreviewSchedulerService.layer));
        installCodePreviewSessionCapability({
          run: () => Promise.reject(new Error("not used")),
          defer: () => assert.fail("retained diff borrowed replacement scheduler"),
          schedule: () => assert.fail("retained diff borrowed replacement animation"),
        });
        let syntaxRequests = 0;
        const request = () => {
          syntaxRequests++;
        };
        installSyntaxRequests(syntaxOwner, { initialize: request, language: request });
        setCodePreviewSettings({
          ...defaultCodePreviewSettings,
          writeCollapsedLines: 1,
          editCollapsedLines: 1,
        });
        const rendered = preview.render(100).join("\n");
        assert.match(rendered, kind === "write-call" ? /newValue/u : /oldValue/u);
        if (kind !== "write-result") assert.match(rendered, /NEW_END/u);
        assert.equal(syntaxRequests, 0);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            clearCodePreviewSessionCapability();
            clearSyntaxProjection(syntaxOwner);
            setCodePreviewSettings(defaultCodePreviewSettings);
          }),
        ),
      );
    },
  );
