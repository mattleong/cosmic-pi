# Pre-Effect migration baseline

Recorded on 2026-07-19 from branch `effect` before production behavior was migrated.

## Validation

`pnpm validate` passed on Node 24.15.0 and pnpm 10.33.0.

| Package          |   Tests |
| ---------------- | ------: |
| pi-advisor       |     308 |
| pi-better-openai |      78 |
| pi-better-xai    |       7 |
| pi-code-previews |     170 |
| pi-cosmic-ui     |      20 |
| **Total**        | **583** |

The pre-migration `pi-code-previews` build produced:

- `dist/index.js`: 215.34 kB, 48.52 kB gzip
- `dist/index.d.ts`: 3.19 kB, 1.21 kB gzip

## Representative code-preview benchmarks

Command: `pnpm --filter pi-code-previews bench:recommended`

Environment: macOS arm64, Node 24.15.0, five samples, 80 ms sample window.

| Case                                                        |        Mean |
| ----------------------------------------------------------- | ----------: |
| Many short changed lines, plain 80-column cold render       | 8.939 ms/op |
| Many short changed lines, highlighted 80-column cold render |  16.2 ms/op |
| Unicode/tabs, plain 80-column cold render                   |  20.9 ms/op |
| Three multiline proposed edits, collapsed cold render       |  11.9 ms/op |
| Medium applied diff, expanded highlighted cold render       |  33.0 ms/op |
| Whole-file 2,000-line structured rewrite                    | 279.4 ms/op |
| Repeated reordered 32×32 smart line pairing                 | 7.704 ms/op |

Benchmarks are noisy and must be compared with like-for-like runs on the same machine. A median regression above 10% requires explicit review rather than automatic acceptance.
