import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Str from "effect/String";
import { formatBytes, formatClockTime } from "../src/display.ts";

it("drops a trailing .0 from sizes, as durations do", () => {
  expect(formatBytes(18 * 1024)).toBe("18 KB");
  expect(formatBytes(1.5 * 1024 ** 2)).toBe("1.5 MB");
});

it("shows the date only when an absolute time falls on another local day", () => {
  const evening = DateTime.toEpochMillis(
    DateTime.makeZonedUnsafe(
      { year: 2026, month: 11, day: 3, hour: 22, minute: 59, second: 41 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    ),
  );
  const sameDay = formatClockTime(DateTime.makeUnsafe(evening), evening + 60_000);
  const nextDay = formatClockTime(DateTime.makeUnsafe(evening), evening + 86_400_000);
  const undated = formatClockTime(DateTime.makeUnsafe(evening));
  expect(Str.includes("Nov")(sameDay)).toBe(false);
  expect(Str.includes("Nov")(nextDay)).toBe(true);
  expect(undated).toBe(nextDay);
  // No seconds on any form.
  expect(Str.includes("41")(nextDay)).toBe(false);
});
