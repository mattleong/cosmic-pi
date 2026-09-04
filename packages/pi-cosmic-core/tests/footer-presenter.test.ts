import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createFooterPresenter } from "../src/footer-presenter.ts";

describe("footer presenter", () => {
  it("honors a per-update status override without installing a custom footer", () => {
    const setFooter = vi.fn();
    const setStatus = vi.fn();
    // SAFETY: The proxy supplies every context property exercised by this presenter test.
    const ctx = new Proxy({} as ExtensionContext, {
      get: (_target, property) => {
        if (property === "mode") return "tui";
        if (property === "ui") return { setFooter, setStatus };
        return undefined;
      },
    });
    const presenter = createFooterPresenter({
      statusKey: "provider",
      footerMode: () => "replace",
      hasTerminalUI: () => true,
      statusText: () => "ready",
      renderLines: () => ["custom"],
    });

    presenter.update(ctx, "status");

    expect(setFooter).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith("provider", "ready");

    presenter.update(ctx, "off");
    expect(setStatus).toHaveBeenLastCalledWith("provider", undefined);
  });
});
