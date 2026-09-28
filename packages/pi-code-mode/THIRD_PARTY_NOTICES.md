# Third-party notices

Parts of `src/engine/` are derived from the MIT-licensed `@opencode-ai/codemode` package
(`packages/codemode`) in the OpenCode repository (<https://github.com/anomalyco/opencode>,
`dev` branch, base commit `d4704347465c1ee63d0c213ed00e648e7f0231c5`, with selective later
references to commits `0ac458b3b36f4d17fe3322fd9fab673066ea6297` and
`90112f52db59a8f2ec412c66c6677193bf5dc7b8`):

- `tool.ts`: tool definitions, `ToolError`, and host normalization.
- `tool-schema.ts`: TypeScript signature rendering and input/output decoding.
- `tool-tree.ts`: tool tree validation, path resolution and suggestions.
- `tool-search.ts`: the `tools.$codemode.search` discovery tool.
- `instructions.ts`: the budgeted catalog.
- `dispatch.ts`: call admission and lifecycle.
- `output.ts`: output bounding.

Earlier versions of this package vendored that project's JavaScript interpreter. Programs now
run in Node.js, and the interpreter was removed. The upstream license notice is reproduced in
full below, as required by the MIT license.

---

MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
