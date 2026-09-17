# Code Mode session audit

## Scope

Reviewed all 36 Code Mode invocations in the six most recent prior project sessions containing Code Mode calls. Excluded the current conversation and sessions without Code Mode. Inspected programs, recorded results, surrounding task context, and subsequent calls. Followed longer sequences where needed to assess dependencies. Did not execute logged commands or retain copies of transcripts or thinking.

All sampled Code Mode assistant messages identify `gpt-6-astra`. All 36 invocations lie on the final recorded branch of their session. Some sessions contain compactions, and the runtime changed between these sessions and the present. This is a selected observational sample, not a representative failure-rate estimate or a controlled comparison.

Local session locators below refer to JSONL line numbers, not source-code lines:

| Key | Session filename                                                      | Code Mode invocations |
| --- | --------------------------------------------------------------------- | --------------------: |
| A   | `2026-09-15T05-46-15-649Z_01a0a39a-06e1-73e6-8f82-9bb6053d0c49.jsonl` |                     2 |
| B   | `2026-09-14T23-16-22-517Z_01a0a235-1374-73e6-8f82-9bac3582d3d7.jsonl` |                     9 |
| C   | `2026-09-13T01-51-02-143Z_01a09875-f3ff-7022-be5f-319fda121a72.jsonl` |                    10 |
| D   | `2026-09-12T22-25-51-590Z_01a097ba-1be5-7022-be5f-319c9cd17bcc.jsonl` |                     7 |
| E   | `2026-09-12T19-33-20-348Z_01a0971c-295b-7022-be5f-319a65fe06a5.jsonl` |                     7 |
| F   | `2026-09-12T18-44-50-897Z_01a096ef-c450-7022-be5f-31995af6a932.jsonl` |                     1 |

## Findings

### Already-known work was sometimes serialized

- **B:23–35.** An inventory lists six compact-summary source files. The assistant then reads each in a separate assistant message, without intervening user or worker input. The six results contain about 40 KB of source. A bounded batch or concurrent ordinary reads could remove up to five response cycles. This is an ordinary-call scheduling problem too; Code Mode is not required to fix it.
- **B:70–73.** Two consecutive Code Mode batches read three files apiece. The second batch's targets were already established by earlier messages, imports, and file claims. Their recorded results total about 43,251 characters. Combining them into one size-checked program could remove one response cycle. Do not assume two concurrent outer Code Mode invocations are supported.
- **C:1678–1681.** A source search, git status, and directory listing are followed by another Code Mode program that searches already-known Pi documentation and UI files. The second group's arguments do not depend on the first result. These are plausible candidates for one combined inspection.
- **C:1851–1856.** Following an explicit 90% viewport request and source/test inspection, one program edits seven documentation files and the ratio source. A separate call edits the already-read viewport tests, then another program edits four integration-test files. The intervening results only acknowledge successful edits. Combining those known edits could remove two response cycles while preserving error handling. This does not justify automatically folding subsequent validation or failure diagnosis into the same program.
- **D:159–168.** A program reports validation timing, followed by four separate reads of configuration files already listed at line 158. Those reads do not depend on the elapsed-time result. Combining the timing lookup and bounded reads could remove up to four response cycles.
- **F:20–25.** A script names architecture and plan documents to count their lines, then the assistant reads those known documents in separate messages. This is a smaller example of collecting metadata without completing already-planned inspection.

These are counterfactual opportunities, not measured time or token savings. Some work was already batched inside shell commands. Consolidating tool calls and reducing model response cycles are different changes.

### Returning too much caused observable information loss

**A:15–17**, entry `19b25846`, combines complete architecture, README, and package files into `{path,text}` records. The recorded result says 92,938 bytes exceeds the 51,200-byte output limit. The next call searches README OAuth terms and discovery code.

Some of that follow-up recovers missing evidence. Some discovers additional material. Calling the whole chain premature termination would be wrong. The initial batch needed output sizing or better evidence selection.

**E:116–118** provides a counterexample to indiscriminate expansion: the existing batch already returns 46,466 characters. Adding every subsequent source read would risk losing evidence at the output boundary.

### Recovery accounts for other subsequent calls

Four invocations report an outer error or failed nested call:

- **B:270–272:** the interpreter rejects `/Test Files|Tests |Duration|failed|Error|Done/`. A retry using `terms.some(term => line.includes(term))` succeeds.
- **C:904–906:** an unsupported `LabeledStatement` aborts the program. Recovery submits three reads and a command together in one assistant message. Four tool calls here do not mean four additional model round trips.
- **D:169–171:** another log-filter regex is rejected by the historical conservative alternation check. String predicates work.
- **E:31–33:** string escaping loses the backslashes intended for a grep pattern, producing an unclosed-group error. A shell search recovers.

Additional shell groups at **C:1692** and **C:1734** contain regex failures while returning other useful output. A successful outer tool status does not establish that every command in a shell group succeeded.

These cases support investigating compatibility and program-construction costs separately from batching. Historical failures do not establish that the current runtime still behaves the same way.

### Several stopping points were appropriate

- **B:190–198:** search, find, and listing results are batched into 203 characters. Subsequent top-level MCP, read-error, and background-task calls deliberately exercise separate preview rendering. Nesting them would change the test.
- **B:315–326:** a single-child Code Mode call tests the singular preview label. Later searches follow a new user request to change the wording. Neither the one-call wrapper nor those later searches demonstrates wasted work.
- **C:1524 onward:** a read-transform-edit program updates a named test block. Later work examines another section and makes semantic changes. The record does not establish that all changes were knowable earlier.
- **D:150 and D:202:** programs combine process status with git checks and return compact outcomes. The assistant then reports completion. Later work at D:154 follows a new user question.
- **E:197 and E:205:** programs obtain a log's length, compute a bounded tail offset, and read it without another model decision. Later inspection occurs after validation advances or completes. That is useful dependent orchestration, not redundant access to a static result.

## What this changes

The evidence does not support a single diagnosis of Code Mode ending prematurely. It supports at least three separate questions:

1. Can already-known independent or mechanical operations be grouped with fewer model response cycles?
2. Does the returned evidence fit the output budget and support the next decision?
3. How much follow-up work is recovery from program, tool, or runtime failures?

A follow-up tool call is not itself a failure. Evaluation should preserve judgment, new evidence, user authorization, worker ownership, and preview-testing boundaries. Ordinary concurrent tool calls are a valid comparison, not something to penalize for avoiding Code Mode.

The proposed six-task read-focused pilot is too narrow to test these findings as a whole. Keep it on hold. Any replacement should include known searches and edits, bounded output selection, recovery cases, and workflows where a separate decision is necessary. Use fresh cases rather than replaying these exposed sessions as confirmation. The audit launched no experimental sessions and made no production guidance changes.

## Approved follow-up

After reviewing these findings, the user approved targeted guidance changes. The controller now
encourages bounded batches of known work, preserves judgment and authorization boundaries, and
allows complete files when needed and small enough. Runtime instructions and grep descriptions
recommend literal matching; ambiguous-regex diagnostics offer a string-predicate alternative.
Confinement rules and output limits are unchanged. These changes have not been measured in a
model-backed comparison, and the removed evaluator was not restored.
