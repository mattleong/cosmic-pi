import { afterEach, describe, expect, test } from "vitest";
import type { ToolRenderers, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createToolPresentationHarness } from "../../testing";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { createBuiltinPreviewRenderers } from "../../src/tools/renderers/registration";
import { ALL_CODE_PREVIEW_TOOLS } from "../../src/tools/names";
import { previewBodiesDisabled, stripAnsi } from "../support/render";

const cases = [
  {
    name: "bash",
    args: { command: "printf 'FIRST_COMMAND\\n'\nprintf 'LAST_COMMAND\\n'" },
    output: "first log\nlast log",
    retained: "last log",
  },
  {
    name: "read",
    args: { path: "/project/source.ts" },
    output: "const first = 1;\nconst last = 2;",
    retained: "const last",
  },
  {
    name: "write",
    args: { path: "/project/source.ts", content: "const first = 1;\nconst last = 2;" },
    output: "Successfully wrote 38 bytes to /project/source.ts",
    retained: "const last",
  },
  {
    name: "edit",
    args: {
      path: "/project/source.ts",
      edits: Array.from({ length: 5 }, (_, index) => ({
        oldText: `OLD_${index}`,
        newText: `NEW_${index}`,
      })),
    },
    output: "Successfully replaced text in /project/source.ts.",
    retained: "NEW_4",
  },
  {
    name: "grep",
    args: { pattern: "needle", path: "/project", context: 2 },
    output: "source.ts:1:needle\nsource.ts:2:tail",
    retained: "tail",
  },
  {
    name: "find",
    args: { pattern: "*.ts", path: "/project" },
    output: "src/first.ts\nsrc/last.ts",
    retained: "last.ts",
  },
  { name: "ls", args: { path: "/project" }, output: "first.ts\nlast.ts", retained: "last.ts" },
] as const;

function registered(
  mode: "off" | "on" | "border" = "off",
  style: "compact" | "preview" = "compact",
) {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    tools: [...ALL_CODE_PREVIEW_TOOLS],
    toolCallBackground: mode,
    toolCallCollapsedStyle: style,
    toolCallTiming: false,
    ...previewBodiesDisabled,
  });
  const tools = new Map<string, ToolRenderers>();
  for (const name of ALL_CODE_PREVIEW_TOOLS) {
    const renderers = createBuiltinPreviewRenderers(name, {
      cwd: "/project",
      selfShell: true,
      scheduleAnimation: () => () => undefined,
    });
    if (renderers) tools.set(name, renderers);
  }
  return tools;
}
function result(...texts: string[]): AgentToolResult<unknown> {
  return { content: texts.map((text) => ({ type: "text" as const, text })), details: {} };
}
function plain(lines: string[]) {
  return stripAnsi(lines.join("\n"));
}
afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

/** Call source that expansion must keep, including when the call fails. */
const sourceMarkers = (name: string): string[] =>
  name === "bash"
    ? ["FIRST_COMMAND", "LAST_COMMAND"]
    : name === "write"
      ? ["const first", "const last"]
      : name === "edit"
        ? ["OLD_4", "NEW_4"]
        : [];
const count = (text: string, phrase: string) => text.split(phrase).length - 1;

describe("registered builtin presentation", () => {
  for (const fixture of cases) {
    test(`${fixture.name} retains expanded content across toggles and narrow widths`, () => {
      for (const mode of ["off", "on", "border"] as const) {
        const tool = registered(mode).get(fixture.name)!;
        const harness = createToolPresentationHarness(tool);
        harness.call(fixture.args);
        harness.result(result(fixture.output), { isPartial: true });
        expect(plain(harness.render(100)).includes(fixture.retained)).toBe(false);
        harness.result(result(fixture.output));
        for (const expanded of [true, false, true]) {
          harness.call(fixture.args, { expanded });
          harness.result(result(fixture.output), { expanded });
          const text = plain(harness.render(100));
          expect(text.includes(fixture.retained)).toBe(expanded);
          for (const marker of sourceMarkers(fixture.name))
            expect(!expanded || text.includes(marker)).toBe(true);
          for (const width of [16, 40])
            expect(harness.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
          harness.invalidate();
        }
      }
    });
    test(`${fixture.name} explains unknown errors by their first line and keeps failure call source`, () => {
      for (const mode of ["off", "on", "border"] as const) {
        const harness = createToolPresentationHarness(registered(mode).get(fixture.name)!);
        const failure = result("UNCLASSIFIED_FAILURE", "Inspect destination before retrying.");
        for (const expanded of [false, true, false, true]) {
          harness.call(fixture.args, { expanded });
          harness.result(failure, { expanded, isError: true });
          const text = plain(harness.render(160));
          // One issue line; expansion adds the raw error once under its own label.
          expect(count(text, "UNCLASSIFIED_FAILURE")).toBe(expanded ? 2 : 1);
          expect(count(text, "Inspect destination before retrying")).toBe(expanded ? 1 : 0);
          for (const marker of sourceMarkers(fixture.name))
            expect(!expanded || text.includes(marker)).toBe(true);
          for (const width of [8, 16, 40])
            expect(harness.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
        }
      }
    });
    test(`${fixture.name} tolerates malformed arguments and cancellation`, () => {
      const harness = createToolPresentationHarness(registered().get(fixture.name)!);
      harness.call({ path: 17, command: false, edits: [null] }, { expanded: true });
      harness.result(result("Operation aborted"), { expanded: true, isError: true });
      expect(() => harness.render(20)).not.toThrow();
    });
  }
  test("write diff retains independent raw-result instructions", () => {
    const harness = createToolPresentationHarness(registered().get("write")!, {
      state: { codePreviewWriteBeforeSnapshot: { content: "OLD_SOURCE" } },
    });
    harness.call({ path: "source.ts", content: "NEW_SOURCE" }, { expanded: true });
    harness.result(
      result("Successfully wrote 10 bytes to source.ts\nVerify the remote copy before retrying."),
      { expanded: true },
    );
    const text = plain(harness.render(120));
    expect(text).toContain("OLD_SOURCE");
    expect(text).toContain("NEW_SOURCE");
    expect(text).toContain("Verify the remote copy before retrying.");
  });
  test("unverified write size evidence retains attention and raw result on expansion", () => {
    const harness = createToolPresentationHarness(registered().get("write")!);
    const args = { path: "source.ts", content: "NEW_SOURCE" };
    const output = result("WRITE_RECEIPT\nVerify destination before retrying.");
    output.details = {
      codePreviewBeforeWrite: {
        kind: "skipped",
        reason: "previous file too large",
        maxBytes: 10,
        byteLength: 20,
        sizeExceeded: false,
      },
    };
    harness.call(args);
    harness.result(output);
    // Diff availability is informational: expansion explains it, collapsed rows stay quiet.
    expect(plain(harness.render(120))).not.toContain("Diff unavailable");
    harness.call(args, { expanded: true });
    harness.result(output, { expanded: true });
    const text = plain(harness.render(120));
    expect(text).toContain("Diff unavailable");
    expect(text).toContain("NEW_SOURCE");
    expect(text).toContain("WRITE_RECEIPT");
    expect(text).toContain("Verify destination before retrying.");
    expect(text).not.toMatch(/new file/iu);
  });
  test("preview style shows the same issue line above builtin bodies", () => {
    for (const name of ["read", "write", "edit", "grep", "find", "ls"] as const) {
      const fixture = cases.find((entry) => entry.name === name)!;
      const harness = createToolPresentationHarness(registered("off", "preview").get(name)!);
      const failure = result("UNCLASSIFIED_FAILURE", "Inspect destination before retrying.");
      for (const expanded of [false, true, false]) {
        harness.call(fixture.args, { expanded });
        harness.result(failure, { expanded, isError: true });
        const text = plain(harness.render(160));
        expect(count(text, "UNCLASSIFIED_FAILURE")).toBe(expanded ? 2 : 1);
        expect(text.includes("Inspect destination before retrying")).toBe(expanded);
      }
    }
    const bash = createToolPresentationHarness(registered("off", "preview").get("bash")!);
    bash.call({ command: "rm -rf build" });
    bash.result(result("done"));
    expect(plain(bash.render(160))).toMatch(/Deletes files recursively/u);
  });
  test("preview-style write and edit put issues under the heading, above their call content", () => {
    const write = createToolPresentationHarness(registered("off", "preview").get("write")!);
    const content = "SECRET_LINE -----BEGIN PRIVATE KEY-----";
    write.call({ path: "/project/key.pem", content }, { expanded: true });
    write.result(result("Successfully wrote"), { expanded: true });
    const text = plain(write.render(160));
    const warning = text.search(/May contain a private key/u);
    expect(warning).toBeGreaterThan(text.indexOf("key.pem"));
    expect(warning).toBeLessThan(text.indexOf("SECRET_LINE"));
    expect(count(text, "May contain a private key")).toBe(1);
    const edit = createToolPresentationHarness(registered("off", "preview").get("edit")!);
    edit.call(
      { path: "/project/a.ts", edits: [{ oldText: "a", newText: "b" }] },
      {
        executionStarted: true,
      },
    );
    edit.result(result("Operation failed: disk full"), { isError: true });
    const failed = plain(edit.render(160)).split("\n");
    expect(failed[1]).toContain("Operation failed: disk full");
  });

  test("preview style states a failed command's closing status once, keeping its output", () => {
    const bash = createToolPresentationHarness(registered("off", "preview").get("bash")!);
    const failure = result("OUTPUT_LINE\n\nCommand exited with code 127");
    const before = structuredClone(failure);
    for (const expanded of [false, true]) {
      bash.call({ command: "pnpx tsx build.ts" }, { expanded });
      bash.result(failure, { expanded, isError: true });
      const text = plain(bash.render(160));
      expect(count(text, "127")).toBe(1);
      expect(text).toContain("OUTPUT_LINE");
    }
    expect(failure).toEqual(before);
    // Only Pi's status on a failed call is folded into the issue; ordinary output stays.
    const printed = createToolPresentationHarness(registered("off", "preview").get("bash")!);
    printed.call({ command: "cat status.txt" });
    printed.result(result("Command exited with code 3"));
    expect(plain(printed.render(160))).toContain("code 3");
  });

  test("preview style flags risky commands and secrets before any result exists", () => {
    const bash = createToolPresentationHarness(registered("off", "preview").get("bash")!);
    bash.call({ command: "sudo rm -rf /tmp/x" });
    expect(plain(bash.render(160))).toMatch(/Deletes files recursively/u);
    const write = createToolPresentationHarness(registered("off", "preview").get("write")!);
    write.call({ path: "/project/k.pem", content: "-----BEGIN PRIVATE KEY-----" });
    expect(plain(write.render(160))).toMatch(/May contain a private key/u);
  });

  test("preview style names cancellation and truncation even without a classified summary", () => {
    const read = createToolPresentationHarness(registered("off", "preview").get("read")!);
    read.call({ path: "/project/a.ts" });
    read.result(result("Operation aborted"), { isError: true });
    expect(plain(read.render(160))).toMatch(/Cancelled/u);
    const bash = createToolPresentationHarness(registered("off", "preview").get("bash")!);
    const parts: AgentToolResult<unknown> = {
      content: Array.from({ length: 129 }, () => ({ type: "text" as const, text: "line" })),
      details: { truncation: { truncated: true } },
    };
    bash.call({ command: "cat big.log" });
    bash.result(parts);
    expect(plain(bash.render(160))).toMatch(/Output was cut off/u);
  });

  test("expansion keeps exact arguments the heading cannot show exactly", () => {
    const tools = registered();
    const expanded = (name: string, args: Readonly<Record<string, string>>, output = "ok") => {
      const harness = createToolPresentationHarness(tools.get(name)!);
      harness.call(args, { expanded: true });
      harness.result(result(output), { expanded: true });
      return plain(harness.render(200));
    };
    expect(expanded("bash", { command: 'echo "a    b"' })).toContain('echo "a    b"');
    const pattern = "needle  with  gaps";
    expect(expanded("grep", { pattern, path: "/project" })).toContain(JSON.stringify(pattern));
    const long = `/project/${"deep/".repeat(20)}file.ts`;
    expect(expanded("read", { path: long })).toContain(long);
    // Without truncation or a limit, a notice-shaped final line is file content.
    const text = "body\n\n[10 more lines in file. Use offset=11 to continue.]";
    expect(expanded("read", { path: "/project/a.md" }, text)).toContain("offset=11");
  });

  test("expanded bash repeats the command only when the heading cannot show it", () => {
    const tool = registered().get("bash")!;
    const lines = (command: string) => {
      const harness = createToolPresentationHarness(tool);
      harness.call({ command }, { expanded: true });
      harness.result(result("ok"), { expanded: true });
      return plain(harness.render(100));
    };
    expect(count(lines("pnpm lint"), "pnpm lint")).toBe(1);
    // Multi-line commands keep their formatted source beneath the one-line heading.
    const multiline = lines("printf 'FIRST'\nprintf 'SECOND'").split("\n");
    expect(multiline.map((line) => line.trim())).toContain("printf 'SECOND'");
    const long = `echo ${"x".repeat(120)} END_OF_COMMAND`;
    expect(lines(long)).toContain("END_OF_COMMAND");
  });

  test("read leaves image bytes native and retains companion text in both styles", () => {
    for (const style of ["compact", "preview"] as const) {
      const harness = createToolPresentationHarness(registered("off", style).get("read")!);
      const image = { type: "image" as const, data: "NATIVE_IMAGE_BYTES", mimeType: "image/png" };
      const value = {
        content: [{ type: "text" as const, text: "image companion" }, image],
        details: {},
      };
      harness.call({ path: "photo.png" }, { expanded: true });
      harness.result(value, { expanded: true });
      const text = plain(harness.render());
      expect(text).toContain("image companion");
      expect(text).not.toContain(image.data);
      expect(value.content[1]).toBe(image);
    }
  });
});
