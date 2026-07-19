import { describe, expect, test, vi } from "vitest";
import {
  CLEAR_MODEL_OPTION,
  createAdvisorModelChoices,
  selectAdvisorModel,
} from "../src/model-picker.ts";

const secretProvider = "provider-api_key=sk-abcdefghijklmnop";
const secretModel = `model-token=secret-value-${"x".repeat(400)}`;
const models = [
  {
    provider: secretProvider,
    id: secretModel,
    name: "Display Authorization: Bearer abc.def.ghi",
    reasoning: false,
  },
] as never;

describe("advisor model picker", () => {
  test("redacts visible labels while retaining raw values for TUI selection", () => {
    const choices = createAdvisorModelChoices(models, {
      provider: secretProvider,
      model: secretModel,
    });
    const renderedLabels = JSON.stringify(
      choices.map((choice) => ({
        label: choice.item.label,
        description: choice.item.description,
        searchText: choice.searchText,
      })),
    );

    expect(choices[0]?.rawValue).toBe(`${secretProvider}/${secretModel}`);
    expect(choices[0]?.item.value).toBe(`${secretProvider}/${secretModel}`);
    expect(renderedLabels).toContain("REDACTED");
    expect(renderedLabels).not.toMatch(/sk-abcdefghijklmnop|secret-value|abc\.def\.ghi/);
    expect(choices[0]?.item.label.length).toBeLessThanOrEqual(276);
  });

  test("maps redacted non-TUI options back to the raw model value", async () => {
    const select = vi.fn(async (_title: string, options: string[]) => {
      expect(JSON.stringify(options)).not.toMatch(/sk-abcdefghijklmnop|secret-value/);
      expect(options.at(-1)).toBe(CLEAR_MODEL_OPTION);
      return options[0]!;
    });
    const selected = await selectAdvisorModel(
      {
        mode: "headless",
        ui: { select },
      } as never,
      models,
      { provider: undefined, model: undefined },
    );

    expect(selected).toBe(`${secretProvider}/${secretModel}`);
  });
});
