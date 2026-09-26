import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, expect, it, vi } from "vitest";
import { CURSOR_MARKER, matchesKey } from "@earendil-works/pi-tui";
import { OwnedFormDialog } from "../src/ui/form-dialog.ts";
import type { FormOutcome, OwnedFormRequest } from "../src/protocol.ts";
import { opaqueFixture, plainTheme as theme } from "pi-cosmic-core/testing";
import { formOwner } from "./support/questionnaire.ts";
import { expectWithin, pageViews } from "./support/viewport.ts";

beforeAll(() => initTheme("dark", false));
const enter = "\r",
  down = "\x1b[B",
  escape = "\x1b";
const make = (request: OwnedFormRequest, getHeight: () => number = () => 24) => {
  const done = vi.fn<(outcome: FormOutcome) => void>();
  const dialog = new OwnedFormDialog({
    request,
    getHeight,
    owner: formOwner,
    tui: opaqueFixture({ requestRender: vi.fn(), terminal: { rows: 60, columns: 120 } }),
    theme,
    keybindings: opaqueFixture({ matches: (data: string) => matchesKey(data, "escape") }),
    done,
    collapse: vi.fn(),
  });
  return { dialog, done };
};
const acceptReview = (dialog: OwnedFormDialog, fields: number) => {
  for (let i = 0; i < fields; i++) dialog.handleInput(down);
  dialog.handleInput(enter);
};

it("preserves long private text, editor focus and final review through resize", () => {
  let height = 7;
  const { dialog, done } = make(
    {
      kind: "form",
      message: "prose ".repeat(500),
      fields: [{ key: "text", type: "string", required: true }],
    },
    () => height,
  );
  dialog.focused = true;
  dialog.handleInput(enter);
  const text = "private text ".repeat(100) + "TAIL";
  dialog.handleInput(`\x1b[200~${text}\x1b[201~`);
  for (const width of [80, 24, 8, 1]) {
    height = width <= 8 ? 1 : 7;
    const lines = dialog.render(width);
    expectWithin(lines, width, height);
    expect(lines.join("\n")).toContain(CURSOR_MARKER);
  }
  dialog.focused = false;
  expect(dialog.render(24).join("\n")).not.toContain(CURSOR_MARKER);
  dialog.focused = true;
  dialog.handleInput(enter);
  expect(done).not.toHaveBeenCalled();
  expect(dialog.render(24).join("\n")).not.toContain(CURSOR_MARKER);
  height = 30;
  dialog.handleInput(down);
  expect(dialog.render(80).length).toBeLessThanOrEqual(height);
  dialog.handleInput(enter);
  expect(done).toHaveBeenCalledWith({ action: "accept", content: { text } });
});

it("allows complete URL review in a tiny viewport before an inert consent result", () => {
  let height = 5;
  const { dialog, done } = make(
    {
      kind: "url",
      url: "https://example.test/" + "path/".repeat(80) + "URL-END",
      message: "prose\n".repeat(30) + "MESSAGE-END",
    },
    () => height,
  );
  const views = pageViews(dialog, 24, 120, { height, join: "" });
  expect(views.some((view) => view.includes("example.test"))).toBe(true);
  expect(views.some((view) => view.includes("URL-END"))).toBe(true);
  expect(views.some((view) => view.includes("MESSAGE-END"))).toBe(true);
  expect(done).not.toHaveBeenCalled();
  height = 30;
  dialog.handleInput("\x1b[H");
  dialog.render(100);
  dialog.handleInput(enter);
  expect(done).toHaveBeenCalledWith({ action: "accept" });
});

it.each([
  [0, 10],
  [10, 0],
  [1, 1],
  [2, 2],
])("bounds a tiny form at %i by %i without granting consent", (width, height) => {
  const { dialog, done } = make(
    { kind: "url", url: "https://example.test/", message: "request" },
    () => height,
  );
  expectWithin(dialog.render(width), width, height);
  expect(done).not.toHaveBeenCalled();
});

it("keeps validation feedback visible beside a long editor and leaves short forms natural", () => {
  const { dialog, done } = make(
    {
      kind: "form",
      message: "prose\n".repeat(100),
      fields: [{ key: "n", type: "integer", required: true }],
    },
    () => 5,
  );
  dialog.focused = true;
  dialog.handleInput(enter);
  dialog.handleInput("invalid");
  const before = dialog.render(60);
  dialog.handleInput(enter);
  const after = dialog.render(60);
  expect(after).not.toEqual(before);
  expect(after.length).toBeLessThanOrEqual(5);
  expect(after.join("\n")).toContain(CURSOR_MARKER);
  expect(done).not.toHaveBeenCalled();
  const short = make({ kind: "form", message: "", fields: [] }, () => 100);
  expect(short.dialog.render(100).length).toBeLessThan(100);
});

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

it("keeps the full normalized host, URL and caller prose reachable by paging at narrow widths", () => {
  const host = `${"long-subdomain.".repeat(8)}example.test:8443`;
  const { dialog, done } = make({
    kind: "url",
    url: `https://${host.toUpperCase()}/${"a".repeat(1000)}#`,
    message: `${"Caller prose\n".repeat(12)}MESSAGE-END`,
  });
  const views = pageViews(dialog, 24, 20, { height: 24, join: "" });
  expect(views.every((view) => view.includes(host))).toBe(true);
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
  expectWithin(lines, 50);
  for (let i = 0; i < 100; i++) dialog.handleInput("\x1b[6~");
  expect(dialog.render(50).join("\n")).toContain("END");
  dialog.handleInput(enter);
  expect(done).toHaveBeenCalledWith({ action: "accept" });
});
