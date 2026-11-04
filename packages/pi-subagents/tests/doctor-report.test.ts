import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { deferredPromise, extensionContextFixture } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { vi } from "vitest";
import type { DoctorCheck } from "../src/application/doctor.ts";
import { showDoctorReport } from "../src/settings/doctor-report.ts";

const healthy: ReadonlyArray<DoctorCheck> = [{ label: "Pi", status: "ok", detail: "1.5.0" }];
const degraded: ReadonlyArray<DoctorCheck> = [
  ...healthy,
  { label: "Git", status: "warning", detail: "too old for isolated writers" },
];

describe("/subagents doctor report", () => {
  it.effect("falls back to a notice whose level reflects the checks outside a terminal", () =>
    Effect.gen(function* () {
      for (const [checks, level] of [
        [healthy, "info"],
        [degraded, "warning"],
      ] as const) {
        const notify = vi.fn<ExtensionUIContext["notify"]>();
        const ctx = extensionContextFixture({ mode: "rpc", ui: { notify } });
        yield* Effect.promise(() => showDoctorReport(ctx, checks, () => true));
        expect(notify).toHaveBeenCalledWith(expect.stringContaining("Pi"), level);
      }
    }),
  );

  it.effect("opens a closable panel instead of a notice in a terminal", () =>
    Effect.gen(function* () {
      const surface = fakeCustomSurfaceHost({ columns: 57, rows: 20 });
      const notify = vi.fn<ExtensionUIContext["notify"]>();
      const mounted = deferredPromise();
      const ctx = extensionContextFixture({
        mode: "tui",
        hasUI: true,
        ui: {
          notify,
          custom: (factory, options) => {
            const opened = surface.custom(factory, options);
            queueMicrotask(() => {
              surface.mount();
              mounted.resolve();
            });
            return opened;
          },
        },
      });
      const shown = showDoctorReport(ctx, degraded, () => true);
      yield* Effect.promise(() => mounted.promise);
      const panel = surface.overlays.at(-1);
      expect(Arr.join(panel?.render(57) ?? [], "\n")).toContain("Git");
      panel?.handleInput?.("\u001b");
      yield* Effect.promise(() => shown);
      expect(surface.overlays).toHaveLength(0);
      expect(notify).not.toHaveBeenCalled();
    }),
  );
});
