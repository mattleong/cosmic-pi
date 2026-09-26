import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { projectReadCompleteness, readResultToGuestData } from "../src/tools/read-result.ts";
import { truncation } from "./support/read.ts";

describe("read completeness projection", () => {
  it("proves only an unscoped text read with absent native details complete", () => {
    expect(projectReadCompleteness({}, "whole file", undefined)).toEqual({
      completeness: "complete",
    });
    expect(projectReadCompleteness({ offset: 1 }, "whole file", undefined)).toEqual({
      completeness: "complete",
    });
  });

  it("classifies caller-selected ranges without parsing the native footer", () => {
    expect(projectReadCompleteness({ offset: 3 }, "tail", undefined)).toEqual({
      completeness: "partial",
      reason: "offset",
    });
    expect(
      projectReadCompleteness(
        { limit: 1 },
        "first\n\n[2 more lines in file. Use offset=2 to continue.]",
        undefined,
      ),
    ).toEqual({ completeness: "unknown", reason: "limited-read" });
  });

  it("uses valid native truncation metadata and advances only across complete lines", () => {
    expect(
      projectReadCompleteness({}, "one\ntwo\n\n[footer]", { truncation: truncation() }),
    ).toEqual({
      completeness: "partial",
      reason: "native-truncation",
      truncatedBy: "lines",
      nextOffset: 3,
    });
    expect(
      projectReadCompleteness({ offset: 7 }, "one\ntwo\n\n[footer]", {
        truncation: truncation({ truncatedBy: "bytes" }),
      }),
    ).toEqual({
      completeness: "partial",
      reason: "offset",
      truncatedBy: "bytes",
      nextOffset: 9,
    });
    for (const metadata of [
      truncation({ content: "", outputLines: 0, firstLineExceedsLimit: true, outputBytes: 0 }),
      truncation({ lastLinePartial: true }),
    ]) {
      expect(projectReadCompleteness({}, "diagnostic", { truncation: metadata })).toEqual({
        completeness: "partial",
        reason: "native-truncation",
        truncatedBy: "lines",
      });
    }
  });

  it("refuses inconsistent continuation counts without inferring native cutoff thresholds", () => {
    for (const metadata of [
      truncation({ content: "one", outputLines: 50, totalLines: 100, outputBytes: 3 }),
      truncation({ outputBytes: 6 }),
      truncation({ outputLines: 0 }),
    ]) {
      expect(projectReadCompleteness({}, "native output", { truncation: metadata })).toEqual({
        completeness: "unknown",
        reason: "metadata-unavailable",
      });
    }
    expect(
      projectReadCompleteness({}, "one\n", {
        truncation: truncation({ content: "one\n", outputLines: 2, outputBytes: 4 }),
      }),
    ).toMatchObject({ completeness: "partial", nextOffset: 3 });
  });

  it("treats malformed metadata and text-only image diagnostics as unknown", () => {
    for (const [text, details] of [
      ["plain", {}],
      ["plain", { truncation: { truncated: true, truncatedBy: "lines" } }],
      ["plain", { truncation: truncation({ truncated: false, truncatedBy: null }) }],
      ["Read image file [image/tiff]\n[Image omitted]", undefined],
    ] as const) {
      expect(projectReadCompleteness({}, text, details)).toEqual({
        completeness: "unknown",
        reason: "metadata-unavailable",
      });
    }
    expect(projectReadCompleteness({ offset: 9 }, "plain", {})).toEqual({
      completeness: "unknown",
      reason: "metadata-unavailable",
    });
  });
});

describe("read guest result conversion", () => {
  it.effect("distinguishes malformed text blocks from a complete empty file", () =>
    Effect.gen(function* () {
      for (const content of [
        [],
        [{ type: "text" }],
        [{ type: "text", text: "" }, { type: "text" }],
      ]) {
        const result = { content };
        const structured = yield* readResultToGuestData(
          { path: "fixture", format: "structured" },
          result,
        );
        expect(structured).toMatchObject({
          completeness: "unknown",
          reason: "metadata-unavailable",
        });
        yield* readResultToGuestData({ path: "fixture", requireComplete: true }, result).pipe(
          Effect.flip,
        );
        expect(yield* readResultToGuestData({ path: "fixture" }, result)).toBe(
          content.length > 1 ? "\n" : "",
        );
      }
      expect(
        yield* readResultToGuestData(
          { path: "empty", format: "structured", requireComplete: true },
          { content: [{ type: "text", text: "" }] },
        ),
      ).toEqual({ text: "", completeness: "complete" });
    }),
  );

  it.effect("keeps native text and continuation notes byte-for-byte", () =>
    Effect.gen(function* () {
      const text = "α\nβ\n\n[Showing lines 1-2 of 3. Use offset=3 to continue.]";
      const details = { truncation: truncation() };
      expect(
        yield* readResultToGuestData(
          { path: "fixture", format: "structured" },
          { content: [{ type: "text", text }], details },
        ),
      ).toEqual({
        text,
        completeness: "partial",
        reason: "native-truncation",
        truncatedBy: "lines",
        nextOffset: 3,
      });
      expect(
        yield* readResultToGuestData(
          { path: "fixture" },
          { content: [{ type: "text", text }], details },
        ),
      ).toBe(text);
    }),
  );

  it.effect("refuses image blocks before they cross the guest boundary", () =>
    Effect.gen(function* () {
      const error = yield* readResultToGuestData(
        { path: "fixture", format: "structured" },
        {
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data: "SECRET", mimeType: "image/png" },
          ],
          details: undefined,
        },
      ).pipe(Effect.flip);
      expect(error.message).toContain("image content");
      expect(error.message).not.toContain("SECRET");
    }),
  );
});
