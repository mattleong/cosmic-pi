import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, expect, it, vi } from "vitest";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { OwnedFormDialog } from "../src/ui/form-dialog.ts";
import type { FormOutcome, OwnedFormRequest } from "../src/protocol.ts";
import { opaqueHostFixture, theme } from "./support/host.ts";

beforeAll(() => initTheme("dark", false));
const enter = "\r",
  down = "\x1b[B",
  escape = "\x1b";
const make = (request: OwnedFormRequest) => {
  const done = vi.fn<(outcome: FormOutcome) => void>();
  const dialog = new OwnedFormDialog({
    request,
    owner: { extensionId: "pi-mcp", operationId: "o", requestId: "r", label: "MCP" },
    tui: opaqueHostFixture({ requestRender: vi.fn() }),
    theme,
    keybindings: opaqueHostFixture({ matches: (data: string) => matchesKey(data, "escape") }),
    done,
    onCollapse: vi.fn(),
  });
  return { dialog, done };
};
const acceptReview = (dialog: OwnedFormDialog, fields: number) => {
  for (let i = 0; i < fields; i++) dialog.handleInput(down);
  dialog.handleInput(enter);
};

it("requires final review and preserves typed zero, false and empty string", () => {
  const { dialog, done } = make({
    kind: "form",
    message: "",
    fields: [
      { key: "no", type: "boolean", required: true },
      { key: "zero", type: "integer", required: true },
      { key: "empty", type: "string", required: true },
    ],
  });
  dialog.handleInput(down);
  dialog.handleInput(enter);
  dialog.handleInput(enter);
  dialog.handleInput("0");
  dialog.handleInput(enter);
  dialog.handleInput(enter);
  dialog.handleInput(enter);
  expect(done).not.toHaveBeenCalled();
  acceptReview(dialog, 3);
  expect(done).toHaveBeenCalledWith({
    action: "accept",
    content: { no: false, zero: 0, empty: "" },
  });
});

it("supports 64 choices and toggles multi-enum values independently of display titles", () => {
  const { dialog, done } = make({
    kind: "form",
    message: "",
    fields: [
      {
        key: "options",
        type: "multi-enum",
        required: true,
        options: Array.from({ length: 64 }, (_, index) => ({
          value: `v${index}`,
          title: `Title ${index}`,
        })),
        default: ["v0"],
      },
    ],
  });
  for (let i = 0; i < 63; i++) dialog.handleInput(down);
  dialog.handleInput(enter);
  dialog.handleInput("\t");
  acceptReview(dialog, 1);
  expect(done).toHaveBeenCalledWith({ action: "accept", content: { options: ["v0", "v63"] } });
});

it("omits optional defaults only on explicit omission and allows review editing", () => {
  const { dialog, done } = make({
    kind: "form",
    message: "",
    fields: [{ key: "optional", type: "string", default: "default" }],
  });
  dialog.handleInput("\t");
  dialog.handleInput(enter); // Review edit field.
  dialog.handleInput(down);
  dialog.handleInput(enter); // Explicit omission.
  acceptReview(dialog, 1);
  expect(done).toHaveBeenCalledWith({ action: "accept", content: {} });
});

it("rejects invalid typed values before review and distinguishes decline from cancel", () => {
  const { dialog, done } = make({
    kind: "form",
    message: "",
    fields: [{ key: "n", type: "integer", required: true, minimum: 2 }],
  });
  dialog.handleInput(enter);
  dialog.handleInput("0");
  dialog.handleInput(enter);
  expect(done).not.toHaveBeenCalled();
  dialog.handleInput(escape);
  dialog.handleInput(escape);
  expect(done).toHaveBeenCalledWith({ action: "cancel" });
  const declined = make({ kind: "form", message: "", fields: [] });
  declined.dialog.handleInput(down);
  declined.dialog.handleInput(enter);
  expect(declined.done).toHaveBeenCalledWith({ action: "decline" });
});

it("shows the actual URL target before a long caller message when acceptance is selected", () => {
  const url = "https://EXAMPLE.test:8443/approval?scope=read";
  const { dialog, done } = make({
    kind: "url",
    message: Array.from({ length: 12 }, () => "Caller prose about a different target").join("\n"),
    url,
  });
  const visible = dialog.render(70).join("\n");
  expect(visible).toContain(new URL(url).host);
  expect(visible).toContain(url);
  expect(visible).toContain("pi-mcp");
  expect(visible.indexOf(url)).toBeLessThan(visible.indexOf("Caller prose"));
  expect(done).not.toHaveBeenCalled();
  dialog.handleInput(enter);
  expect(done).toHaveBeenCalledWith({ action: "accept" });
});

it("keeps the full normalized host visible while paging long URLs and caller prose at narrow widths", () => {
  const host = `${"long-subdomain.".repeat(8)}example.test:8443`;
  const { dialog, done } = make({
    kind: "url",
    url: `https://${host.toUpperCase()}/${"a".repeat(1000)}#`,
    message: `${"Caller prose\n".repeat(12)}MESSAGE-END`,
  });
  const views: string[] = [];
  for (let page = 0; page < 20; page++) {
    const lines = dialog.render(24);
    const visible = lines.join("");
    expect(visible).toContain(host);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    views.push(visible);
    dialog.handleInput("\x1b[6~");
  }
  expect(views[0]).toContain("https://");
  expect(views.some((view) => view.includes("#"))).toBe(true);
  expect(views.some((view) => view.includes("MESSAGE-END"))).toBe(true);
  expect(done).not.toHaveBeenCalled();
  dialog.handleInput(enter);
  expect(done).toHaveBeenCalledWith({ action: "accept" });
});

it("keeps URL consent inert, sanitizes presentation and exposes the complete URL by paging", () => {
  const url = `https://example.test/${"a".repeat(3000)}END`;
  const { dialog, done } = make({
    kind: "url",
    message: "\x1b]8;;https://evil.test\x07Text\x1b]8;;\x07",
    url,
  });
  const lines = dialog.render(50);
  expect(lines.join("\n")).not.toContain("\x1b]8");
  expect(lines.every((line) => visibleWidth(line) <= 50)).toBe(true);
  for (let i = 0; i < 100; i++) dialog.handleInput("\x1b[6~");
  expect(dialog.render(50).join("\n")).toContain("END");
  dialog.handleInput(enter);
  expect(done).toHaveBeenCalledWith({ action: "accept" });
});
