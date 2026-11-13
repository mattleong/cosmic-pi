import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Str from "effect/String";
import * as Fn from "effect/Function";
import {
  clipProse,
  countLabel,
  formatBytes,
  formatClockTime,
  nameListForms,
} from "../src/display.ts";

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
  expect(Fn.pipe(sameDay, Str.includes("Nov"))).toBe(false);
  expect(Fn.pipe(nextDay, Str.includes("Nov"))).toBe(true);
  expect(undated).toBe(nextDay);
  // No seconds on any form.
  expect(Fn.pipe(nextDay, Str.includes("41"))).toBe(false);
});

it("groups the digits of counts from 1,000", () => {
  expect(countLabel(80_000, "character")).toBe("80,000 characters");
  expect(countLabel(152_310, "character")).toBe("152,310 characters");
  expect(countLabel(999, "character")).toBe("999 characters");
  expect(countLabel(1, "character")).toBe("1 character");
});

it("cuts prose at the last whole word that keeps most of the budget", () => {
  const prose = Fn.pipe("quota detail ", Str.repeat(20));
  const cut = clipProse(prose, 60);
  expect(cut.length).toBeLessThanOrEqual(60);
  expect(cut).toMatch(/ (?:quota|detail)…$/u);
  expect(cut.length).toBeGreaterThan(36);
  // A word that ends exactly at the budget's edge stays whole.
  expect(clipProse("approve the plan now", 17)).toBe("approve the plan…");
  expect(clipProse("short", 60)).toBe("short");
});

it("cuts one long token mid-word rather than giving up most of the budget", () => {
  const token = Fn.pipe("x", Str.repeat(100));
  expect(clipProse(`Failed: ${token}`, 40)).toBe(`Failed: ${Fn.pipe("x", Str.repeat(31))}…`);
});

it("narrows a list of names by counting the ones it leaves out", () => {
  expect(nameListForms(["auth-review", "db-migration", "docs-sweep"])).toEqual([
    "auth-review, db-migration, docs-sweep",
    "auth-review, db-migration +1",
    "auth-review +2",
  ]);
  expect(nameListForms(["auth-review"])).toEqual(["auth-review"]);
  expect(nameListForms([])).toEqual([]);
});
