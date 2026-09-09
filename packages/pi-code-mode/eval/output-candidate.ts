/** Output-only intervention. Leave tool selection, authority, and execution limits unchanged. */
export const outputGuidelines = [
  "Before calling tools, decide which fields, counts, or excerpts the next decision needs. " +
    "Parse, filter, join, or aggregate inside code_mode and return that projection, not the " +
    "raw read/search responses. Promise.all results are intermediate data, not the final answer. " +
    "For structured results, return JSON.stringify of the selected result without indentation.",
  "For large or unfamiliar input, inspect a small schema sample, then compute over the full " +
    "input inside the program. On a parse failure, return the error and a short relevant " +
    "sample, not the entire input. Avoid console logging intermediate data; logs also enter context.",
  "Keep returned evidence sufficient to verify the answer: relevant paths, line numbers, " +
    "exact excerpts, totals, and missing-data notices when needed. Do not silently drop requested " +
    "records or evidence. Fetch missing or truncated input before claiming completeness. " +
    "Return full content when the task requires it; otherwise omit unrelated data.",
];
