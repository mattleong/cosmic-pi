import type { Theme } from "@earendil-works/pi-coding-agent";
import { managerTone } from "pi-cosmic-ui/manager/style";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { McpGatewayReply } from "../tools/model.ts";
import {
  mcpPageContentPreview,
  mcpRawTextPreview,
  sanitizeMcpDisplayText,
} from "./content-preview.ts";

const PageSchema = Schema.Struct({
  format: Schema.optionalKey(Schema.String),
  offset: Schema.Natural,
  next: Schema.NullOr(Schema.Natural),
  total: Schema.Natural,
  text: Schema.String.check(Schema.isMaxLength(50_000)),
  origin: Schema.Struct({
    action: Schema.String.check(Schema.isMaxLength(64)),
    outcome: Schema.Literals(["completed", "unknown", "not-sent"]),
    isError: Schema.Boolean,
    outputValidation: Schema.optionalKey(Schema.Literals(["failed", "passed", "unavailable"])),
  }),
});
export interface McpResultPage {
  readonly offset: number;
  readonly next: number | undefined;
  readonly total: number;
  /** Sanitized raw output, never source bytes or cursor coordinates. */
  readonly lines: ReadonlyArray<string>;
  readonly readableLines?: ReadonlyArray<string>;
  readonly originTone?: "text" | "error" | "warning";
  readonly headerLength?: number;
}
export const resultPage = (reply: McpGatewayReply): McpResultPage | undefined => {
  if (reply.action !== "result.read" || reply.isError || reply.outcome !== "completed")
    return undefined;
  const decoded = Schema.decodeUnknownOption(PageSchema)(reply.data);
  if (Option.isNone(decoded)) return undefined;
  const page = decoded.value;
  if (page.next !== null && page.next <= page.offset) return undefined;
  const validation =
    page.origin.outputValidation === "failed"
      ? ", output validation failed"
      : page.origin.outputValidation === "unavailable"
        ? ", output validation unavailable, no mismatch established"
        : "";
  const origin = `${page.origin.action}: ${page.origin.outcome}${page.origin.isError ? ", original operation failed" : ""}${validation}`;
  // Completeness is checked against the original authorized text, before any sanitization.
  // A valid JSON fragment on the first, middle, or final partial page is still only raw text.
  const complete =
    page.format === "json" &&
    page.offset === 0 &&
    page.next === null &&
    page.text.length === page.total;
  const json = complete
    ? Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(page.text)
    : Option.none();
  const preview = Option.isSome(json)
    ? mcpPageContentPreview(page.origin.action, json.value)
    : undefined;
  const header = [
    sanitizeMcpDisplayText(origin),
    `Characters ${page.offset} to ${page.next ?? page.total} of ${page.total}`,
    ...reply.notices.slice(0, 16).map((line) => sanitizeMcpDisplayText(line).slice(0, 1024)),
    "",
  ];
  let result: McpResultPage = {
    offset: page.offset,
    next: page.next ?? undefined,
    total: page.total,
    originTone:
      page.origin.isError || page.origin.outputValidation === "failed"
        ? "error"
        : page.origin.outcome !== "completed" || page.origin.outputValidation === "unavailable"
          ? "warning"
          : "text",
    headerLength: header.length,
    lines: [...header, ...(preview?.raw ?? mcpRawTextPreview(page.text)).split("\n")],
  };
  if (preview?.readable !== undefined)
    result = { ...result, readableLines: [...header, ...preview.readable.split("\n")] };
  return result;
};

/** One authorized page and 128 previous offsets. Every navigation reauthorizes a read. */
export class McpResultNavigation {
  private previous: number[] = [];
  private current: McpResultPage | undefined;
  private preferredMode: "readable" | "raw" = "readable";
  get page(): McpResultPage | undefined {
    return this.current;
  }
  get hasReadable(): boolean {
    return this.current?.readableLines !== undefined;
  }
  get mode(): "readable" | "raw" {
    return this.hasReadable ? this.preferredMode : "raw";
  }
  get lines(): ReadonlyArray<string> | undefined {
    return this.mode === "readable" ? this.current?.readableLines : this.current?.lines;
  }
  /** Style only owned page metadata, never infer meaning from untrusted result text. */
  renderLines(theme: Theme): ReadonlyArray<string> | undefined {
    return this.lines?.map((line, index) => {
      if (index === 0) return theme.fg(this.current?.originTone ?? "text", line);
      if (index === 1) return theme.fg(managerTone.value, line);
      if (index < (this.current?.headerLength ?? 0) - 1) return theme.fg("warning", line);
      return line;
    });
  }
  toggleMode(): boolean {
    if (!this.hasReadable) return false;
    this.preferredMode = this.mode === "readable" ? "raw" : "readable";
    return true;
  }
  get previousOffset(): number | undefined {
    return this.previous.at(-1);
  }
  get nextOffset(): number | undefined {
    return this.current?.next;
  }
  accept(page: McpResultPage, direction: "next" | "previous" | "current"): void {
    if (direction === "next" && this.current)
      this.previous = [...this.previous, this.current.offset].slice(-128);
    if (direction === "previous") this.previous.pop();
    this.current = page;
  }
  /** Invalidation withdraws text but keeps only safe cursor navigation state. */
  invalidate(): void {
    this.current = undefined;
  }
  unavailable(): void {
    this.invalidate();
    this.previous = [];
  }
}
