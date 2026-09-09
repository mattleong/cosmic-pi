import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { formatterTasks } from "../../eval/formatter-tasks.ts";
import { checkAnswer } from "../../eval/score.ts";

const receiptRows = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        team: Schema.String,
        cycle: Schema.Finite,
        cents: Schema.Finite,
        approved: Schema.Boolean,
      }),
    ),
  ),
);
const bundleRows = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ id: Schema.String, required: Schema.Array(Schema.String) })),
  ),
);
const grantRows = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ bundle: Schema.String, granted: Schema.Array(Schema.String) })),
  ),
);
const jobRows = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        worker: Schema.String,
        start: Schema.Finite,
        end: Schema.Finite,
      }),
    ),
  ),
);
const releaseRows = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        public: Schema.Boolean,
        title: Schema.String,
        owner: Schema.NullOr(Schema.String),
        notes: Schema.String,
        labels: Schema.Array(Schema.String),
        links: Schema.Array(Schema.String),
      }),
    ),
  ),
);

describe("fresh formatter task oracles", () => {
  it("independently accumulates every receipt group, including zero-approved groups", () => {
    const task = formatterTasks[0]!;
    const groups = new Map<
      string,
      { team: string; cycle: number; approvedCount: number; cents: number; receiptIds: string[] }
    >();
    for (const text of Object.values(task.files))
      for (const row of receiptRows(text)) {
        const key = `${row.team}:${row.cycle}`;
        const group = groups.get(key) ?? {
          team: row.team,
          cycle: row.cycle,
          approvedCount: 0,
          cents: 0,
          receiptIds: [],
        };
        if (row.approved) {
          group.approvedCount++;
          group.cents += row.cents;
          group.receiptIds.push(row.id);
        }
        groups.set(key, group);
      }
    const result = [...groups.values()]
      .map((row) => ({ ...row, receiptIds: row.receiptIds.sort() }))
      .sort((a, b) => a.team.localeCompare(b.team) || a.cycle - b.cycle);
    expect(result).toEqual(task.expected);
    expect(result).toHaveLength(16);
    expect(result.filter((row) => row.approvedCount === 0)).toHaveLength(4);
  });

  it("reconciles missing grants, empty requirements, and unknown bundles", () => {
    const task = formatterTasks[1]!;
    const grants = new Map(
      grantRows(task.files["grants.json"]!).map((row) => [row.bundle, new Set(row.granted)]),
    );
    const result = bundleRows(task.files["bundles.json"]!)
      .map((bundle) => {
        const required = new Set(bundle.required),
          granted = grants.get(bundle.id) ?? new Set<string>();
        const missing = [...required].filter((id) => !granted.has(id)).sort();
        return {
          bundle: bundle.id,
          requiredCount: required.size,
          grantedCount: granted.size,
          missing,
          extra: [...granted].filter((id) => !required.has(id)).sort(),
          complete: missing.length === 0,
        };
      })
      .sort((a, b) => a.bundle.localeCompare(b.bundle));
    expect(result).toEqual(task.expected);
    expect(result.find((row) => row.bundle === "bundle-08")?.grantedCount).toBe(0);
    expect(result.find((row) => row.bundle === "bundle-09")?.complete).toBe(true);
  });

  it("checks interval overlaps with an independent minute-by-minute occupancy oracle", () => {
    const task = formatterTasks[2]!;
    const jobs = Object.values(task.files).flatMap((text) => jobRows(text));
    const overlaps = new Map<
      string,
      { worker: string; left: string; right: string; start: number; end: number }
    >();
    for (const worker of new Set(jobs.map((row) => row.worker))) {
      for (let minute = 0; minute < 30; minute++) {
        const active = jobs
          .filter((row) => row.worker === worker && row.start <= minute && row.end > minute)
          .map((row) => row.id)
          .sort();
        for (let a = 0; a < active.length; a++)
          for (let b = a + 1; b < active.length; b++) {
            const left = active[a]!,
              right = active[b]!,
              key = `${worker}:${left}:${right}`;
            const overlap = overlaps.get(key) ?? {
              worker,
              left,
              right,
              start: minute,
              end: minute + 1,
            };
            overlap.end = minute + 1;
            overlaps.set(key, overlap);
          }
      }
    }
    const result = [...overlaps.values()].sort(
      (a, b) =>
        a.worker.localeCompare(b.worker) ||
        a.left.localeCompare(b.left) ||
        a.right.localeCompare(b.right),
    );
    expect(result).toEqual(task.expected);
    expect(result).toHaveLength(15);
    expect(
      result.some(
        (row) =>
          [row.left, row.right].includes("touching") || [row.left, row.right].includes("empty"),
      ),
    ).toBe(false);
  });

  it("preserves structured export fields, inner array order, and text controls", () => {
    const task = formatterTasks[3]!;
    const result = Object.values(task.files)
      .flatMap((text) => releaseRows(text))
      .filter((row) => row.public)
      .map(({ id, title, owner, notes, labels, links }) => ({
        id,
        title,
        owner,
        notes,
        labels,
        links,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(result).toEqual(task.expected);
    expect(result).toHaveLength(9);
    const queue = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ defaultQueue: Schema.String })),
    )(formatterTasks[4]!.files["support/queues.json"]!);
    expect(queue.defaultQueue).toBe(formatterTasks[4]!.expected);
    const control = formatterTasks[5]!,
      document = control.files["templates/sample.json.txt"]!;
    expect(document).toBe(control.expected);
    expect(checkAnswer(JSON.stringify(document.trimEnd()), control)).toBe(false);
    for (const fixture of formatterTasks) {
      expect(checkAnswer(JSON.stringify(fixture.expected), fixture)).toBe(true);
      expect(checkAnswer("null", fixture)).toBe(false);
    }
  });
});
