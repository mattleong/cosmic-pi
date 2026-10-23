import { describe, expect, it } from "@effect/vitest";
import { VimSettingsAdapter } from "../src/manager/settings-adapter.ts";

describe("Vim settings adapter", () => {
  it("clears a cancelled search through the child's own methods and contains their failures", () => {
    const filters: Array<string> = [];
    const child = {
      searchInput: {
        focused: false,
        setValue: () => {
          throw new Error("hostile input");
        },
      },
      applyFilter(this: { readonly filters: Array<string> }, text: string) {
        this.filters.push(text);
      },
      filters,
      render: () => [],
      invalidate: () => undefined,
      handleInput: () => undefined,
    };
    const adapter = new VimSettingsAdapter(child);
    adapter.handleInput("/");
    expect(() => adapter.handleInput("\u001b")).not.toThrow();
    expect(filters).toEqual([""]);
  });
});
