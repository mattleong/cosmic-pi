import type * as Schema from "effect/Schema";
import type { EvalTask } from "./tasks.ts";

const json = (value: Schema.Json) => JSON.stringify(value, null, 2) + "\n";
const task = (
  id: string,
  eligible: boolean,
  prompt: string,
  files: EvalTask["files"],
  expected: Schema.Json,
): EvalTask => ({
  id,
  eligible,
  split: "held-out",
  files,
  expected,
  prompt: `${prompt}\nReturn only the specified JSON value. Preserve all required records and string values. Do not modify files.`,
});
const teams = ["blue", "gold", "indigo", "jade"];
const expenses = Array.from({ length: 52 }, (_, n) => ({
  id: `receipt-${String(n).padStart(2, "0")}`,
  team: teams[n % 4]!,
  cycle: n >= 48 ? 4 : (Math.floor(n / 4) % 3) + 1,
  cents: 100 + n * 7,
  approved: n < 48 && n % 5 !== 0,
  note: "Synthetic receipt; include amounts only when approved is true.",
}));
const rollup = teams.flatMap((team) =>
  [1, 2, 3, 4].map((cycle) => {
    const approved = expenses.filter(
      (row) => row.team === team && row.cycle === cycle && row.approved,
    );
    return {
      team,
      cycle,
      approvedCount: approved.length,
      cents: approved.reduce((sum, row) => sum + row.cents, 0),
      receiptIds: approved.map((row) => row.id).sort(),
    };
  }),
);
const bundles = Array.from({ length: 10 }, (_, n) => ({
  id: `bundle-${String(n).padStart(2, "0")}`,
  required: n === 9 ? [] : [`r${n % 4}`, `r${(n + 1) % 4}`, "read"],
}));
const grants = bundles
  .filter((_, n) => n !== 8)
  .map((bundle, n) => ({
    bundle: bundle.id,
    granted:
      bundle.required.length === 0
        ? ["read"]
        : n % 2 === 0
          ? [bundle.required[0]!, "read", "diagnostics"]
          : bundle.required.slice(0, 2),
  }));
const audit = bundles.map((bundle) => {
  const granted = grants.find((row) => row.bundle === bundle.id)?.granted ?? [];
  const missing = bundle.required.filter((id) => !granted.includes(id)).sort();
  return {
    bundle: bundle.id,
    requiredCount: bundle.required.length,
    grantedCount: granted.length,
    missing,
    extra: granted.filter((id) => !bundle.required.includes(id)).sort(),
    complete: missing.length === 0,
  };
});
const jobs = [
  ...Array.from({ length: 18 }, (_, n) => ({
    id: `job-${String(n).padStart(2, "0")}`,
    worker: ["east", "west", "central"][n % 3]!,
    start: Math.floor(n / 3) * 4,
    end: Math.floor(n / 3) * 4 + 6,
  })),
  { id: "touching", worker: "east", start: 26, end: 30 },
  { id: "empty", worker: "west", start: 5, end: 5 },
];
const conflicts = jobs
  .flatMap((left, i) =>
    jobs.slice(i + 1).flatMap((right) => {
      const start = Math.max(left.start, right.start),
        end = Math.min(left.end, right.end);
      if (left.worker !== right.worker || start >= end) return [];
      const ids = [left.id, right.id].sort();
      return [{ worker: left.worker, left: ids[0]!, right: ids[1]!, start, end }];
    }),
  )
  .sort(
    (a, b) =>
      a.worker.localeCompare(b.worker) ||
      a.left.localeCompare(b.left) ||
      a.right.localeCompare(b.right),
  );
const releases = Array.from({ length: 12 }, (_, n) => ({
  id: `release-${String(n).padStart(2, "0")}`,
  public: n % 4 !== 0,
  title: `Release item ${n}`,
  owner: n % 3 === 0 ? null : `team-${n % 3}`,
  notes:
    n % 2 === 0
      ? 'Literal JSON sample: {"count":0,"ready":false}'
      : `First line ${n}\n\nLogs:\nKeep café and indentation:  two spaces`,
  labels: ["beta", "alpha"],
  links: [`https://example.invalid/item/${n}`, `docs/item-${n}.md`],
}));
const published = releases
  .filter((row) => row.public)
  .map(({ id, title, owner, notes, labels, links }) => ({
    id,
    title,
    owner,
    notes,
    labels,
    links,
  }));
const document =
  '{\n\t"ready": false,\n  "limit": 0,\n  "owner": null,\n  "label": "café",\n  "sample": "a\\nb"\n}\n';

/** Authored for the formatter-only comparison; no exposed fixture or prompt is reused. */
export const formatterTasks: readonly EvalTask[] = [
  task(
    "FC1",
    true,
    "receipts/0.json through receipts/3.json contain arrays of {id:string,team:string,cycle:integer,cents:integer,approved:boolean,note:string}. IDs are unique. Produce a complete rollup, one record for every team/cycle appearing in the data, including groups with no approved receipts. Return an array of exactly {team,cycle,approvedCount,cents,receiptIds}; sum cents and collect IDs only for approved=true receipts. Empty groups have count 0, cents 0, and []. Sort receiptIds lexicographically and the outer array by team then numeric cycle. Ignore note.",
    Object.fromEntries(
      Array.from({ length: 4 }, (_, n) => [
        `receipts/${n}.json`,
        json(expenses.slice(n * 13, (n + 1) * 13)),
      ]),
    ),
    rollup,
  ),
  task(
    "FC2",
    true,
    "bundles.json lists {id:string,required:string[]} and grants.json lists {bundle:string,granted:string[]}. IDs and each capability array have no duplicates. Audit every bundle. A missing grants entry means []. Return an array of exactly {bundle,requiredCount,grantedCount,missing,extra,complete}. grantedCount includes all granted capabilities, including extras. missing is required minus granted; extra is granted minus required; complete is true iff missing is empty. Sort missing and extra lexicographically, and records by bundle. Include empty requirements and ignore grants for unknown bundles.",
    {
      "bundles.json": json(bundles),
      "grants.json": json([...grants, { bundle: "orphan", granted: ["read"] }]),
    },
    audit,
  ),
  task(
    "FC3",
    true,
    "jobs/a.json and jobs/b.json contain arrays of {id:string,worker:string,start:integer,end:integer}. IDs are unique. Find every conflicting pair on the same worker using half-open intervals [start,end); touching endpoints and empty intervals are not conflicts. Return an array of exactly {worker,left,right,start,end}, where left/right are the pair IDs in lexicographic order and start/end describe the overlapping interval. Include each pair once. Sort by worker, then left, then right.",
    { "jobs/a.json": json(jobs.slice(0, 10)), "jobs/b.json": json(jobs.slice(10)) },
    conflicts,
  ),
  task(
    "FC4",
    true,
    "catalog/0.json through catalog/2.json contain release records. Export every record with public=true as an array of exactly {id,title,owner,notes,labels,links}, sorted by id. Preserve all string contents, null owners, and the original order inside labels and links. Do not interpret JSON-looking notes or normalize whitespace. Exclude the public field from the export.",
    Object.fromEntries(
      Array.from({ length: 3 }, (_, n) => [
        `catalog/${n}.json`,
        json(releases.slice(n * 4, n * 4 + 4)),
      ]),
    ),
    published,
  ),
  task(
    "FC5",
    false,
    "Read support/queues.json and return its defaultQueue value as one JSON string. No other files are needed.",
    { "support/queues.json": json({ defaultQueue: "night-ops", fallbackQueue: "core-dev" }) },
    "night-ops",
  ),
  task(
    "FC6",
    false,
    "Return the complete contents of templates/sample.json.txt as one JSON string. Preserve every character, including tabs, spaces, escapes, and the final newline. Do not parse or reformat the document.",
    { "templates/sample.json.txt": document },
    document,
  ),
];

export const formatterScheduleSeed = 20260909;
export const formatterFirstArm = (task: string, repetition: number) =>
  (formatterTasks.findIndex((item) => item.id === task) + repetition) % 2 === 0
    ? "baseline"
    : "candidate";

/** Fixed-seed task blocks; adjacent arms, with each task's first arm balanced across repeats. */
export function formatterSchedule(sessions: 24 | 48) {
  let seed = formatterScheduleSeed;
  return Array.from({ length: sessions / 12 }, (_, repetition) => {
    const order = [...formatterTasks];
    for (let n = order.length - 1; n > 0; n--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const target = seed % (n + 1);
      [order[n], order[target]] = [order[target]!, order[n]!];
    }
    return order.flatMap((task) => {
      const variants =
        formatterFirstArm(task.id, repetition) === "baseline"
          ? (["baseline", "candidate"] as const)
          : (["candidate", "baseline"] as const);
      return variants.map((variant) => ({ task, variant, repetition }));
    });
  }).flat();
}
