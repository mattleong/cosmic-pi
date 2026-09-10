import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { stripTerminalControls } from "pi-cosmic-core";
import type { McpGatewayReply } from "../tools/model.ts";

const PageSchema = Schema.Struct({
  offset: Schema.Natural,
  next: Schema.NullOr(Schema.Natural),
  total: Schema.Natural,
  text: Schema.String.check(Schema.isMaxLength(50_000)),
  origin: Schema.Struct({
    action: Schema.String.check(Schema.isMaxLength(64)),
    outcome: Schema.Literals(["completed", "unknown", "not-sent"]),
    isError: Schema.Boolean,
    outputValidation: Schema.optionalKey(Schema.Literals(["failed", "passed"])),
  }),
});
export interface McpResultPage {
  readonly offset: number;
  readonly next: number | undefined;
  readonly total: number;
  readonly lines: ReadonlyArray<string>;
}
export const resultPage = (reply: McpGatewayReply): McpResultPage | undefined => {
  if (reply.action !== "result.read" || reply.isError) return undefined;
  const decoded = Schema.decodeUnknownOption(PageSchema)(reply.data);
  if (Option.isNone(decoded)) return undefined;
  const page = decoded.value;
  if (page.next !== null && page.next <= page.offset) return undefined;
  const origin = `${page.origin.action}: ${page.origin.outcome}${page.origin.isError ? ", original operation failed" : ""}${page.origin.outputValidation === "failed" ? ", output validation failed" : ""}`;
  return {
    offset: page.offset,
    next: page.next ?? undefined,
    total: page.total,
    lines: [
      origin,
      `Characters ${page.offset} to ${page.next ?? page.total} of ${page.total}`,
      ...reply.notices.map((line) => stripTerminalControls(line).slice(0, 1024)),
      "",
      ...stripTerminalControls(page.text).split("\n"),
    ],
  };
};

/** At most four local pages and 128 previous offsets. Every navigation reauthorizes a read. */
export class McpResultNavigation {
  private pages = new Map<number, McpResultPage>();
  private previous: number[] = [];
  private current: McpResultPage | undefined;
  get page(): McpResultPage | undefined {
    return this.current;
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
    this.pages.set(page.offset, page);
    while (this.pages.size > 4) this.pages.delete(this.pages.keys().next().value!);
  }
  /** Invalidation withdraws text but keeps only safe cursor navigation state. */
  invalidate(): void {
    this.pages.clear();
    this.current = undefined;
  }
  unavailable(): void {
    this.invalidate();
    this.previous = [];
  }
}
